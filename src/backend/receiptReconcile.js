// ─────────────────────────────────────────────────────────────────────────────
// FILE: receiptReconcile.js
// PURPOSE: Hourly safety net for the fiscal receipt flow (added Nov 2026).
//
// WHY: the receipt handlers in events.js log everything they DO, but a log is a
// diary, not an alarm. In Oct 2026 receipts were issued for unpaid back-office
// bookings and nobody saw it until the client's own bookkeeping caught it a
// month later, because every one of those rows said RECEIPT_ISSUED. This job
// compares Wix's own orders with EparagonyReceipts, in both directions, and
// tells someone within the hour (runs at :30 every hour, see jobs.config; the
// look-back window overlaps from run to run, and every problem is emailed ONCE).
//
// WHAT IT CHECKS (orders / receipts changed or issued in the last LOOKBACK_DAYS):
//   PAID_NO_RECEIPT    an order is PAID with an amount paid > 0 (PLN) but no
//                      receipt exists for it
//   RECEIPT_NOT_PAID   a receipt exists but the order is NOT paid / paid 0
//   RECEIPT_REFUNDED   a receipt exists but the order has since been refunded
//                      (a fiscal correction may be needed)
//   AMOUNT_MISMATCH    the receipt amount differs from the amount paid
//   DUPLICATE_RECEIPT  more than one receipt for the same order
// Deliberately NOT flagged: eGift Cards (client said to leave them alone), PAID
// orders with 0 paid (plan credit / entered at 0), non-PLN orders.
//
// IT NEVER ISSUES, CANCELS OR CHANGES A RECEIPT. Detect and report only.
//
// WHERE THE RESULTS GO (no new CMS collection needed — rows go into the
// existing ReceiptEventLog, eventName 'receiptReconciliation'):
//   RECON_RUN       one row EVERY run (hourly): what was checked, what was found.
//                   No row for a couple of hours = the job didn't run — that
//                   absence is the alarm for the alarm.
//   RECON_MISMATCH  one row per problem, the first time it is seen
//                   (wixTxId = "<TYPE>|<orderId>", the dedup key)
//   RECON_ALERTED   written after the alert email for that problem went out, so
//                   each problem is emailed once, not every hour
//   RECON_FAILURE_ALERTED  written after a "the check itself could not run"
//                   email went out; that email is sent at most once per
//                   FAILURE_EMAIL_COOLDOWN_HOURS, so a persistent failure does
//                   not email people every hour (the ERROR rows still do pile up)
//   ERROR           the job (or the email) failed
//
// EMAIL: needs a Triggered Email in the Wix dashboard that does not exist yet —
// see ALERT_EMAIL_TEMPLATE_ID below. Until it exists the job still logs
// everything and records an ERROR row saying the email couldn't be sent; it
// retries the email on every run until it succeeds.
//
// Lives in its own file ON PURPOSE: if anything here breaks (an import, the
// Orders API, the email), the receipt-issuing code in events.js is untouched.
// It is a plain backend .js file, so unlike a .web.js module it is not callable
// from the site's front end. Scheduled in jobs.config.
// ─────────────────────────────────────────────────────────────────────────────

import wixData from 'wix-data';
import { orders } from '@wix/ecom';           // already a dependency in package.json
import { triggeredEmails } from 'wix-crm-backend';
import { elevate } from 'wix-auth';           // same import http-functions.js already uses
// NOTE: wix-auth's elevate() is used for BOTH the Orders search (an SDK call) and
// the triggered email. Verified live on 2026-11-18: the first hourly run read 188
// orders with it, no permissions error. '@wix/essentials' (auth.elevate) is also
// installed on the site but deliberately not imported here, since nothing needs it.

const LOG_COLLECTION      = 'ReceiptEventLog';
const RECEIPTS_COLLECTION = 'EparagonyReceipts';
const EVENT_NAME          = 'receiptReconciliation';

const LOOKBACK_DAYS   = 7;    // how far back each run looks (re-checks are deduped, so overlap is free)
const GRACE_MINUTES   = 30;   // orders touched more recently than this are skipped for PAID_NO_RECEIPT (receipt may be mid-flight)
const ORDERS_PAGE     = 100;
const MAX_ORDER_PAGES = 5;    // up to 500 orders per run; the run says so if it hit the cap
const KEY_CHUNK       = 40;   // ids per hasSome() query
const AMOUNT_TOLERANCE = 0.01;
const MAX_EMAIL_LINES = 15;
const FAILURE_EMAIL_COOLDOWN_HOURS = 24;   // "the check itself could not run" emails: at most one per this many hours

