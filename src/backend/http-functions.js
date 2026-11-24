// ─────────────────────────────────────────────────────────────────────────────
// FILE: http-functions.js
// PURPOSE: HTTP endpoints Elavon redirects buyer back to after payment,
//          plus the eparagony.pl webhook that confirms fiscal receipts
//          and sends the customer + admin receipt emails, plus the new
//          server-to-server Elavon notification webhook (BLIK fix).
// ─────────────────────────────────────────────────────────────────────────────

import { ok, serverError, response, badRequest } from "wix-http-functions";
import wixPaymentProviderBackend from "wix-payment-provider-backend";
import wixData from 'wix-data';
import { getSecret } from 'wix-secrets-backend';
import { createHmac } from "crypto";  // Note: Wix Velo supports Node's crypto module
import { triggeredEmails } from "wix-crm-backend";
import { elevate } from "wix-auth";

// ─── Fallback redirect URLs (used if ElavonSessions lookup fails) ─────────────
const FALLBACK_SUCCESS = "https://www.voyaform.com/thank-you-page";
const FALLBACK_ERROR   = "https://www.voyaform.com/pricing";
const FALLBACK_CANCEL  = "https://www.voyaform.com/pricing";
// ─────────────────────────────────────────────────────────────────────────────

// ─── Email template IDs (set up in Wix Triggered Emails dashboard) ────────────
const CUSTOMER_EMAIL_TEMPLATE_ID = 'customer';
const ADMIN_EMAIL_TEMPLATE_ID    = 'admin'; // re-enabled (was commented out as "not working"); a failure only logs, see sendReceiptEmails

 
// const ADMIN_EMAIL       = 'faizanalimian@gmail.com';               // ← testing
// const ADMIN_CONTACT_ID  = 'f3e7d9b7-9495-4d89-9f94-9bef3f170289';  // ← testing

// OFFICIAL (swap in when ready to go live):
const ADMIN_EMAIL      = 'hello@voyaform.com';
const ADMIN_CONTACT_ID = '8940063e-cc85-4fb6-b49b-69e72fd644d4';

// Who gets the admin "new order" notification: ONLY the developer, as admin
// (faizanalimian@gmail.com, contact verified in the CRM, SUBSCRIBED). NOT the
// studio (hello@voyaform.com / ADMIN_CONTACT_ID above): the client did not want
// this email, which is why it was switched off. Triggered emails go to CRM
// contact ids, so each person must exist as a contact in the site's CRM (Wix
// dashboard → Contacts) and must not be unsubscribed.
const ADMIN_NOTIFY_CONTACT_IDS = ['f3e7d9b7-9495-4d89-9f94-9bef3f170289'];
// ─────────────────────────────────────────────────────────────────────────────

