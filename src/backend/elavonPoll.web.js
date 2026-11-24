import { Permissions, webMethod } from 'wix-web-module';
import { getSecret } from 'wix-secrets-backend';
import wixData from 'wix-data';
import wixPaymentProviderBackend from 'wix-payment-provider-backend';

// Transaction-resource events (kept as a secondary path — harmless to check,
// occasionally may carry a reference depending on how the tx was created)
const TRANSACTION_EVENTS = ["saleAuthorized", "saleCaptured", "saleSettled", "saleDeclined"];

// Payment-session-resource events — THE reliable path (see root cause note above)
const PAYMENT_SESSION_EVENTS = ["saleAuthorized", "saleDeclined", "saleAuthorizationPending"];

// How far back to look on the very first run ever (no prior state saved yet)
const FIRST_RUN_LOOKBACK_HOURS = 24;

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

// ─── Helper: Retrieve full session record from ElavonSessions ────────────────
async function getSessionRecord(wixTxId) {
  try {
    const result = await wixData.query("ElavonSessions")
      .eq("wixTxId", wixTxId)
      .find({ suppressAuth: true });

    return result.items.length > 0 ? result.items[0] : null;
  } catch (err) {
    console.error("ElavonSessions lookup failed:", err);
    return null;
  }
}

// ─── Helper: Get / initialize the "last polled" timestamp ────────────────────
async function getLastPolledAt() {
  try {
    const result = await wixData.query("ElavonPollState").find({ suppressAuth: true });
    if (result.items.length > 0) {
      return { record: result.items[0], since: new Date(result.items[0].lastPolledAt) };
    }
  } catch (err) {
    console.error("ElavonPollState lookup failed, using default lookback:", err);
  }

  const fallback = new Date(Date.now() - FIRST_RUN_LOOKBACK_HOURS * 60 * 60 * 1000);
  return { record: null, since: fallback };
}

// ─── Helper: Save the new "last polled" timestamp for next run ───────────────
async function saveLastPolledAt(record, newTimestamp) {
  try {
    if (record) {
      await wixData.update("ElavonPollState", {
        ...record,
        lastPolledAt: newTimestamp
      }, { suppressAuth: true });
    } else {
      await wixData.insert("ElavonPollState", {
        lastPolledAt: newTimestamp
      }, { suppressAuth: true });
    }
  } catch (err) {
    console.error("Failed to save ElavonPollState:", err);
  }
}

// ─── Core: resolve one transaction and submit the outcome to Wix ─────────────
// matchedVia is logged purely for debugging — tells us which path caught it.
async function resolveAndSubmit(tx, wixTxId, matchedVia) {
  const result = {
    wixTxId,
    matchedVia,
    pluginTransactionId: tx.id || null,
    txState:             tx.state ?? null,
    isAuthorized:        tx.isAuthorized ?? null,
    hadLocalSessionRecord: false,
    outcome:             null,   // APPROVED | DECLINED | ALREADY_PROCESSED | NOT_FINAL | SUBMIT_EVENT_ERROR
    submitEventSucceeded: false,
    errorMessage:        null
  };

  const sessionRecord = await getSessionRecord(wixTxId);
  result.hadLocalSessionRecord = !!sessionRecord;

  if (sessionRecord && sessionRecord.processed) {
    result.outcome = "ALREADY_PROCESSED";
    console.log("elavonPoll: already processed via another path — skipping:", wixTxId);
    return result;
  }

  const isApproved = tx.isAuthorized && ["authorized", "captured", "settled"].includes(tx.state);
  const isDeclined = tx.state === "declined";

  if (!isApproved && !isDeclined) {
    result.outcome = "NOT_FINAL";
    console.log("elavonPoll: transaction not in a final state yet — no action:", wixTxId, tx.state);
    return result;
  }

  try {
    if (isApproved) {
      console.log("elavonPoll: APPROVED —", wixTxId, "(via", matchedVia + ")");
      await wixPaymentProviderBackend.submitEvent({
        event: {
          transaction: {
            wixTransactionId:    wixTxId,
            pluginTransactionId: tx.id
          }
        }
      });
      result.outcome = "APPROVED";
    } else {
      console.log("elavonPoll: DECLINED —", wixTxId, "(via", matchedVia + ")");
      result.errorCode    = tx.failures?.[0]?.code        || "DECLINED";
      result.errorMessage = tx.failures?.[0]?.description || "Payment declined";
      await wixPaymentProviderBackend.submitEvent({
        event: {
          transaction: {
            wixTransactionId:    wixTxId,
            pluginTransactionId: tx.id,
            reasonCode:          2001,
            errorCode:           result.errorCode,
            errorMessage:        result.errorMessage
          }
        }
      });
      result.outcome = "DECLINED";
    }
    result.submitEventSucceeded = true;

  } catch (err) {
    result.outcome = "SUBMIT_EVENT_ERROR";
    result.errorMessage = err.message || String(err);
    console.error("elavonPoll: submitEvent failed for", wixTxId, err);
    return result; // don't mark as processed — worth retrying next run
  }

  if (sessionRecord) {
    try {
      await wixData.update("ElavonSessions", {
        ...sessionRecord,
        processed: true
      }, { suppressAuth: true });
    } catch (err) {
      console.error("elavonPoll: failed to mark session as processed:", err);
      result.errorMessage = (result.errorMessage ? result.errorMessage + " | " : "") +
        "Warning: submitEvent succeeded but failed to mark ElavonSessions.processed: " + (err.message || err);
    }
  }

  return result;
}