// ─── Alert email ─────────────────────────────────────────────────────────────
// TO SET UP (once, in the Wix dashboard → Triggered Emails): create an email
// whose ID is exactly the value below, with these variables in its body (same
// ${...} style as the existing customer/admin emails). Ready-made HTML:
// "wix git/voyaform/receiptalert.html" (next to mail.html), which wraps
// ${summary} in white-space:pre-line so each problem shows on its own line.
//   ${count}      how many problems this email lists
//   ${windowDays} how many days back the check looks
//   ${summary}    one line per problem (order number, amount, what is wrong)
// The recipient is a CRM contact id — currently the studio's own contact
// (hello@voyaform.com, the same one http-functions.js uses as ADMIN_CONTACT_ID).
// Add more contact ids here to alert more people.
const ALERT_EMAIL_TEMPLATE_ID = 'receiptalert';
// studio (hello@voyaform.com) + dev (faizanalimian@gmail.com, verified in the CRM).
// TODO: add the contact id of usamamehmood443@gmail.com once that contact exists
// in the CRM (there was none when this was written).
const ALERT_CONTACT_IDS = [
  '8940063e-cc85-4fb6-b49b-69e72fd644d4',
  'f3e7d9b7-9495-4d89-9f94-9bef3f170289'
];

// Same ids as events.js (kept as copies on purpose — see header).
const PRICING_PLANS_APP_ID = '1522827f-c56c-a5c9-2ac9-00f9e6ae12d3';
const BOOKINGS_APP_ID      = '13d21c63-b5ec-5912-8397-c3a5ddb27a97';
const GIFT_CARDS_APP_ID    = 'd80111c5-a0f4-47a8-b63a-65b54d774a27';

const isPlanLine     = li => li.catalogReference?.appId === PRICING_PLANS_APP_ID && li.catalogReference?.options?.type === 'PLAN';
const isPayLinkLine  = li => li.itemType?.custom === 'PAYLINK_ITEM';
const isBookingLine  = li => li.catalogReference?.appId === BOOKINGS_APP_ID;
const isGiftCardLine = li => li.itemType?.preset === 'GIFT_CARD' || li.catalogReference?.appId === GIFT_CARDS_APP_ID;

const isPaidStatus   = s => s === 'PAID' || s === 'FULLY_PAID';
const isRefundStatus = s => s === 'REFUNDED' || s === 'FULLY_REFUNDED' || s === 'PARTIALLY_REFUNDED';

const TYPE_LABEL = {
  PAID_NO_RECEIPT:   'Paid, no receipt',
  RECEIPT_NOT_PAID:  'Receipt, but not paid',
  RECEIPT_REFUNDED:  'Receipt, order refunded',
  AMOUNT_MISMATCH:   'Receipt amount differs',
  DUPLICATE_RECEIPT: 'More than one receipt'
};

const chunk = (arr, n) => {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};
const num = v => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : NaN;
};
const money = n => (Number.isFinite(n) ? n.toFixed(2) : '?');

// ─────────────────────────────────────────────────────────────────────────────
// PURE LOGIC (no I/O — this is what the offline tests exercise)
// ─────────────────────────────────────────────────────────────────────────────

// Reduce a Wix order to what the check needs. `keys` are every id a receipt for
// this order could have been filed under in EparagonyReceipts (wixTxId or
// submissionId): the order id, the booking id(s) for bookings (that is the key
// events.js uses so the bookings event and the order events dedup), and the
// plan submissionId for plans (shared with the classic Pricing Plans order).
export function classifyOrder(order) {
  const id    = order._id || order.id;
  const lines = order.lineItems || [];
  const keys  = [id];
  let kind = 'OTHER';

  const planLines = lines.filter(isPlanLine);
  if (planLines.length > 0) {
    kind = 'PLAN';
    keys.push(planLines[0].catalogReference?.options?.planOptions?.submissionId);
  } else if (lines.some(isGiftCardLine)) {
    kind = 'GIFT_CARD';
  } else if (lines.length > 0 && lines.every(isPayLinkLine)) {
    kind = 'PAYLINK';
  } else if (lines.length > 0 && lines.every(isBookingLine)) {
    kind = 'BOOKING';
    for (const li of lines) keys.push(li.catalogReference?.catalogItemId);
  }

  const total   = order.priceSummary?.total?.amount ?? order.priceSummary?.totalPrice?.amount;
  const paidRaw = order.balanceSummary?.paid?.amount;
  const paid    = num((paidRaw !== undefined && paidRaw !== null && paidRaw !== '') ? paidRaw : total);

  return {
    id,
    number:        order.number,
    kind,
    keys:          [...new Set(keys.filter(Boolean))],
    paymentStatus: order.paymentStatus,
    paid,
    total:         num(total),
    currency:      order.currency ?? order.priceSummary?.total?.currency,
    updatedAt:     new Date(order._updatedDate || order.updatedDate || order._createdDate || 0).getTime()
  };
}