// ─── Helper: format a date for email display ──────────────────────────────────
function formatDate(d) {
  const date = d instanceof Date ? d : new Date(d);
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

// ─── Send both receipt emails (customer + admin) ──────────────────────────────
// record       → the EparagonyReceipts item (has contactId, planName, amount, currency, email)
// documentUrl  → the CONFIRMED receipt link from the webhook payload
async function sendReceiptEmails(record, documentUrl) {
  const sharedVars = {
    planName:   record.planName || '',
    amount:     String(record.amount || ''),
    currency:   record.currency || '',
    receiptUrl: documentUrl || record.documentPublicUrl || '',
    orderDate:  formatDate(record.issuedAt || new Date())
  };

  const elevatedEmailContact = elevate(triggeredEmails.emailContact);

  // ── Customer receipt email ────────────────────────────────────────────────
  try {
    if (!record.contactId) {
      console.warn('sendReceiptEmails: no contactId on record — skipping customer email');
    } else {
      await elevatedEmailContact(CUSTOMER_EMAIL_TEMPLATE_ID, record.contactId, {
        variables: sharedVars
      });
      console.log('Customer receipt email sent to contactId:', record.contactId);
    }
  } catch (err) {
    console.error('Failed to send customer receipt email:', err.message);
  }

  // ── Admin notification email ──────────────────────────────────────────────
  // One try/catch PER recipient: a bad or unsubscribed contact must not stop
  // the others, and none of it may break the receipt flow.
  for (const adminContactId of ADMIN_NOTIFY_CONTACT_IDS) {
    try {
      await elevatedEmailContact(ADMIN_EMAIL_TEMPLATE_ID, adminContactId, {
        variables: { ...sharedVars, email: record.email || '' }
      });
      console.log('Admin notification email sent to contactId:', adminContactId);
    } catch (err) {
      console.error('Failed to send admin notification email to contactId', adminContactId, ':', err.message);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ENDPOINT: post_eparagonyWebhook
// URL: https://www.voyaform.com/_functions/eparagonyWebhook
// WHEN: eparagony.pl sends this after fiscal receipt is CONFIRMED / ERROR
// ─────────────────────────────────────────────────────────────────────────────
export async function post_eparagonyWebhook(request) {
  try {
    const rawBody = await request.body.text();  // raw text needed for HMAC check
    const signature = request.headers['x-signature'];

    if (!signature) {
      console.error('eparagonyWebhook: missing X-Signature header');
      return badRequest();
    }

    // ── Verify HMAC signature ─────────────────────────────────────────────────
    const webhookSecret = await getSecret('eparagony_webhook_secret');
    const expectedSignature = createHmac('sha256', webhookSecret)
      .update(rawBody)
      .digest('hex');

    if (signature !== expectedSignature) {
      console.error('eparagonyWebhook: signature mismatch — possible forged request');
      return badRequest();
    }

    /** @type {any} */
    const payload = JSON.parse(rawBody);

    console.log('eparagonyWebhook received:', {
      status: payload.status,
      documentType: payload.documentType,
      orderId: payload.orderId,
      documentUrl: payload.documentUrl
    });

    // ── Handle receipt statuses ─────────────────────────────────────────────────
    if (payload.status === 'CONFIRMED') {
      // ✅ Fiscal receipt successfully registered
      // payload.documentUrl → public link to the e-receipt
      // payload.orderId     → our wixTxId (matches order._id from events.js)
      console.log('Receipt CONFIRMED:', payload.documentUrl);

      // Update our EparagonyReceipts record: PENDING → CONFIRMED
      try {
        const result = await wixData.query('EparagonyReceipts')
          .eq('wixTxId', payload.orderId)
          .find({ suppressAuth: true });

        if (result.items.length > 0) {
          const record = result.items[0];
          await wixData.update('EparagonyReceipts', {
            ...record,
            status: 'CONFIRMED',
            documentPublicUrl: payload.documentUrl,
            confirmedAt: new Date()
          }, { suppressAuth: true });
          console.log('EparagonyReceipts record updated to CONFIRMED');

          // Send customer + admin emails now that the receipt is confirmed
          await sendReceiptEmails(record, payload.documentUrl);

        } else {
          console.warn('No EparagonyReceipts record found for orderId:', payload.orderId);
        }
      } catch (err) {
        console.error('Failed to update EparagonyReceipts record:', err);
      }

    } else if (payload.status === 'READY') {
      // Paper receipt printed successfully (only relevant if print:true was sent)
      console.log('Receipt printed (paper):', payload.orderId);

    } else if (payload.status === 'ERROR') {
      // ❌ Fiscalization failed — needs manual attention
      console.error('Receipt ERROR for order:', payload.orderId, payload);

      // Mark record as ERROR for visibility
      try {
        const result = await wixData.query('EparagonyReceipts')
          .eq('wixTxId', payload.orderId)
          .find({ suppressAuth: true });

        if (result.items.length > 0) {
          const record = result.items[0];
          await wixData.update('EparagonyReceipts', {
            ...record,
            status: 'ERROR'
          }, { suppressAuth: true });
        }
      } catch (err) {
        console.error('Failed to mark EparagonyReceipts record as ERROR:', err);
      }
    }

    return ok();

  } catch (err) {
    console.error('eparagonyWebhook unhandled error:', err);
    return badRequest();
  }
}

// ─── Helper: Load Elavon credentials from Secrets Manager ────────────────────
async function loadCredentials() {
  const [baseUrl, username, secret] = await Promise.all([
    getSecret("elavon_base_url"),
    getSecret("elavon_username"),
    getSecret("elavon_secret")
  ]);
  return { baseUrl, username, secret };
}

// ─── Helper: Basic Auth header ────────────────────────────────────────────────
function makeHeaders(username, secret) {
  const encoded = Buffer.from(`${username}:${secret}`).toString("base64");
  return {
    "Authorization": `Basic ${encoded}`,
    "Content-Type":  "application/json",
    "Accept":        "application/json;charset=UTF-8"
  };
}

// ─── Helper: 302 redirect response ───────────────────────────────────────────
function redirectTo(url) {
  return response({ status: 302, headers: { "Location": url } });
}

// ─── Retrieve full session record from ElavonSessions ────────────────────────
async function getSessionRecord(wixTxId) {
  try {
    const result = await wixData.query("ElavonSessions")
      .eq("wixTxId", wixTxId)
      .find();

    if (result.items.length > 0) {
      console.log("ElavonSessions found for wixTxId:", wixTxId);
      return result.items[0];
    }

    console.warn("ElavonSessions: no record found for wixTxId:", wixTxId);
    return null;

  } catch (err) {
    console.error("ElavonSessions lookup failed:", err);
    return null;
  }
}

// ─── Extract redirect URLs from session record with fallbacks ─────────────────
function getUrls(sessionRecord) {
  return {
    successUrl: sessionRecord?.successUrl || FALLBACK_SUCCESS,
    errorUrl:   sessionRecord?.errorUrl   || FALLBACK_ERROR,
    cancelUrl:  sessionRecord?.cancelUrl  || FALLBACK_CANCEL,
    pendingUrl: sessionRecord?.pendingUrl || FALLBACK_SUCCESS
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// ENDPOINT 1: get_elavonReturn
// URL: /_functions/elavonReturn?wixTx=...&sessionId=...
// ─────────────────────────────────────────────────────────────────────────────
export async function get_elavonReturn(request) {
  const wixTxId   = request.query.wixTx;
  const sessionId = request.query.sessionId;

  console.log("elavonReturn hit — wixTx:", wixTxId, "sessionId:", sessionId);

  if (!wixTxId) {
    console.error("elavonReturn: missing wixTx");
    return serverError();
  }

  // ── Get session record + URLs ─────────────────────────────────────────────
  const sessionRecord = await getSessionRecord(wixTxId);
  const urls          = getUrls(sessionRecord);

  // ── Idempotency check — already processed ────────────────────────────────
  if (sessionRecord && sessionRecord.processed) {
    console.log("elavonReturn: already processed — skipping submitEvent");
    return redirectTo(urls.successUrl);
  }

  if (!sessionId) {
    console.error("elavonReturn: missing sessionId");
    await wixPaymentProviderBackend.submitEvent({
      event: {
        transaction: {
          wixTransactionId:    wixTxId,
          pluginTransactionId: "unknown",
          reasonCode:          2001,
          errorCode:           "SESSION_NOT_FOUND",
          errorMessage:        "No session ID from Elavon"
        }
      }
    });
    return redirectTo(urls.errorUrl);
  }

  try {
    const { baseUrl, username, secret } = await loadCredentials();
    const headers = makeHeaders(username, secret);

    // ── CALL 3: Get payment session ───────────────────────────────────────
    const sessionRes = await fetch(
      `${baseUrl}/payment-sessions/${sessionId}`,
      { method: "GET", headers }
    );

    if (!sessionRes.ok) {
      console.error("GET /payment-sessions failed:", sessionRes.status);
      return redirectTo(urls.errorUrl);
    }

    /** @type {any} */
    const session = await sessionRes.json();
    console.log("session.transaction:", session.transaction);

    if (!session.transaction) {
      console.warn("elavonReturn: no transaction on session");
      await wixPaymentProviderBackend.submitEvent({
        event: {
          transaction: {
            wixTransactionId:    wixTxId,
            pluginTransactionId: session.id,
            reasonCode:          2001,
            errorCode:           "NO_TRANSACTION",
            errorMessage:        "Buyer did not complete payment"
          }
        }
      });
      return redirectTo(urls.errorUrl);
    }

    // ── CALL 4: Get real transaction status ───────────────────────────────
    const txRes = await fetch(session.transaction, {
      method:  "GET",
      headers: headers
    });

    if (!txRes.ok) {
      console.error("GET /transactions failed:", txRes.status);
      return redirectTo(urls.errorUrl);
    }

    /** @type {any} */
    const tx = await txRes.json();
    console.log("tx.state:", tx.state, "tx.isAuthorized:", tx.isAuthorized);

    if (tx.isAuthorized && ["authorized", "captured", "settled"].includes(tx.state)) {

      // ✅ APPROVED
      console.log("elavonReturn: APPROVED");
      await wixPaymentProviderBackend.submitEvent({
        event: {
          transaction: {
            wixTransactionId:    wixTxId,
            pluginTransactionId: tx.id
          }
        }
      });

      // Mark as processed — prevents duplicate submitEvent
      if (sessionRecord) {
        try {
          await wixData.update("ElavonSessions", {
            ...sessionRecord,
            processed: true
          });
        } catch (err) {
          console.error("Failed to mark session as processed:", err);
        }
      }

      return redirectTo(urls.successUrl);

    } else if (tx.state === "authorizationPending") {

      // ⏳ PENDING
      console.log("elavonReturn: PENDING");
      await wixPaymentProviderBackend.submitEvent({
        event: {
          transaction: {
            wixTransactionId:    wixTxId,
            pluginTransactionId: tx.id,
            reasonCode:          5005
          }
        }
      });
      return redirectTo(urls.pendingUrl);

    } else {

      // ❌ DECLINED
      console.log("elavonReturn: DECLINED — state:", tx.state);
      await wixPaymentProviderBackend.submitEvent({
        event: {
          transaction: {
            wixTransactionId:    wixTxId,
            pluginTransactionId: tx.id,
            reasonCode:          2001,
            errorCode:           tx.failures?.[0]?.code        || "DECLINED",
            errorMessage:        tx.failures?.[0]?.description || "Payment declined"
          }
        }
      });
      return redirectTo(urls.errorUrl);

    }

  } catch (err) {
    console.error("get_elavonReturn unhandled error:", err);
    return redirectTo(urls.errorUrl);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ENDPOINT 2: get_elavonCancel
// URL: /_functions/elavonCancel?wixTx=...
// ─────────────────────────────────────────────────────────────────────────────
export async function get_elavonCancel(request) {
  const wixTxId   = request.query.wixTx;
  const sessionId = request.query.sessionId || "canceled";

  console.log("elavonCancel hit — wixTx:", wixTxId);

  if (!wixTxId) {
    console.error("elavonCancel: missing wixTx");
    return serverError();
  }

  const sessionRecord = await getSessionRecord(wixTxId);
  const urls          = getUrls(sessionRecord);

  try {
    await wixPaymentProviderBackend.submitEvent({
      event: {
        transaction: {
          wixTransactionId:    wixTxId,
          pluginTransactionId: sessionId,
          reasonCode:          3030
        }
      }
    });
    return redirectTo(urls.cancelUrl);

  } catch (err) {
    console.error("get_elavonCancel error:", err);
    return redirectTo(urls.cancelUrl);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ENDPOINT 3: post_elavonNotification
// URL: https://www.voyaform.com/_functions/elavonNotification
// WHEN: Elavon calls this DIRECTLY, server-to-server — independent of the
// buyer's browser. This is the fix for async payment methods like BLIK,
// where the buyer confirms in their banking app and may never actually
// return to our returnUrl, meaning get_elavonReturn() above would never fire
// and the order would stay stuck as "pending" in Wix forever even though
// Elavon has already settled the payment.
//
// SETUP REQUIRED (one-time, done by the merchant — not in our code):
//   Bartosz must log into the Elavon merchant Back Office and set the
//   Notification Webhook URL to:
//     https://www.voyaform.com/_functions/elavonNotification
//
// SECURITY MODEL:
//   We never trust the incoming payload directly. It only tells us WHICH
//   transaction to check — we then independently re-fetch that transaction
//   from Elavon using our own authenticated credentials before doing
//   anything, exactly like get_elavonReturn already does. A forged/garbage
//   POST to this endpoint cannot approve a payment by itself.
//
// IDEMPOTENCY:
//   Reuses the same ElavonSessions.processed flag as get_elavonReturn — so
//   if both the browser redirect AND this webhook fire for the same
//   transaction, only the first one to arrive actually does anything.
// ─────────────────────────────────────────────────────────────────────────────
export async function post_elavonNotification(request) {
  try {
    /** @type {any} */
    const notification = await request.body.json();

    console.log("elavonNotification received:", {
      eventType: notification.eventType,
      resourceType: notification.resourceType,
      resource: notification.resource
    });

    // Only interested in sale outcome events — ignore refunds, voids, etc.
    const RELEVANT_EVENTS = ["saleAuthorized", "saleCaptured", "saleSettled", "saleDeclined"];
    if (!RELEVANT_EVENTS.includes(notification.eventType)) {
      console.log("elavonNotification: ignoring event type", notification.eventType);
      return ok();
    }

    if (notification.resourceType !== "transaction" || !notification.resource) {
      console.warn("elavonNotification: no transaction resource on this notification — skipping");
      return ok();
    }

    const { username, secret } = await loadCredentials();
    const headers = makeHeaders(username, secret);

    // ── Independently re-fetch the real transaction — never trust the payload ──
    const txRes = await fetch(notification.resource, { method: "GET", headers });

    if (!txRes.ok) {
      console.error("elavonNotification: failed to fetch transaction:", txRes.status);
      return ok(); // acknowledge receipt so Elavon doesn't keep retrying a dead link
    }

    /** @type {any} */
    const tx = await txRes.json();
    const wixTxId = tx.customReference; // we set this to wixTxId in createTransaction()

    if (!wixTxId) {
      console.warn("elavonNotification: transaction has no customReference — cannot match to an order");
      return ok();
    }

    console.log("elavonNotification: matched wixTxId:", wixTxId, "tx.state:", tx.state, "tx.isAuthorized:", tx.isAuthorized);

    // ── Idempotency check — skip if get_elavonReturn (or an earlier webhook) already handled this ──
    const sessionRecord = await getSessionRecord(wixTxId);
    if (sessionRecord && sessionRecord.processed) {
      console.log("elavonNotification: already processed via another path — skipping:", wixTxId);
      return ok();
    }

    // ── Map Elavon state → submitEvent, same logic as get_elavonReturn ─────────
    if (tx.isAuthorized && ["authorized", "captured", "settled"].includes(tx.state)) {

      console.log("elavonNotification: APPROVED —", wixTxId);
      await wixPaymentProviderBackend.submitEvent({
        event: {
          transaction: {
            wixTransactionId:    wixTxId,
            pluginTransactionId: tx.id
          }
        }
      });

    } else if (tx.state === "declined") {

      console.log("elavonNotification: DECLINED —", wixTxId);
      await wixPaymentProviderBackend.submitEvent({
        event: {
          transaction: {
            wixTransactionId:    wixTxId,
            pluginTransactionId: tx.id,
            reasonCode:          2001,
            errorCode:           tx.failures?.[0]?.code        || "DECLINED",
            errorMessage:        tx.failures?.[0]?.description || "Payment declined"
          }
        }
      });

    } else {
      console.log("elavonNotification: transaction not yet in a final state — no action:", tx.state);
      return ok();
    }

    // ── Mark as processed — no browser redirect needed, this is a server webhook ──
    if (sessionRecord) {
      try {
        await wixData.update("ElavonSessions", {
          ...sessionRecord,
          processed: true
        });
      } catch (err) {
        console.error("elavonNotification: failed to mark session as processed:", err);
      }
    }

    return ok();

  } catch (err) {
    console.error("post_elavonNotification unhandled error:", err);
    return ok(); // acknowledge receipt regardless, so Elavon doesn't retry indefinitely on our bugs
  }
}