// ─── Process a single notification, routing by resourceType ──────────────────
async function processNotification(notification, headers, allResults) {
  // ── PATH A: resourceType "transaction" — direct, but customReference is
  // often absent here (see root cause note at top of file). Kept as a cheap
  // secondary check in case it's ever populated.
  if (notification.resourceType === "transaction") {
    if (!TRANSACTION_EVENTS.includes(notification.eventType)) return;

    const txRes = await fetch(notification.resource, { method: "GET", headers });
    if (!txRes.ok) {
      allResults.push({
        notificationId: notification.id, resource: notification.resource,
        outcome: "FETCH_TRANSACTION_FAILED", errorMessage: `HTTP ${txRes.status}`
      });
      return;
    }
    /** @type {any} */
    const tx = await txRes.json();

    if (!tx.customReference) {
      allResults.push({
        pluginTransactionId: tx.id, matchedVia: "transaction",
        outcome: "NO_CUSTOM_REFERENCE", errorMessage: "Not tagged on the Transaction resource itself"
      });
      return;
    }

    allResults.push(await resolveAndSubmit(tx, tx.customReference, "transaction"));
    return;
  }

  // ── PATH B: resourceType "paymentSession" — THE reliable path (fix) ────────
  if (notification.resourceType === "paymentSession") {
    if (!PAYMENT_SESSION_EVENTS.includes(notification.eventType)) return;

    const sessionRes = await fetch(notification.resource, { method: "GET", headers });
    if (!sessionRes.ok) {
      allResults.push({
        notificationId: notification.id, resource: notification.resource,
        outcome: "FETCH_PAYMENT_SESSION_FAILED", errorMessage: `HTTP ${sessionRes.status}`
      });
      return;
    }
    /** @type {any} */
    const session = await sessionRes.json();
    const wixTxId = session.customReference;

    if (!wixTxId) {
      allResults.push({
        pluginTransactionId: session.id, matchedVia: "paymentSession",
        outcome: "NO_CUSTOM_REFERENCE", errorMessage: "Not one of our payment sessions"
      });
      return;
    }

    if (!session.transaction) {
      allResults.push({
        wixTxId, matchedVia: "paymentSession",
        outcome: "NOT_FINAL", errorMessage: "Buyer has not completed payment on this session yet"
      });
      return;
    }

    const txRes = await fetch(session.transaction, { method: "GET", headers });
    if (!txRes.ok) {
      allResults.push({
        wixTxId, matchedVia: "paymentSession",
        outcome: "FETCH_TRANSACTION_FAILED", errorMessage: `HTTP ${txRes.status}`
      });
      return;
    }
    /** @type {any} */
    const tx = await txRes.json();

    allResults.push(await resolveAndSubmit(tx, wixTxId, "paymentSession"));
    return;
  }

  // Any other resourceType (paymentLink, etc.) — not relevant to our flow, ignore.
}