// key → unique receipts filed under that key (as wixTxId or submissionId)
export function buildReceiptIndex(receipts) {
  const index = new Map();
  const seen  = new Set();
  for (const r of receipts) {
    if (seen.has(r._id)) continue;
    seen.add(r._id);
    for (const k of [r.wixTxId, r.submissionId]) {
      if (!k) continue;
      if (!index.has(k)) index.set(k, []);
      index.get(k).push(r);
    }
  }
  return index;
}

// classified   → classifyOrder() results for the orders in the window
// receiptIndex → buildReceiptIndex() over receipts found by the orders' keys AND
//                receipts issued in the window
// recentReceipts → receipts issued in the window (direction B starts from these)
// Returns { mismatches, stats }. Every mismatch has a stable `key` for dedup.
export function analyseReconciliation({ classified, receiptIndex, recentReceipts, now = Date.now(), graceMinutes = GRACE_MINUTES }) {
  const mismatches = [];
  const stats = {
    ordersChecked: classified.length, paidOrdersChecked: 0, giftCardsIgnored: 0, nonPlnIgnored: 0,
    tooFreshToJudge: 0, receiptsChecked: recentReceipts.length, receiptsMatchedToOrder: 0, receiptsWithoutOrderInWindow: 0
  };
  const add = (type, o, extra = {}) => mismatches.push({
    type, key: `${type}|${o.id}`, orderId: o.id, orderNumber: o.number, kind: o.kind, ...extra
  });
  const receiptsFor = o => {
    const byId = new Map();
    for (const k of o.keys) for (const r of receiptIndex.get(k) || []) byId.set(r._id, r);
    return [...byId.values()];
  };

  // ── Direction A: paid money with no receipt ────────────────────────────────
  for (const o of classified) {
    if (o.kind === 'GIFT_CARD') { stats.giftCardsIgnored++; continue; }
    if (!isPaidStatus(o.paymentStatus) || !(o.paid > 0)) continue;
    if (o.currency !== 'PLN') { stats.nonPlnIgnored++; continue; }
    if (now - o.updatedAt < graceMinutes * 60 * 1000) { stats.tooFreshToJudge++; continue; }
    stats.paidOrdersChecked++;
    if (receiptsFor(o).length === 0) {
      add('PAID_NO_RECEIPT', o, {
        amount: money(o.paid), currency: o.currency,
        detail: `Order #${o.number} (${o.kind}) is PAID ${money(o.paid)} ${o.currency} but no receipt was found.`
      });
    }
  }

  // ── Direction B: receipt for an order that is not (fully) paid ─────────────
  const orderByKey = new Map();
  for (const o of classified) for (const k of o.keys) if (!orderByKey.has(k)) orderByKey.set(k, o);

  for (const r of recentReceipts) {
    const o = [r.wixTxId, r.submissionId].filter(Boolean).map(k => orderByKey.get(k)).find(Boolean);
    if (!o) { stats.receiptsWithoutOrderInWindow++; continue; }
    stats.receiptsMatchedToOrder++;
    const rAmount = num(r.amount);
    const base = { amount: money(rAmount), currency: r.currency, receiptId: r._id };
    if (isRefundStatus(o.paymentStatus)) {
      add('RECEIPT_REFUNDED', o, { ...base,
        detail: `Order #${o.number} (${o.kind}) has a receipt for ${money(rAmount)} ${r.currency} but the order is now ${o.paymentStatus} — a fiscal correction may be needed.` });
    } else if (!isPaidStatus(o.paymentStatus) || !(o.paid > 0)) {
      add('RECEIPT_NOT_PAID', o, { ...base,
        detail: `Order #${o.number} (${o.kind}) has a receipt for ${money(rAmount)} ${r.currency} but the order is ${o.paymentStatus} with ${money(o.paid)} paid — the receipt may need correcting.` });
    } else if (Number.isFinite(rAmount) && Math.abs(rAmount - o.paid) > AMOUNT_TOLERANCE) {
      add('AMOUNT_MISMATCH', o, { ...base,
        detail: `Order #${o.number} (${o.kind}): receipt is ${money(rAmount)} ${r.currency} but ${money(o.paid)} was paid.` });
    }
  }

  // ── Duplicates: two fiscal receipts for one order ──────────────────────────
  for (const o of classified) {
    const found = receiptsFor(o);
    if (found.length > 1) {
      add('DUPLICATE_RECEIPT', o, {
        detail: `Order #${o.number} (${o.kind}) has ${found.length} receipts (${found.map(r => `${r.amount} ${r.currency}`).join(', ')}).`
      });
    }
  }

  // One mismatch per key, in a stable order
  const unique = [...new Map(mismatches.map(m => [m.key, m])).values()];
  return { mismatches: unique, stats };
}

