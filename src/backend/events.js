// ─────────────────────────────────────────────────────────────────────────────
// FILE: backend/events.js
// PURPOSE: Fires automatically when any of the following happen, and issues a
// fiscal e-receipt via eparagony.pl REST API for each:
//   1. A classic Wix Pricing Plan order is purchased/paid
//   2. A Wix Bookings single-session class is booked and PAID DIRECTLY
//      (not redeemed with an existing Plan credit)
//   3. (NEW) A Pricing Plan is purchased via the new Wix eCommerce-backed
//      order flow — see the big comment block above the two wixEcom_* handlers
//      below for why this was added and what remains unconfirmed about it.
//
// CONFIRMED FROM OFFICIAL eparagony.pl OpenAPI SPEC (documents_en_v3.yaml):
//   Auth:     POST https://login.eparagony.pl/auth/token  (OAuth2 client_credentials)
//   Receipt:  POST https://api.eparagony.pl/documents
//   Amounts:  ALL amounts are INTEGER in "grosze" (Polish cents) — NOT decimal
//             e.g. 125.00 PLN → 12500
//   VAT:      Letter codes A=23%, B=8%, C=5% (confirmed matches ekasaonline.pl dashboard)
//   Webhook:  eparagony.pl POSTs to statusUrl when receipt is CONFIRMED
//
// CONFIRMED FROM LIVE TESTING (wixBookings_onBookingConfirmed):
//   Direct-paid booking → NO booking.paymentDetails.pricingPlanDetails field
//   Plan-redeemed booking → booking.paymentDetails.pricingPlanDetails EXISTS
//   This is how we tell the two apart and avoid double-issuing receipts for
//   money that was already receipted when the Plan itself was purchased.
//
// NEW THIS REVISION (bug: Pricing Plan purchases via the Bookings "Payment
// Options" modal stopped generating receipts around Sep 19-20, 2026):
//   a) Every event now writes an audit row to ReceiptEventLog — success,
//      skip, or error — so nothing that happens here is invisible in the CMS.
//   b) issueEparagonyReceipt() now dedups by wixTxId OR submissionId, so the
//      same physical purchase can't be double-receipted if it reaches this
//      file via two different order IDs (old Pricing Plans order vs new
//      eCommerce order for what is really the same purchase). This is on
//      top of (not instead of) eparagony's own Idempotency-Key protection.
//   c) wixPricingPlans_onOrderPurchased now falls back to the REST-documented
//      pricing.prices[0].price.{total,currency} shape if priceDetails is
//      absent on the live event payload.
//   d) TWO listeners cover the new eCommerce-backed Pricing Plan path
//      (wixEcom_onOrderApproved, wixEcom_onOrderPaymentStatusUpdated) —
//      classic events.js magic-name exports. A third form (the @wix/ecom
//      SDK's orders.onOrderApproved/onOrderPaymentStatusUpdated registration)
//      was tried and removed after live testing confirmed twice it never
//      fires on this site — only the classic magic-name exports do.
//   e) FIXED a duplicate-receipt race condition (confirmed live Sep 28, 2026
//      on two real test orders): the dedup in (b) was a query-then-write
//      check with no atomicity, so two listeners firing milliseconds apart
//      for the same purchase could both pass it and both issue a real fiscal
//      receipt. issueEparagonyReceipt() now claims an atomic lock (new
//      ReceiptLocks collection, keyed by submissionId as the item's own
//      _id) BEFORE doing anything else — see claimSubmission()/releaseClaim()
//      below for how.
//
// NOV 2026 REVISION (client report of 14 Nov 2026 — October reconciliation):
//   f) UNPAID back-office bookings were being receipted. Staff-added bookings
//      (order channel BACKOFFICE_MERCHANT, paymentStatus NOT_PAID, e.g. 125 PLN)
//      got a receipt for the full nominal price from order #30004 (15 Oct)
//      onward. Cause: wixBookings_onBookingConfirmed never looked at payment
//      status — it issued whenever the booking carried a price. (Nothing was
//      deployed in that window: from ~15 Oct Wix simply started delivering this
//      event for back-office bookings; before that no event row exists at all.)
//      Rule now, for every path: a receipt is issued ONLY when the payment is
//      PAID *and* the amount paid is > 0, for the amount actually paid.
//        - wixBookings_onBookingConfirmed now requires an affirmative PAID.
//        - NEW: bookings are also receipted from the eCommerce order events
//          (see handleNonPlanOrder). Wix's docs say a booking's status follows
//          the paymentStatus of its eCommerce order, so wixEcom_onOrder-
//          PaymentStatusUpdated is what fires when staff mark an unpaid
//          booking as paid later (in-studio card terminal) — that case needs
//          an order-level trigger because onBookingConfirmed fires only once.
//          Both paths use the booking id as submissionId, so ReceiptLocks keeps
//          them from double-issuing.
//        - Plan-credit bookings are PAID with total 0.00 / paid 0 (verified on
//          live orders, paymentOption MEMBERSHIP) so "paid > 0" keeps them
//          receipt-free, exactly like the existing plan-credit skip.
//   g) Order #29630 (VOYAGOLD 800 PLN) was receipted for 0.00: the classic
//      wixPricingPlans_onOrderPurchased event fired before Wix had settled the
//      price, the 0.00 receipt won the ReceiptLocks race, and the (correct) 800
//      from the eCommerce listeners was then blocked as DUPLICATE. Now a zero
//      amount is never receipted (guard in the classic handler + a central
//      guard in issueEparagonyReceipt), so the settled eCommerce listeners win.
//   h) NEW: Pay Link orders (line item itemType.custom === 'PAYLINK_ITEM', no
//      catalogReference) were invisible to every handler. They are now receipted
//      from the eCommerce order events once PAID (orderType 'PAYLINK').
//      eGift Cards (itemType.preset GIFT_CARD) are explicitly excluded — the
//      gift card section is being rebuilt, see isGiftCardLine().
//   i) LOGGING (why f–h went unnoticed for a month): ReceiptEventLog recorded
//      every event but a wrong receipt looked like a success — "RECEIPT_ISSUED"
//      with a blank payment status. Now every row written by
//      issueEparagonyReceipt() carries paymentStatus plus a small payloadJson
//      (order number, channel, amount paid, order total, payment option), so
//      "receipt issued but not PAID" is filterable in the CMS. Skip rows carry
//      paymentStatus too. New outcome UNHANDLED = money was collected (PAID,
//      amount paid > 0) but the order is something this code can't receipt
//      (unknown order shape, multi-booking order): no receipt was issued and a
//      human needs to look. SKIPPED now only means "expected, nothing to do".
//      One behaviour change: DUPLICATE rows used to put the eparagony receipt
//      status in paymentStatus; that now lives in payloadJson.receiptStatus.
//   j) receiptReconcile.js (separate file, scheduled hourly in jobs.config)
//      compares Wix's paid orders with EparagonyReceipts in both directions and
//      emails any new mismatch. Detect-and-report only; see that file.
// ─────────────────────────────────────────────────────────────────────────────