// ─────────────────────────────────────────────────────────────────────────────
// SCHEDULED JOB: pollElavonNotifications
// Referenced in backend/jobs.config
// ─────────────────────────────────────────────────────────────────────────────
export const pollElavonNotifications = webMethod(Permissions.Anyone, async () => {
  console.log("elavonPoll: starting run");

  const runStartedAt = new Date();
  const allResults = [];
  const topLevelErrors = [];
  let notificationsFound = 0;
  let transactionsChecked = 0;

  try {
    const { baseUrl, username, secret } = await loadCredentials();
    const headers = makeHeaders(username, secret);

    const { record: pollStateRecord, since } = await getLastPolledAt();
    const sinceIso = since.toISOString();
    console.log("elavonPoll: fetching notifications since", sinceIso);

    let pageToken = null;
    let pageCount = 0;
    const MAX_PAGES = 10;

    do {
      let url = `${baseUrl}/notifications?filter=createdAt_ge_${encodeURIComponent(sinceIso)}&limit=200`;
      if (pageToken) url += `&pageToken=${encodeURIComponent(pageToken)}`;

      const res = await fetch(url, { method: "GET", headers });

      if (!res.ok) {
        const errText = await res.text();
        console.error("elavonPoll: GET /notifications failed:", res.status, errText);
        topLevelErrors.push({ step: "GET /notifications", status: res.status, detail: errText });
        break;
      }

      /** @type {any} */
      const data = await res.json();
      const items = data.items || [];
      notificationsFound += items.length;
      console.log(`elavonPoll: page ${pageCount + 1} — ${items.length} notifications`);

      for (const notification of items) {
        const relevantType = notification.resourceType === "transaction" || notification.resourceType === "paymentSession";
        if (!relevantType) continue;

        transactionsChecked++;

        try {
          await processNotification(notification, headers, allResults);
        } catch (err) {
          console.error("elavonPoll: error processing notification:", notification.id, err);
          allResults.push({
            notificationId: notification.id,
            outcome: "PROCESSING_ERROR",
            errorMessage: err.message || String(err)
          });
        }
      }

      pageToken = data.nextPageToken || null;
      pageCount++;

    } while (pageToken && pageCount < MAX_PAGES);

    await saveLastPolledAt(pollStateRecord, runStartedAt.toISOString());

  } catch (err) {
    console.error("elavonPoll: unhandled error during run:", err);
    topLevelErrors.push({ step: "unhandled", detail: err.message || String(err) });
  }

  const processedCount = allResults.filter(r => r.outcome === "APPROVED" || r.outcome === "DECLINED").length;
  const hadErrors = topLevelErrors.length > 0 ||
    allResults.some(r => ["SUBMIT_EVENT_ERROR", "FETCH_TRANSACTION_FAILED", "FETCH_PAYMENT_SESSION_FAILED", "PROCESSING_ERROR"].includes(r.outcome));

  // ── Write the full audit record — every run, regardless of outcome ─────────
  try {
    await wixData.insert("ElavonPollLog", {
      runAt:               runStartedAt.toISOString(),
      sinceTimestamp:      runStartedAt.toISOString(),
      notificationsFound:  notificationsFound,
      transactionsChecked: transactionsChecked,
      processedCount:      processedCount,
      resultsJson:         JSON.stringify(allResults),
      errorsJson:          JSON.stringify(topLevelErrors),
      hadErrors:           hadErrors
    }, { suppressAuth: true });
  } catch (err) {
    console.error("elavonPoll: failed to write ElavonPollLog record:", err);
  }

  console.log(`elavonPoll: run complete — ${processedCount} transaction(s) processed, hadErrors=${hadErrors}`);

  return { processedCount, notificationsFound, transactionsChecked, hadErrors, results: allResults };
});