export function buildEmailSummary(items) {
  const lines = items.slice(0, MAX_EMAIL_LINES).map(m => `• [${TYPE_LABEL[m.type] || m.type}] ${m.detail}`);
  if (items.length > MAX_EMAIL_LINES) {
    lines.push(`…and ${items.length - MAX_EMAIL_LINES} more — see ReceiptEventLog (outcome RECON_MISMATCH).`);
  }
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// I/O
// ─────────────────────────────────────────────────────────────────────────────

// Never throws — a logging failure must not stop the run.
async function writeLog(entry) {
  try {
    await wixData.insert(LOG_COLLECTION, {
      eventName:     EVENT_NAME,
      receivedAt:    new Date().toISOString(),
      outcome:       entry.outcome || '',
      reason:        entry.reason || '',
      orderId:       entry.orderId || '',
      wixTxId:       entry.wixTxId || '',
      contactId:     '',
      itemName:      entry.itemName || '',
      amount:        entry.amount != null ? String(entry.amount) : '',
      currency:      entry.currency || '',
      submissionId:  '',
      appId:         '',
      paymentStatus: entry.paymentStatus || '',
      receiptIssued: false,
      payloadJson:   entry.payloadJson ? JSON.stringify(entry.payloadJson).slice(0, 9000) : ''
    }, { suppressAuth: true });
  } catch (err) {
    console.error('receiptReconcile: could not write ReceiptEventLog row (non-fatal):', err);
  }
}

// Orders changed in the window, newest cursor page by page.
async function fetchRecentOrders(since) {
  // wix-auth's typings only know Velo functions, so the editor mis-infers the type
  // of an elevated SDK function ("await has no effect", "not assignable to
  // HttpClient", "orders does not exist"). It works at runtime (verified live
  // 2026-11-18: 188 orders read), so only the type checker is told to stand down.
  /** @type {any} */
  const elevatedSearchOrders = elevate(orders.searchOrders);
  const all = [];
  let cursor;
  for (let page = 0; page < MAX_ORDER_PAGES; page++) {
    const search = cursor
      ? { cursorPaging: { limit: ORDERS_PAGE, cursor } }
      : { filter: { _updatedDate: { $gte: since.toISOString() } }, cursorPaging: { limit: ORDERS_PAGE } };
    const res = await elevatedSearchOrders(search);
    all.push(...(res.orders || []));
    const meta = res.metadata || res.pagingMetadata;
    cursor = meta?.cursors?.next;
    if (!cursor || meta?.hasNext === false) return { orders: all, truncated: false };
  }
  return { orders: all, truncated: true };
}

async function fetchRecentReceipts(since) {
  const res = await wixData.query(RECEIPTS_COLLECTION).ge('issuedAt', since).limit(1000).find({ suppressAuth: true });
  return res.items;
}

// Receipts filed under any of these ids, as wixTxId or as submissionId.
async function fetchReceiptsByKeys(keys) {
  const found = new Map();
  for (const part of chunk([...new Set(keys)], KEY_CHUNK)) {
    for (const field of ['wixTxId', 'submissionId']) {
      const res = await wixData.query(RECEIPTS_COLLECTION).hasSome(field, part).limit(1000).find({ suppressAuth: true });
      for (const r of res.items) found.set(r._id, r);
    }
  }
  return [...found.values()];
}

// Which mismatch keys already have a RECON_MISMATCH row / a RECON_ALERTED row.
async function fetchKnownKeys(keys) {
  const known = new Set();
  const alerted = new Set();
  for (const part of chunk(keys, KEY_CHUNK)) {
    const res = await wixData.query(LOG_COLLECTION)
      .eq('eventName', EVENT_NAME).hasSome('wixTxId', part).limit(1000).find({ suppressAuth: true });
    for (const row of res.items) {
      if (row.outcome === 'RECON_MISMATCH') known.add(row.wixTxId);
      if (row.outcome === 'RECON_ALERTED')  alerted.add(row.wixTxId);
    }
  }
  return { known, alerted };
}

// For "paid, no receipt": say what the receipt code last did with this order,
// so the email explains WHY (e.g. "ERROR: no email found for contact").
async function lastLogHint(keys) {
  try {
    const rows = [];
    for (const field of ['orderId', 'wixTxId']) {
      const res = await wixData.query(LOG_COLLECTION).hasSome(field, keys).limit(50).find({ suppressAuth: true });
      rows.push(...res.items);
    }
    const last = rows
      .filter(r => r.eventName !== EVENT_NAME)
      .sort((a, b) => String(b.receivedAt).localeCompare(String(a.receivedAt)))[0];
    if (!last) return ' The receipt code has no log entry for this order — its event may never have arrived.';
    return ` Last log: ${last.eventName} → ${last.outcome}${last.reason ? ` (${String(last.reason).slice(0, 160)})` : ''}.`;
  } catch (err) {
    console.error('receiptReconcile: lastLogHint failed (non-fatal):', err);
    return '';
  }
}

async function sendAlertEmail(items) {
  const elevatedEmailContact = elevate(triggeredEmails.emailContact);
  const variables = {
    count:      String(items.length),
    windowDays: String(LOOKBACK_DAYS),
    summary:    buildEmailSummary(items)
  };
  // One recipient failing must not stop the others, and must not make the next
  // run re-send to the ones who already got it. So: try everyone, and only
  // throw (→ the caller retries tomorrow) if NOBODY could be emailed.
  const failed = [];
  let sent = 0;
  for (const contactId of ALERT_CONTACT_IDS) {
    try {
      await elevatedEmailContact(ALERT_EMAIL_TEMPLATE_ID, contactId, { variables });
      sent++;
    } catch (err) {
      failed.push({ contactId, error: String(err?.message || err) });
      console.error('receiptReconcile: alert email to contactId', contactId, 'failed:', err);
    }
  }
  if (sent === 0) {
    throw new Error(failed.map(f => `${f.contactId}: ${f.error}`).join(' | ') || 'no alert recipients configured');
  }
  return { sent, failed };
}

// Was a "the check itself could not run" email already sent recently? Fails OPEN
// (returns false on a query error): better one extra email than a silent outage.
async function failureEmailRecentlySent(now) {
  try {
    const res = await wixData.query(LOG_COLLECTION)
      .eq('eventName', EVENT_NAME).eq('outcome', 'RECON_FAILURE_ALERTED').limit(1000).find({ suppressAuth: true });
    const cutoff = now.getTime() - FAILURE_EMAIL_COOLDOWN_HOURS * 60 * 60 * 1000;
    return res.items.some(r => new Date(r.receivedAt).getTime() >= cutoff);
  } catch (err) {
    console.error('receiptReconcile: failureEmailRecentlySent failed (non-fatal):', err);
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SCHEDULED JOB — referenced in jobs.config
// ─────────────────────────────────────────────────────────────────────────────
export async function reconcileReceipts() {
  const startedAt = new Date();
  const since = new Date(startedAt.getTime() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  console.log('receiptReconcile: starting, looking back to', since.toISOString());

  try {
    // 1. Gather
    const { orders: orderList, truncated } = await fetchRecentOrders(since);
    const classified = orderList.map(classifyOrder);
    const recentReceipts = await fetchRecentReceipts(since);

    const paidKeys = classified
      .filter(o => o.kind !== 'GIFT_CARD' && isPaidStatus(o.paymentStatus) && o.paid > 0)
      .flatMap(o => o.keys);
    const keyedReceipts = await fetchReceiptsByKeys(paidKeys);
    const receiptIndex = buildReceiptIndex([...keyedReceipts, ...recentReceipts]);

    // 2. Analyse
    const { mismatches, stats } = analyseReconciliation({
      classified, receiptIndex, recentReceipts, now: startedAt.getTime()
    });

    // 3. Which problems are new / not yet emailed
    const { known, alerted } = await fetchKnownKeys(mismatches.map(m => m.key));
    const toLog   = mismatches.filter(m => !known.has(m.key));
    const toAlert = mismatches.filter(m => !alerted.has(m.key));

    // Explain "paid, no receipt" problems we are about to report
    const byId = new Map(classified.map(o => [o.id, o]));
    for (const m of new Set([...toLog, ...toAlert])) {
      if (m.type === 'PAID_NO_RECEIPT') m.detail += await lastLogHint(byId.get(m.orderId)?.keys || [m.orderId]);
    }

    for (const m of toLog) {
      await writeLog({
        outcome: 'RECON_MISMATCH', reason: `${TYPE_LABEL[m.type]}: ${m.detail}`,
        orderId: m.orderId, wixTxId: m.key, itemName: m.kind, amount: m.amount, currency: m.currency,
        paymentStatus: byId.get(m.orderId)?.paymentStatus,
        payloadJson: { type: m.type, orderNumber: m.orderNumber, receiptId: m.receiptId }
      });
    }

    // 4. Email the ones nobody has been told about yet
    let emailNote = '';
    if (toAlert.length > 0) {
      try {
        const { sent, failed } = await sendAlertEmail(toAlert);
        for (const m of toAlert) {
          await writeLog({ outcome: 'RECON_ALERTED', reason: 'alert email sent', orderId: m.orderId, wixTxId: m.key });
        }
        emailNote = `emailed ${toAlert.length} to ${sent} recipient(s)`;
        if (failed.length > 0) {
          // Someone got it, so the problems count as alerted — but say who missed it.
          emailNote += `, ${failed.length} recipient(s) FAILED`;
          await writeLog({
            outcome: 'ERROR',
            reason: `alert email reached ${sent} recipient(s) but failed for: ${failed.map(f => `${f.contactId} (${f.error})`).join('; ')}`,
            payloadJson: { failedRecipients: failed }
          });
        }
      } catch (err) {
        emailNote = `EMAIL FAILED (${err?.message || err}) — will retry next run`;
        console.error('receiptReconcile: alert email failed:', err);
        await writeLog({
          outcome: 'ERROR',
          reason: `could not send the reconciliation alert email (template "${ALERT_EMAIL_TEMPLATE_ID}"): ${err?.message || err}`,
          payloadJson: { unalertedProblems: toAlert.length }
        });
      }
    }

    // 5. Heartbeat row — written every run, problems or not
    const byType = {};
    for (const m of mismatches) byType[m.type] = (byType[m.type] || 0) + 1;
    const summaryReason =
      `checked ${stats.ordersChecked} orders (${stats.paidOrdersChecked} paid) and ${stats.receiptsChecked} receipts since ${since.toISOString().slice(0, 10)}: ` +
      `${mismatches.length} open problem(s), ${toLog.length} new` + (emailNote ? `, ${emailNote}` : '') +
      (truncated ? ` — WARNING: order list hit the ${MAX_ORDER_PAGES * ORDERS_PAGE}-order cap, older orders in the window were not checked` : '');
    await writeLog({
      outcome: 'RECON_RUN', reason: summaryReason,
      payloadJson: { since: since.toISOString(), truncated, stats, byType }
    });
    console.log('receiptReconcile:', summaryReason);
    return { ok: true, mismatches: mismatches.length, newMismatches: toLog.length, alerted: toAlert.length, truncated, stats };

  } catch (err) {
    console.error('receiptReconcile: run failed:', err);
    await writeLog({ outcome: 'ERROR', reason: `reconciliation run failed: ${err?.message || err}` });
    // Best effort: tell someone the safety net itself is down — but at most once
    // per FAILURE_EMAIL_COOLDOWN_HOURS, because this job runs every hour and a
    // persistent failure (e.g. a permissions error) must not email people hourly.
    try {
      if (await failureEmailRecentlySent(startedAt)) {
        console.log(`receiptReconcile: run-failure email suppressed (one already sent in the last ${FAILURE_EMAIL_COOLDOWN_HOURS}h)`);
      } else {
        await sendAlertEmail([{
          type: 'RUN_FAILED', detail: `The receipt check could not run (${err?.message || err}). Nothing was changed; receipts are unaffected.`
        }]);
        await writeLog({ outcome: 'RECON_FAILURE_ALERTED', reason: 'run-failure email sent' });
      }
    } catch (mailErr) {
      console.error('receiptReconcile: could not send the failure email either:', mailErr);
    }
    return { ok: false, error: String(err?.message || err) };
  }
}