import { contacts } from 'wix-crm-backend';
import { getSecret } from 'wix-secrets-backend';
import wixData from 'wix-data';

// ─── Helper: Get OAuth2 access token ──────────────────────────────────────────
async function getEparagonyToken() {
  const clientId     = await getSecret('eparagony_client_id');
  const clientSecret = await getSecret('eparagony_client_secret');

  const res = await fetch('https://login.eparagony.pl/auth/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Api-Version': '3',
      'User-Agent': 'VoyaformWixIntegration/1.0 (+https://www.voyaform.com)'
    },
    body: new URLSearchParams({
      grant_type:    'client_credentials',
      client_id:     clientId,
      client_secret: clientSecret,
      scope:         'document_create'
    }).toString()
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error('eparagony auth failed:', res.status, errText);
    throw new Error('eparagony authentication failed');
  }

  /** @type {any} */
  const data = await res.json();
  return data.access_token;
}

// ─── Helper: Convert decimal PLN amount to grosze (integer cents) ────────────
// eparagony requires ALL amounts as integers in "grosze" (1 PLN = 100 grosze)
function toGrosze(decimalAmount) {
  return Math.round(parseFloat(decimalAmount) * 100);
}

// ─────────────────────────────────────────────────────────────────────────────
// NEW: logReceiptEvent — writes one audit row to ReceiptEventLog for every
// event this file receives, whether or not it results in a receipt. This is
// how a missing-receipt case like this one becomes visible in the CMS next
// time instead of only being discoverable by cross-referencing orders by hand.
// Never throws — logging failures must not break the real flow.
// ─────────────────────────────────────────────────────────────────────────────
async function logReceiptEvent(entry) {
  try {
    await wixData.insert('ReceiptEventLog', {
      eventName:     entry.eventName || '',
      receivedAt:    new Date().toISOString(),
      // RECEIPT_ISSUED | SKIPPED (expected: unpaid, plan credit, gift card, ...)
      // | UNHANDLED (money was collected but the code doesn't know how to
      // receipt this order — needs a human) | DUPLICATE | ERROR
      // The hourly job in receiptReconcile.js adds RECON_RUN | RECON_MISMATCH |
      // RECON_ALERTED rows to this same collection.
      outcome:       entry.outcome || '',
      reason:        entry.reason || '',
      orderId:       entry.orderId || '',
      wixTxId:       entry.wixTxId || '',
      contactId:     entry.contactId || '',
      itemName:      entry.itemName || '',
      amount:        entry.amount != null ? String(entry.amount) : '',
      currency:      entry.currency || '',
      submissionId:  entry.submissionId || '',
      appId:         entry.appId || '',
      paymentStatus: entry.paymentStatus || '',
      receiptIssued: !!entry.receiptIssued,
      payloadJson:   entry.payloadJson ? JSON.stringify(entry.payloadJson).slice(0, 9000) : ''
    }, { suppressAuth: true });
  } catch (err) {
    console.error('logReceiptEvent failed (non-fatal):', err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// NEW: alreadyIssued — cross-path dedup check. Looks up EparagonyReceipts by
// wixTxId first (original protection), then by submissionId (new — catches
// the case where the SAME purchase reaches issueEparagonyReceipt() twice
// under two different order IDs, e.g. once as a classic Pricing Plans order
// and once as the new eCommerce order Wix now also fires for it).
// ─────────────────────────────────────────────────────────────────────────────
async function alreadyIssued({ wixTxId, submissionId }) {
  try {
    if (wixTxId) {
      const byTx = await wixData.query('EparagonyReceipts').eq('wixTxId', wixTxId).find({ suppressAuth: true });
      if (byTx.items.length > 0) return byTx.items[0];
    }
    if (submissionId) {
      const bySub = await wixData.query('EparagonyReceipts').eq('submissionId', submissionId).find({ suppressAuth: true });
      if (bySub.items.length > 0) return bySub.items[0];
    }
  } catch (err) {
    console.error('alreadyIssued check failed (continuing anyway):', err);
    // Non-fatal — worst case eparagony's own Idempotency-Key still prevents
    // a duplicate FISCAL receipt; we just proceed rather than silently drop it.
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// NEW: claimSubmission / releaseClaim — ATOMIC dedup lock.
//
// WHY alreadyIssued() alone isn't enough: it's a query-then-write check with
// no atomicity. CONFIRMED LIVE THIS SESSION (Sep 28, 2026, two separate real
// test orders) that when two listeners fire within milliseconds of each
// other for the SAME submissionId, both can query EparagonyReceipts, both
// find nothing yet, and both go on to issue a real fiscal receipt — two
// receipts for one purchase. The recurring eparagony HTTP 422 seen on
// wixEcom_onOrderApproved is the same race from the other side: two
// near-simultaneous calls reuse the same wixTxId as the Idempotency-Key, and
// eparagony rejects the loser with 422 instead of replaying the winner's
// response.
//
// Fix: claim the submissionId FIRST, before doing anything else, by
// inserting it as a ReceiptLocks item using submissionId as the item's own
// _id. Wix Data enforces _id uniqueness natively (no custom unique index
// needed), and insert() is a single atomic write, so exactly one concurrent
// caller can ever win the insert for a given _id. That closes the race
// window the old query-then-write alreadyIssued() check left open.
//
// A claim is only released (so a legitimate later retry isn't permanently
// blocked) when this attempt did NOT end in a real receipt being issued —
// no email found, non-PLN, or an eparagony API error. A successful
// RECEIPT_ISSUED claim is left in place for good, as a second layer of
// protection alongside the EparagonyReceipts record itself.
// ─────────────────────────────────────────────────────────────────────────────
async function claimSubmission(submissionId) {
  if (!submissionId) return true; // nothing to key the lock on — don't block the flow
  try {
    await wixData.insert('ReceiptLocks', {
      _id: submissionId,
      claimedAt: new Date().toISOString()
    }, { suppressAuth: true });
    return true; // we won the claim
  } catch (err) {
    // insert() fails when an item with this _id already exists — i.e.
    // someone else (possibly milliseconds ago) already claimed it.
    console.log('claimSubmission: lock already held for', submissionId, err?.message || err);
    return false;
  }
}

async function releaseClaim(submissionId) {
  if (!submissionId) return;
  try {
    await wixData.remove('ReceiptLocks', submissionId, { suppressAuth: true });
  } catch (err) {
    // Non-fatal — worst case this submissionId stays locked until cleared
    // manually, which only blocks a RETRY, never the original receipt.
    console.error('releaseClaim failed (non-fatal):', submissionId, err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SHARED: issueEparagonyReceipt
// Called by ALL event handlers below since the eparagony receipt issuance
// logic is identical regardless of what was bought or which Wix event fired.
//
// Params:
//   wixTxId      → unique ID for this transaction (order ID or booking ID)
//   itemName     → what's on the receipt line (plan name or class name)
//   amount       → decimal string, e.g. "125.00"
//   currency     → e.g. "PLN"
//   contactId    → Wix CRM contact ID, used to fetch email + save on the record
//   orderType    → 'PLAN' | 'BOOKING' | 'ECOM_PLAN' | 'PAYLINK' — saved for reporting/filtering only
//   submissionId → the order/session id used for cross-path dedup — the same
//                  physical purchase's SHARED key across the classic
//                  Pricing Plans order and its eCommerce twin. Also now used
//                  as the ATOMIC lock key (see claimSubmission above). Pass
//                  the same order/booking id used as wixTxId unless a
//                  handler has a better natural key.
//   eventName    → which handler called this, for ReceiptEventLog rows
//   paymentStatus → the PAYMENT status of the order/booking that triggered this
//                  (e.g. 'PAID'). Written on EVERY log row this function makes,
//                  so "receipt issued but not PAID" can be filtered in the CMS.
//   audit        → small object (order id/number, channel, amount paid, nominal
//                  total, payment option, ...) stored as payloadJson on every
//                  row this function makes. Logging only — never used for logic.
// ─────────────────────────────────────────────────────────────────────────────
async function issueEparagonyReceipt({ wixTxId, itemName, amount, currency, contactId, orderType, submissionId, eventName, paymentStatus, audit }) {
  // One place that fills in the fields every row from this function shares,
  // including the payment context (Nov 2026: the old rows said "issued" with
  // no payment status at all, which is how receipts for unpaid bookings went
  // unnoticed). `extra` can add or override fields for one row.
  const logIssue = (outcome, reason, extra = {}) => logReceiptEvent({
    eventName, outcome, reason,
    orderId: audit?.orderId,
    wixTxId, contactId, itemName, amount, currency, submissionId, orderType,
    paymentStatus,
    payloadJson: { orderType, ...(audit || {}) },
    ...extra
  });

  // ── Never receipt a zero / negative / unreadable amount (Nov 2026) ──────────
  // Checked BEFORE the lock is claimed on purpose: if a handler that saw a
  // not-yet-settled 0.00 (order #29630) claimed the lock, it would block the
  // listener that has the real amount. Skipping here leaves the lock free.
  const amountNumber = parseFloat(amount);
  if (!Number.isFinite(amountNumber) || amountNumber <= 0) {
    console.warn('Amount is not greater than 0 — not issuing a receipt:', { eventName, wixTxId, amount });
    await logIssue('SKIPPED', `amount is not greater than 0 (${amount}) — no receipt issued`);
    return;
  }

  const lockKey = submissionId || wixTxId;

  // ── Atomic duplicate guard (NEW — fixes the race condition confirmed live
  // this session) — claim the lock BEFORE doing anything else, including the
  // alreadyIssued() query below, so two near-simultaneous listeners for the
  // same submissionId can't both pass the check before either has written a
  // record. See claimSubmission() above for how/why this is atomic.
  const wonClaim = await claimSubmission(lockKey);
  if (!wonClaim) {
    // We lost the race — someone else (possibly milliseconds ago) already
    // claimed this submissionId. Look up the existing record for a richer
    // log line, but a miss here does NOT mean it's safe to proceed — the
    // other caller may still be mid-flight (e.g. waiting on eparagony's
    // response). The lock itself is the source of truth.
    const existingRecord = await alreadyIssued({ wixTxId, submissionId });
    // paymentStatus on this row is now the ORDER's payment status like every
    // other row; the eparagony receipt status that used to be written here
    // (PENDING / CONFIRMED) is in the reason text and in payloadJson.
    await logIssue('DUPLICATE',
      existingRecord
        ? `already issued as EparagonyReceipts record ${existingRecord._id} (status ${existingRecord.status})`
        : 'lock already held by a concurrent request for this submissionId (receipt likely mid-flight)',
      { payloadJson: { orderType, ...(audit || {}), receiptStatus: existingRecord?.status } });
    return;
  }

  // ── Secondary safety net: same lookup as before the fix, kept in case a
  // receipt for this wixTxId/submissionId already exists under a lock key
  // shape from before ReceiptLocks existed. Very unlikely to trigger
  // post-fix, but costs nothing to keep.
  const existing = await alreadyIssued({ wixTxId, submissionId });
  if (existing) {
    console.log('Receipt already issued for this purchase — skipping duplicate:', { wixTxId, submissionId, existingRecordId: existing._id });
    await logIssue('DUPLICATE',
      `already issued as EparagonyReceipts record ${existing._id} (status ${existing.status})`,
      { payloadJson: { orderType, ...(audit || {}), receiptStatus: existing.status } });
    await releaseClaim(lockKey); // nothing new issued under this claim — free it for any legitimate retry
    return;
  }

  // ── Get buyer email via Contacts API ────────────────────────────────────────
  let email = '';
  try {
    const contact = await contacts.getContact(contactId);
    email = contact.primaryInfo?.email || contact.info?.emails?.[0]?.email || '';
  } catch (err) {
    console.error('Failed to get buyer contact:', err);
  }

  console.log('Issuing receipt:', { orderType, itemName, amount, currency, email, wixTxId, submissionId });

  if (!email) {
    console.warn('No buyer email found — skipping eparagony receipt:', { wixTxId, contactId });
    await logIssue('ERROR', 'no email found for contact');
    await releaseClaim(lockKey); // nothing issued — free the lock so a real retry can succeed later
    return;
  }

  // Only PLN receipts supported by this integration (single VAT config)
  if (currency !== 'PLN') {
    console.warn('Non-PLN order — skipping eparagony receipt:', currency);
    await logIssue('SKIPPED', `non-PLN currency (${currency})`);
    await releaseClaim(lockKey);
    return;
  }

  try {
    const accessToken = await getEparagonyToken();
    const amountGrosze = toGrosze(amount);
    const posId = await getSecret('eparagony_pos_id'); // "voyaplanetspzoo"

    // ── VAT rate: all Voya plans/classes use rate B (8%) per ekasaonline.pl dashboard ──
    const VAT_RATE = 'B';

    const receiptBody = {
      posId: posId,
      statusUrl: 'https://www.voyaform.com/_functions/eparagonyWebhook',
      eReceipt: {
        fiscalize: true,
        metadata: {
          orderId: wixTxId,
          grossSaleValue: amountGrosze,
          currency: currency,
          orderTime: new Date().toISOString(),
          taxRates: {
            A: '23',
            B: '8',
            C: '5',
            D: '0',
            E: 'ZW',
            F: '0',
            G: '0'
          }
        },
        lines: [
          {
            type: 'PRODUCT',
            productOrServiceName: itemName,
            quantity: '1',
            unitPrice: amountGrosze,
            totalLineValue: amountGrosze,
            taxRate: VAT_RATE
          }
        ],
        payment: {
          payments: [
            {
              paymentForm: 'Karta',       // Card payment (via Elavon)
              paymentName: 'Elavon',
              paidThisForm: amountGrosze
            }
          ],
          totalPaid: amountGrosze
        }
      }
    };

    const idempotencyKey = wixTxId; // reuse wixTxId — same order never double-fires

    const receiptRes = await fetch('https://api.eparagony.pl/documents', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
        'X-Api-Version': '3',
        'Idempotency-Key': idempotencyKey,
        'User-Agent': 'VoyaformWixIntegration/1.0 (+https://www.voyaform.com)'
      },
      body: JSON.stringify(receiptBody)
    });

    if (!receiptRes.ok) {
      const errText = await receiptRes.text();
      console.error('eparagony receipt creation failed:', receiptRes.status, errText);
      await logIssue('ERROR', `eparagony HTTP ${receiptRes.status}: ${errText.slice(0, 500)}`);
      await releaseClaim(lockKey); // real failure — free the lock so a retry can succeed later
      return;
    }

    /** @type {any} */
    const receiptData = await receiptRes.json();
    console.log('eparagony receipt created:', {
      documentToken: receiptData.documentToken,
      documentPublicUrl: receiptData.documentPublicUrl
    });

    // ── Save receipt record to Wix Data (CMS) for our own tracking ────────────
    try {
      await wixData.save('EparagonyReceipts', {
        wixTxId:           wixTxId,
        submissionId:      submissionId || '',
        contactId:         contactId,   // reused later to send emails without re-lookup
        planName:          itemName,    // reused field name — holds plan OR class name
        orderType:         orderType,   // 'PLAN' | 'BOOKING' | 'ECOM_PLAN'
        amount:            amount,
        currency:          currency,
        email:             email,
        documentToken:     receiptData.documentToken,
        documentPublicUrl: receiptData.documentPublicUrl,
        status:            'PENDING',   // becomes 'CONFIRMED' via webhook
        issuedAt:          new Date()
      }, { suppressAuth: true });
      console.log('Receipt saved to EparagonyReceipts collection');
    } catch (err) {
      console.error('Failed to save receipt to EparagonyReceipts:', err);
      // Non-fatal — receipt itself was still issued successfully
    }

    // Note: receipt is not yet CONFIRMED at this point (status 202 = accepted).
    // Final confirmation arrives via the eparagonyWebhook endpoint.

    await logIssue('RECEIPT_ISSUED', '', { receiptIssued: true });
    // Claim intentionally left in place — see claimSubmission() comment above.

  } catch (err) {
    console.error('eparagony receipt issuance error:', err);
    await logIssue('ERROR', String(err?.message || err));
    await releaseClaim(lockKey); // real failure — free the lock so a retry can succeed later
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// EVENT 1: wixPricingPlans_onOrderPurchased
// Fires when a member successfully purchases (pays for) a CLASSIC Pricing
// Plan order. Confirmed field paths (from live testing):
//   event.data.order.planName              → plan name
//   event.data.order.priceDetails.total     → amount (decimal string, e.g. "125.00")
//   event.data.order.priceDetails.currency  → currency (e.g. "PLN")
//   event.data.order.buyer.contactId        → used to look up buyer email
//   event.data.order.lastPaymentStatus      → "PAID" when payment succeeded
//
// NEW: falls back to pricing.prices[0].price.{total,currency} — the shape
// documented in the Pricing Plans REST API — if priceDetails is absent, so a
// payload-shape mismatch degrades gracefully (logged as ERROR) instead of
// throwing and silently dropping the receipt.
// ─────────────────────────────────────────────────────────────────────────────
export async function wixPricingPlans_onOrderPurchased(event) {
  const order = event.data.order;

  // Only issue receipts for orders that are actually paid
  if (order.lastPaymentStatus !== 'PAID') {
    console.log('Plan order not paid yet — skipping receipt:', order.lastPaymentStatus);
    await logReceiptEvent({
      eventName: 'wixPricingPlans_onOrderPurchased', outcome: 'SKIPPED',
      reason: `lastPaymentStatus=${order.lastPaymentStatus}`,
      orderId: order._id, contactId: order.buyer?.contactId, itemName: order.planName
    });
    return;
  }

  const amount   = order.priceDetails?.total    ?? order.pricing?.prices?.[0]?.price?.total;
  const currency = order.priceDetails?.currency ?? order.pricing?.prices?.[0]?.price?.currency;

  if (amount == null || currency == null) {
    console.error('wixPricingPlans_onOrderPurchased: could not read amount/currency from either known shape', order);
    await logReceiptEvent({
      eventName: 'wixPricingPlans_onOrderPurchased', outcome: 'ERROR',
      reason: 'could not read amount/currency from priceDetails or pricing.prices[0].price',
      orderId: order._id, contactId: order.buyer?.contactId, itemName: order.planName,
      payloadJson: order
    });
    return;
  }

  // ── Zero-amount guard (Nov 2026, order #29630) ─────────────────────────────
  // This classic event can fire before Wix has settled the plan order's price:
  // for #29630 (VOYAGOLD, 800 PLN) it reported 0.00, won the ReceiptLocks race
  // and produced a 0.00 receipt, while the eCommerce listeners — which read the
  // settled order and computed the right 800.00 — were blocked as DUPLICATE.
  // Not a deterministic bug (the other recent plan orders were all correct), so
  // the fix is to stand down on a zero here and let wixEcom_onOrderApproved /
  // wixEcom_onOrderPaymentStatusUpdated, which fire for the same purchase
  // moments later, issue the receipt. No lock is claimed on this path.
  if (!(parseFloat(amount) > 0)) {
    console.warn('wixPricingPlans_onOrderPurchased: amount is not > 0 — leaving receipt to the eCommerce order listeners:', amount);
    await logReceiptEvent({
      eventName: 'wixPricingPlans_onOrderPurchased', outcome: 'SKIPPED',
      reason: `amount on classic plan event is ${amount} (not settled yet?) — not receipted here; the eCommerce order listeners issue it from the settled order`,
      orderId: order._id, contactId: order.buyer?.contactId, itemName: order.planName,
      amount, currency
    });
    return;
  }

  // CONFIRMED live (Sep 28, 2026 test order pull): order.formData.submissionId
  // is the SAME value as catalogReference.options.planOptions.submissionId on
  // the corresponding eCommerce order for this same purchase — this is the
  // real shared key across both paths, not the order id (which differs
  // between the two). Falls back to order._id for offline/admin orders,
  // which have no formData at all.
  await issueEparagonyReceipt({
    wixTxId:      order._id,
    itemName:     order.planName,
    amount,
    currency,
    contactId:    order.buyer.contactId,
    orderType:    'PLAN',
    submissionId: order.formData?.submissionId || order._id,
    eventName:    'wixPricingPlans_onOrderPurchased',
    paymentStatus: order.lastPaymentStatus,
    audit:        { orderId: order._id, source: 'classic-plan', planOrderTotal: amount, orderType: order.type }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// EVENT 2: wixBookings_onBookingConfirmed
// Fires when ANY booking is confirmed — this includes:
//   a) Direct-paid single sessions (real new money — NEEDS a receipt)
//   b) Bookings redeemed using an existing Plan credit (already receipted
//      when the Plan itself was purchased — must SKIP to avoid double receipt)
//
// CONFIRMED distinguishing field (from live testing):
//   booking.paymentDetails.pricingPlanDetails
//     → EXISTS  → paid via Plan credit → SKIP
//     → MISSING → paid directly (real money) → ISSUE RECEIPT
//
// Confirmed field paths for direct-paid bookings:
//   booking.status                                    → "CONFIRMED"
//   booking.bookedEntity.singleSession.title           → class name
//   booking.paymentDetails.balance.finalPrice.amount    → "250.00"
//   booking.paymentDetails.balance.finalPrice.currency  → "PLN"
//   booking.formInfo.contactDetails.email               → buyer email
//   booking.formInfo.contactDetails.contactId           → contact ID
// ─────────────────────────────────────────────────────────────────────────────
export async function wixBookings_onBookingConfirmed(event) {
  const booking = event.booking;

  if (booking.status !== 'CONFIRMED') {
    console.log('Booking not confirmed — skipping:', booking.status);
    await logReceiptEvent({
      eventName: 'wixBookings_onBookingConfirmed', outcome: 'SKIPPED',
      reason: `booking.status=${booking.status}`, orderId: booking._id,
      contactId: booking.formInfo?.contactDetails?.contactId,
      itemName: booking.bookedEntity?.singleSession?.title,
      paymentStatus: booking.paymentStatus || '',
      payloadJson: bookingAudit(booking)
    });
    return;
  }

  // ── Skip if this booking was paid using an existing Plan credit ────────────
  // That money was already receipted when the Plan was purchased — issuing
  // another receipt here would double-charge Bartosz's fiscal records.
  if (booking.paymentDetails?.pricingPlanDetails) {
    console.log('Booking paid via Plan credit — skipping receipt (already receipted at Plan purchase):',
      booking.paymentDetails.pricingPlanDetails.planName);
    await logReceiptEvent({
      eventName: 'wixBookings_onBookingConfirmed', outcome: 'SKIPPED',
      reason: 'paid via plan credit — already receipted at plan purchase',
      orderId: booking._id, contactId: booking.formInfo?.contactDetails?.contactId,
      itemName: booking.bookedEntity?.singleSession?.title,
      paymentStatus: booking.paymentStatus || '',
      payloadJson: bookingAudit(booking)
    });
    return;
  }

  // ── Payment gate (Nov 2026) ─────────────────────────────────────────────────
  // finalPrice below is the NOMINAL price, not what was paid: staff-added
  // back-office bookings carry 125/250/375/500 PLN while paymentStatus is
  // NOT_PAID, and used to be receipted for that full amount. Only an
  // affirmative PAID passes. Anything else — NOT_PAID, EXEMPT (plan credit),
  // or a payload with no payment status at all — is skipped WITHOUT claiming
  // the ReceiptLocks entry, so the booking can still be receipted later by
  // wixEcom_onOrderPaymentStatusUpdated when it is actually paid (that
  // listener is the authoritative path for bookings; see handleNonPlanOrder).
  // Whatever status we find, the payment-related part of the payload is logged
  // so the real field names on this event are visible in ReceiptEventLog.
  const bookingPaymentStatus = booking.paymentStatus || booking.paymentDetails?.paymentStatus || '';
  if (bookingPaymentStatus !== 'PAID') {
    console.log('Booking is not PAID — skipping receipt here:', bookingPaymentStatus || '(no status on payload)');
    await logReceiptEvent({
      eventName: 'wixBookings_onBookingConfirmed', outcome: 'SKIPPED',
      reason: bookingPaymentStatus
        ? `booking paymentStatus=${bookingPaymentStatus} — receipts are only issued for PAID bookings`
        : 'no paymentStatus on booking event — receipt left to the eCommerce order listeners, which issue it once the order is PAID',
      orderId: booking._id, contactId: booking.formInfo?.contactDetails?.contactId,
      itemName: booking.bookedEntity?.singleSession?.title,
      paymentStatus: bookingPaymentStatus,
      // Full payment part of the payload on purpose — this is the row that
      // shows which fields the event really carries (see comment above).
      payloadJson: {
        ...bookingAudit(booking),
        paymentDetails: booking.paymentDetails
      }
    });
    return;
  }

  const finalPrice = booking.paymentDetails?.balance?.finalPrice;
  if (!finalPrice) {
    console.warn('Booking has no direct payment amount — skipping receipt');
    await logReceiptEvent({
      eventName: 'wixBookings_onBookingConfirmed', outcome: 'SKIPPED',
      reason: 'no paymentDetails.balance.finalPrice on booking',
      orderId: booking._id, contactId: booking.formInfo?.contactDetails?.contactId,
      itemName: booking.bookedEntity?.singleSession?.title,
      paymentStatus: bookingPaymentStatus,
      payloadJson: bookingAudit(booking)
    });
    return;
  }

  await issueEparagonyReceipt({
    wixTxId:      booking._id,
    itemName:     booking.bookedEntity?.singleSession?.title || 'Class Booking',
    amount:       finalPrice.amount,
    currency:     finalPrice.currency,
    contactId:    booking.formInfo?.contactDetails?.contactId,
    orderType:    'BOOKING',
    submissionId: booking._id,
    eventName:    'wixBookings_onBookingConfirmed',
    paymentStatus: bookingPaymentStatus,
    audit:        bookingAudit(booking)
  });
}

// Small, PII-free summary of a booking event for the log's payloadJson.
// (Logging only — no logic reads it.)
function bookingAudit(booking) {
  return {
    orderId: booking._id,
    source: 'bookings-event',
    bookingStatus: booking.status,
    paymentStatus: booking.paymentStatus || booking.paymentDetails?.paymentStatus,
    selectedPaymentOption: booking.selectedPaymentOption,
    nominalPrice: booking.paymentDetails?.balance?.finalPrice?.amount,
    usedPlanCredit: !!booking.paymentDetails?.pricingPlanDetails
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// NEW: eCommerce-backed Pricing Plan order events.
//
// ROOT CAUSE — CONFIRMED LIVE THIS SESSION (Sep 28, 2026), not just
// hypothesized:
//   - Every classic Pricing Plans order (GET pricing-plans/v2/orders) now
//     carries an "onEcom" boolean. Pulled the order history and found the
//     exact transition: the last onEcom:false PAID order was created
//     2026-09-18T08:58:52Z; the first onEcom:true PAID order was created
//     2026-09-20T10:33:57Z. Every PAID order since then (13/13 checked,
//     spanning Sep 20–28, amounts 100–800 PLN) has onEcom:true.
//   - Queried EparagonyReceipts by wixTxId for all 13 of those onEcom:true
//     orders: ZERO have a receipt record. As a sanity check, the 3 most
//     recent onEcom:false PAID orders (Sep 15–18) ALL have a CONFIRMED
//     EparagonyReceipts record. So the break lines up exactly with onEcom
//     flipping to true — it is not a broader receipts outage.
//   - Pulled the actual eCommerce order counterpart for one onEcom:true
//     purchase (same buyer, same amount, same timestamp as its Pricing
//     Plans order) and confirmed its Plan line item's catalogReference:
//       appId: "1522827f-c56c-a5c9-2ac9-00f9e6ae12d3"   (Pricing Plans' app id
//                                                          — previously only
//                                                          seen from a lower-
//                                                          trust Wix Assistant
//                                                          answer; now CONFIRMED
//                                                          against a real order)
//       options.type: "PLAN"
//       options.planOptions.submissionId: "<same value as the classic order's
//                                            formData.submissionId>"
//     That last point matters: the SAME submissionId appears on both the
//     classic Pricing Plans order and its eCommerce counterpart for the same
//     purchase, which is why issueEparagonyReceipt()'s dedup uses
//     order.formData?.submissionId (classic) / catalogReference.options.
//     planOptions.submissionId (eCommerce) as the real shared key across
//     both paths — not the order id, which differs between them.
//   - Conclusion: since ~Sep 19-20, 2026, every paid Pricing Plan purchase
//     (not just ones through the Bookings "Payment Options" modal — need
//     Bartosz to confirm scope, but the pattern looks site-wide) produces an
//     eCommerce order alongside the classic one, and wixPricingPlans_onOrderPurchased
//     is no longer enough on its own. Whether the classic event still fires
//     at all for these orders (and something else fails) or Wix stopped
//     firing it entirely is not yet provable from data alone — the
//     ReceiptEventLog logging added this revision will show which, on the
//     next real purchase.
//
// RESOLVED (was previously flagged per standing project instruction as
// confirmed-vs-guessed; now settled by live data, not just docs):
// The two listeners below (wixEcom_onOrderApproved,
// wixEcom_onOrderPaymentStatusUpdated — classic events.js magic-name exports)
// were originally an INFERRED guess, since no Wix doc was ever found showing
// this magic-name convention applied to these two eCommerce webhooks (every
// doc example instead showed the `import { orders } from '@wix/ecom';
// orders.onOrderApproved(cb)` SDK-registration form). CONFIRMED LIVE THIS
// SESSION (Sep 28, 2026, two separate real test purchases, checked via
// ReceiptEventLog) that the guess was right: both classic magic-name exports
// fire reliably, and the SDK-registration form never fires at all on this
// site — so it was removed (see the note where it used to be, above the two
// listeners below).
//
// Detection of plan line items: uses BOTH the confirmed Pricing Plans appId
// AND options.type === 'PLAN', so a false match from some other app that
// happens to also use options.type:"PLAN" is not possible.
// ─────────────────────────────────────────────────────────────────────────────

const PRICING_PLANS_APP_ID = '1522827f-c56c-a5c9-2ac9-00f9e6ae12d3'; // confirmed live, see comment above

function planLineItems(order) {
  return (order.lineItems || []).filter(li =>
    li.catalogReference?.appId === PRICING_PLANS_APP_ID &&
    li.catalogReference?.options?.type === 'PLAN'
  );
}

function planSubmissionId(planItems, order) {
  return planItems[0]?.catalogReference?.options?.planOptions?.submissionId || order._id;
}

function ecomOrderAmountCurrency(order) {
  const amount   = order.priceSummary?.total?.amount   ?? order.priceSummary?.totalPrice?.amount;
  const currency = order.priceSummary?.total?.currency ?? order.priceSummary?.totalPrice?.currency ?? order.currency;
  return { amount, currency };
}

function ecomPlanItemName(planItems) {
  return planItems
    .map(li => li.productName?.original || li.productName?.translated)
    .filter(Boolean)
    .join(', ') || 'Pricing Plan';
}

// ─────────────────────────────────────────────────────────────────────────────
// NEW (Nov 2026): non-plan eCommerce orders — Pay Links and Bookings.
//
// Line-item shapes, all read off LIVE orders on 16 Nov 2026 (not guessed):
//   Pay Link  (#30066 / #30097): itemType {custom:'PAYLINK_ITEM'}, customLineItem
//             true, NO catalogReference key at all.
//   Booking   (#30004, #30789, #30797): itemType {preset:'SERVICE'},
//             catalogReference.appId = Bookings app id, and
//             catalogReference.catalogItemId = the BOOKING's own id (checked:
//             it equals wixTxId/submissionId on the bookings handler's
//             RECEIPT_ISSUED log rows) — so it is the shared dedup key with
//             wixBookings_onBookingConfirmed.
//   eGift Card (#30002): itemType {preset:'GIFT_CARD'}, catalogReference.appId
//             = Gift Cards app id. NOT receipted — client said to leave gift
//             cards alone, they are being rebuilt.
//
// What "paid" looks like on live orders (paymentStatus / balanceSummary.paid):
//   online paid class        PAID      125.00   → receipt
//   back-office, unpaid      NOT_PAID  0.00     → NEVER a receipt (Issue 1)
//   plan-credit booking      PAID      0        → no receipt (paymentOption
//                                                  MEMBERSHIP; already receipted
//                                                  when the plan was bought)
//   back-office entered at 0 PAID      0.00     → no receipt (client workaround)
//   Pay Link, paid           PAID      350.00   → receipt
// So the rule is: paymentStatus === 'PAID' AND amount paid > 0, receipted for
// the amount actually paid (balanceSummary.paid), never the nominal total.
// ─────────────────────────────────────────────────────────────────────────────
const BOOKINGS_APP_ID   = '13d21c63-b5ec-5912-8397-c3a5ddb27a97'; // Wix Bookings, confirmed live
const GIFT_CARDS_APP_ID = 'd80111c5-a0f4-47a8-b63a-65b54d774a27'; // Wix eGift Cards, confirmed live (#30002)

const isPayLinkLine  = li => li.itemType?.custom === 'PAYLINK_ITEM';
const isBookingLine  = li => li.catalogReference?.appId === BOOKINGS_APP_ID;
// Explicit gift-card exclusion (client: "we will rebuild the gift card section
// anyway"). Pay Link detection above can't match a gift card (different
// itemType, and gift cards carry a catalogReference), but gift cards are also
// excluded by name here so a future change to either check can't sweep them in.
const isGiftCardLine = li => li.itemType?.preset === 'GIFT_CARD' || li.catalogReference?.appId === GIFT_CARDS_APP_ID;

function isPaidStatus(status) {
  return status === 'PAID' || status === 'FULLY_PAID';
}

// The amount ACTUALLY PAID on the order, as a 2-decimal string ("125.00").
// Prefers balanceSummary.paid (what was really collected). Falls back to the
// order total only when balanceSummary is missing from the event payload — the
// caller has already required paymentStatus PAID, so total == paid there.
// An explicit paid of "0" is NOT a missing value: it means nothing was
// collected (plan credit / entered at 0 PLN) and correctly yields no receipt.
function ecomPaidAmountCurrency(order) {
  const { amount: total, currency } = ecomOrderAmountCurrency(order);
  const paid = order.balanceSummary?.paid?.amount;
  const raw = (paid !== undefined && paid !== null && paid !== '') ? paid : total;
  const n = parseFloat(raw);
  return { amount: Number.isFinite(n) ? n.toFixed(2) : null, currency };
}

function ecomItemName(items, fallback) {
  return items
    .map(li => li.productName?.original || li.productName?.translated)
    .filter(Boolean)
    .join(', ') || fallback;
}

// Small, PII-free summary of an eCommerce order for the log's payloadJson, so
// every row says WHAT KIND of order it was and HOW MUCH was really paid —
// the facts that were missing when unpaid back-office bookings got receipts.
// (Logging only — no logic reads it.)
function ecomAudit(order) {
  return {
    orderId:       order._id,
    orderNumber:   order.number,
    channel:       order.channelInfo?.type,
    paymentStatus: order.paymentStatus,
    amountPaid:    order.balanceSummary?.paid?.amount,
    orderTotal:    order.priceSummary?.total?.amount ?? order.priceSummary?.totalPrice?.amount,
    paymentOption: order.lineItems?.[0]?.paymentOption
  };
}

// What the order is made of, for the UNHANDLED rows (product names + the
// item type / app id that decide how an order is classified).
function describeLines(lines) {
  return lines.map(li => ({
    name:          li.productName?.original || li.productName?.translated,
    itemType:      li.itemType,
    appId:         li.catalogReference?.appId,
    custom:        li.customLineItem,
    paymentOption: li.paymentOption
  }));
}

// Called by both order listeners for any order with no PLAN line item.
// Logs exactly one ReceiptEventLog row per call. Outcomes:
//   SKIPPED   — expected, nothing to do: gift card, not paid, plan credit /
//               entered at 0 PLN, unpaid orders of a kind we don't handle
//   UNHANDLED — money WAS collected (PAID, amount paid > 0) but this order is
//               something the code can't receipt (a shape it doesn't know, or
//               a multi-booking order): no receipt was issued and someone
//               needs to look. The hourly job in receiptReconcile.js also
//               reports these as "paid, no receipt".
//   ERROR     — couldn't read the amount.
async function handleNonPlanOrder(order, eventName, paymentStatus) {
  const lines     = order.lineItems || [];
  const contactId = order.buyerInfo?.contactId;
  const audit     = ecomAudit(order);
  const logBase   = { eventName, orderId: order._id, contactId, paymentStatus, payloadJson: audit };

  // eGift Cards: explicitly out of scope — never receipted by this branch.
  if (lines.some(isGiftCardLine)) {
    await logReceiptEvent({
      ...logBase, outcome: 'SKIPPED',
      reason: 'eGift Card order — intentionally not receipted (gift card section is being rebuilt)'
    });
    return;
  }

  // Only orders made up ENTIRELY of one kind are handled; mixed carts fall
  // through to the generic skip rather than guessing how to split the amount.
  const payLinkItems = lines.filter(isPayLinkLine);
  const bookingItems = lines.filter(isBookingLine);
  const allPayLink   = payLinkItems.length > 0 && payLinkItems.length === lines.length;
  const allBooking   = bookingItems.length > 0 && bookingItems.length === lines.length;

  if (!allPayLink && !allBooking) {
    // An order shape we don't recognise. If it's unpaid that is just noise
    // (SKIPPED, same text as always); if money was actually collected it is
    // UNHANDLED, so a new kind of paid order can't pass through unnoticed.
    const unknown = ecomPaidAmountCurrency(order);
    const moneyCollected = isPaidStatus(paymentStatus) && parseFloat(unknown.amount) > 0;
    if (moneyCollected) {
      await logReceiptEvent({
        ...logBase, outcome: 'UNHANDLED', amount: unknown.amount, currency: unknown.currency,
        reason: `PAID ${unknown.amount} ${unknown.currency} but the order is not a plan, Pay Link or single booking — no receipt issued, needs a manual look`,
        payloadJson: { ...audit, lines: describeLines(lines) }
      });
    } else {
      await logReceiptEvent({ ...logBase, outcome: 'SKIPPED', reason: 'no PLAN-type line items on this order' });
    }
    return;
  }

  const kind = allPayLink ? 'Pay Link' : 'booking';

  // Payment gate: PAID only. NOT_PAID / PENDING / PARTIALLY_PAID / unknown never
  // get a receipt here; when the order later becomes PAID,
  // wixEcom_onOrderPaymentStatusUpdated brings it back through this function.
  // No lock is claimed on a skip, so that later event is not blocked.
  if (!isPaidStatus(paymentStatus)) {
    await logReceiptEvent({
      ...logBase, outcome: 'SKIPPED',
      reason: `paymentStatus=${paymentStatus || 'unknown'} — ${kind} receipts are only issued once the order is PAID`
    });
    return;
  }

  const { amount, currency } = ecomPaidAmountCurrency(order);
  if (amount == null || currency == null) {
    console.error(`${eventName}: could not read paid amount/currency from order`, order.balanceSummary, order.priceSummary);
    await logReceiptEvent({
      ...logBase, outcome: 'ERROR',
      reason: `could not read paid amount/currency from balanceSummary/priceSummary (${kind} order)`,
      payloadJson: { balanceSummary: order.balanceSummary, priceSummary: order.priceSummary }
    });
    return;
  }

  // PAID but nothing collected: plan-credit booking, or staff entered it at 0 PLAN.
  if (!(parseFloat(amount) > 0)) {
    await logReceiptEvent({
      ...logBase, outcome: 'SKIPPED', amount, currency,
      reason: `PAID but amount paid is ${amount} (plan credit / free / entered at 0) — no receipt for a ${kind} order`
    });
    return;
  }

  if (allPayLink) {
    await issueEparagonyReceipt({
      wixTxId:      order._id,
      itemName:     ecomItemName(payLinkItems, 'Pay Link'),
      amount,
      currency,
      contactId,
      orderType:    'PAYLINK',
      submissionId: order._id,
      eventName,
      paymentStatus,
      audit
    });
    return;
  }

  // Booking order. Orders here hold a single booking; a multi-booking order
  // can't be keyed to one booking id (dedup vs the bookings handler), so it is
  // logged as UNHANDLED (money collected, no receipt) instead of risking a
  // duplicate fiscal receipt.
  if (bookingItems.length > 1) {
    await logReceiptEvent({
      ...logBase, outcome: 'UNHANDLED', amount, currency,
      reason: `order has ${bookingItems.length} booking line items — only single-booking orders are receipted automatically; PAID ${amount} ${currency}, no receipt issued, needs a manual look`,
      payloadJson: { ...audit, lines: describeLines(lines) }
    });
    return;
  }

  const bookingId = bookingItems[0].catalogReference?.catalogItemId || order._id;
  await issueEparagonyReceipt({
    wixTxId:      bookingId,           // same ids the bookings handler uses, so the two
    submissionId: bookingId,           // paths dedup against each other (ReceiptLocks)
    itemName:     'Class Booking',     // same receipt line text the bookings handler has always used
    amount,
    currency,
    contactId,
    orderType:    'BOOKING',
    eventName,
    paymentStatus,
    audit
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared core logic for both eCommerce order events, factored out so the SAME
// code runs no matter which of the two listeners below fires for a given
// order (both do, per live confirmation — see the block above). Every path
// funnels into issueEparagonyReceipt(), whose ATOMIC submissionId lock (see
// claimSubmission() much further up) means it's safe for both to fire for
// the same order — only the one that wins the claim issues a receipt; the
// other logs as DUPLICATE and stops.
// ─────────────────────────────────────────────────────────────────────────────
async function handleApprovedOrderData(order, eventName) {
  if (!order || !order._id) {
    await logReceiptEvent({ eventName, outcome: 'ERROR', reason: 'no order object on event' });
    return;
  }

  const planItems = planLineItems(order);
  if (planItems.length === 0) {
    // Not a plan purchase. Pay Links and Bookings are handled (only when PAID
    // with an amount paid > 0); everything else (e.g. a Stores product, a gift
    // card) is logged as skipped so the event's arrival is still visible.
    await handleNonPlanOrder(order, eventName, order.paymentStatus);
    return;
  }

  // Payment gate for plan orders: the same rule bookings and Pay Links already
  // follow. A plan order that is not PAID gets no receipt from this "approved"
  // event. When it later becomes PAID, wixEcom_onOrderPaymentStatusUpdated brings
  // it back through handlePaymentStatusOrderData (which already requires PAID),
  // and the receipt lock keeps that to one receipt. No lock is claimed on a
  // skip, so that later event is not blocked. A plan order that is ALREADY PAID
  // when approved still gets its receipt right here, as before.
  // (Before this gate an approved-but-unpaid plan order was receipted anyway:
  // orders #30809 and #30821, Nov 2026.)
  if (!isPaidStatus(order.paymentStatus)) {
    await logReceiptEvent({
      eventName, outcome: 'SKIPPED',
      reason: `paymentStatus=${order.paymentStatus || 'unknown'} — plan receipts are only issued once the order is PAID`,
      orderId: order._id, contactId: order.buyerInfo?.contactId,
      itemName: ecomPlanItemName(planItems),
      paymentStatus: order.paymentStatus, payloadJson: ecomAudit(order)
    });
    return;
  }

  const { amount, currency } = ecomOrderAmountCurrency(order);
  if (amount == null || currency == null) {
    console.error(`${eventName}: could not read amount/currency from priceSummary`, order);
    await logReceiptEvent({
      eventName, outcome: 'ERROR',
      reason: 'could not read amount/currency from priceSummary',
      orderId: order._id, contactId: order.buyerInfo?.contactId, payloadJson: order.priceSummary
    });
    return;
  }

  await issueEparagonyReceipt({
    wixTxId:      order._id,
    itemName:     ecomPlanItemName(planItems),
    amount,
    currency,
    contactId:    order.buyerInfo?.contactId,
    orderType:    'ECOM_PLAN',
    submissionId: planSubmissionId(planItems, order),
    eventName,
    paymentStatus: order.paymentStatus,   // PAID here: gated above
    audit:        ecomAudit(order)
  });
}

async function handlePaymentStatusOrderData(order, paymentStatus, eventName) {
  if (!order || !order._id) {
    await logReceiptEvent({ eventName, outcome: 'ERROR', reason: 'no order object on event' });
    return;
  }

  if (paymentStatus !== 'PAID' && paymentStatus !== 'FULLY_PAID') {
    await logReceiptEvent({
      eventName, outcome: 'SKIPPED',
      reason: `paymentStatus=${paymentStatus}`, orderId: order._id,
      contactId: order.buyerInfo?.contactId, paymentStatus
    });
    return;
  }

  const planItems = planLineItems(order);
  if (planItems.length === 0) {
    await handleNonPlanOrder(order, eventName, paymentStatus);
    return;
  }

  const { amount, currency } = ecomOrderAmountCurrency(order);
  if (amount == null || currency == null) {
    console.error(`${eventName}: could not read amount/currency from priceSummary`, order);
    await logReceiptEvent({
      eventName, outcome: 'ERROR',
      reason: 'could not read amount/currency from priceSummary',
      orderId: order._id, contactId: order.buyerInfo?.contactId, paymentStatus
    });
    return;
  }

  await issueEparagonyReceipt({
    wixTxId:      order._id,
    itemName:     ecomPlanItemName(planItems),
    amount,
    currency,
    contactId:    order.buyerInfo?.contactId,
    orderType:    'ECOM_PLAN',
    submissionId: planSubmissionId(planItems, order),
    eventName,
    paymentStatus,
    audit:        ecomAudit(order)
  });
}

// ── Listener #1 (CONFIRMED live): classic events.js magic-name convention ───
export async function wixEcom_onOrderApproved(event) {
  await handleApprovedOrderData(event?.data?.order, 'wixEcom_onOrderApproved');
}

// ── Listener #2 (CONFIRMED live): classic events.js magic-name convention ───
export async function wixEcom_onOrderPaymentStatusUpdated(event) {
  const order = event?.data?.order;
  const paymentStatus = order?.paymentStatus || event?.data?.paymentStatus;
  await handlePaymentStatusOrderData(order, paymentStatus, 'wixEcom_onOrderPaymentStatusUpdated');
}

// ─────────────────────────────────────────────────────────────────────────────
// Listener #3 (@wix/ecom SDK registration form — import { orders } from
// '@wix/ecom'; orders.onOrderApproved(cb)) has been REMOVED. It was the only
// form shown in Wix's own docs for these two webhooks, so it was kept
// alongside the two classic magic-name guesses as a hedge — but checking
// ReceiptEventLog after two separate real test purchases (Sep 28, 2026)
// confirmed it never fired either time. Only the classic magic-name
// listeners below (#1, #2) ever ran. Removed rather than left in as dead
// code; if that ever changes, ReceiptEventLog would simply show new rows
// tagged "(SDK)" again, which is easy to notice.
// ─────────────────────────────────────────────────────────────────────────────