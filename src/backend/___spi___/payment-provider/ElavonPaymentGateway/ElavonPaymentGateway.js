//import * as paymentProvider from 'interfaces-psp-v1-payment-service-provider';
import { getSecret } from 'wix-secrets-backend';
import wixData from 'wix-data';

// ─── Helper: Load all Elavon credentials from Secrets Manager ─────────────────
async function loadCredentials() {
  const [baseUrl, username, secret, merchantId] = await Promise.all([
    getSecret("elavon_base_url"),
    getSecret("elavon_username"),
    getSecret("elavon_secret"),
    getSecret("elavon_merchant_id")
  ]);
  return { baseUrl, username, secret, merchantId };
}

// ─── Helper: Basic Auth header for all Elavon calls ──────────────────────────
function makeHeaders(username, secret) {
  const encoded = Buffer.from(`${username}:${secret}`).toString("base64");
  return {
    "Authorization": `Basic ${encoded}`,
    "Content-Type":  "application/json",
    "Accept":        "application/json;charset=UTF-8"
  };
}

 
export const connectAccount = async (options, context) => {
  try {
    const { baseUrl, username, secret, merchantId } = await loadCredentials();

    const res = await fetch(`${baseUrl}/merchants/${merchantId}`, {
      method:  "GET",
      headers: makeHeaders(username, secret)
    });

    if (res.status === 401) return { errorCode: "INVALID_CREDENTIALS" };
    if (!res.ok)           return { errorCode: "CONNECTION_FAILED" };

    /** @type {any} */
    const merchant = await res.json();

    return {
      credentials: { username, secret, merchantId },
      accountId:   merchantId,
      accountName: merchant.name || "Elavon Account"
    };

  } catch (err) {
    console.error("connectAccount error:", err);
    return { errorCode: "CONNECTION_FAILED" };
  }
};

 
export const createTransaction = async (options, context) => {
  try {
    const { baseUrl, username, secret } = await loadCredentials();
    const headers = makeHeaders(username, secret);
    const wixTxId = options.wixTransactionId;
    const siteUrl = "https://www.voyaform.com";

    // ── Validate amount and currency ────────────────────────────────────────
    if (!options.order.description.totalAmount || !options.order.description.currency) {
      console.error("createTransaction: missing amount or currency");
      return { errorCode: "INVALID_AMOUNT" };
    }

    const rawAmount = parseInt(options.order.description.totalAmount);
    if (isNaN(rawAmount) || rawAmount <= 0) {
      console.error("createTransaction: invalid totalAmount:", options.order.description.totalAmount);
      return { errorCode: "INVALID_AMOUNT" };
    }

    // Wix sends totalAmount in minor units ("10000" = 100.00 PLN)
    // Elavon expects decimal string ("100.00")
    const amount   = (rawAmount / 100).toFixed(2);
    const currency = options.order.description.currency;

    // ── Store Wix returnUrls in ElavonSessions collection ───────────────────
    try {
      await wixData.save("ElavonSessions", {
        wixTxId:    wixTxId,
        successUrl: options.order.returnUrls.successUrl || "",
        errorUrl:   options.order.returnUrls.errorUrl   || "",
        cancelUrl:  options.order.returnUrls.cancelUrl  || "",
        pendingUrl: options.order.returnUrls.pendingUrl || ""
      });
      console.log("ElavonSessions saved for wixTxId:", wixTxId);
    } catch (err) {
      console.error("Failed to save ElavonSessions:", err);
      // Non-fatal — continue with transaction
    }

    // ── CALL 1: Create Elavon Order ─────────────────────────────────────────
    /** @type {any} */
    let order;
    const orderRes = await fetch(`${baseUrl}/orders`, {
      method:  "POST",
      headers: headers,
      body: JSON.stringify({
        total:           { amount, currencyCode: currency },
        customReference: wixTxId,
        description:     "Voyaform Pricing Plan"
      })
    });

    if (!orderRes.ok) {
      console.error("POST /orders failed:", await orderRes.text());
      return { errorCode: "ORDER_CREATION_FAILED" };
    }

    order = await orderRes.json();

    if (!order.href) {
      console.error("POST /orders: no href in response", order);
      return { errorCode: "ORDER_CREATION_FAILED" };
    }

    // ── CALL 2: Create Elavon Payment Session ───────────────────────────────
    /** @type {any} */
    let session;
    const sessionRes = await fetch(`${baseUrl}/payment-sessions`, {
      method:  "POST",
      headers: headers,
      body: JSON.stringify({
        order:                order.href,
        hppType:              "fullPageRedirect",
        returnUrl:            `${siteUrl}/_functions/elavonReturn?wixTx=${wixTxId}`,
        cancelUrl:            `${siteUrl}/_functions/elavonCancel?wixTx=${wixTxId}`,
        customReference:      wixTxId,
        doCreateTransaction:  "true",
        shopperEmailAddress:  options.order.description.billingAddress?.email || ""
      })
    });

    if (!sessionRes.ok) {
      console.error("POST /payment-sessions failed:", await sessionRes.text());
      return { errorCode: "SESSION_CREATION_FAILED" };
    }

    session = await sessionRes.json();

    if (!session.url) {
      console.error("POST /payment-sessions: no url in response", session);
      return { errorCode: "SESSION_CREATION_FAILED" };
    }

    console.log("createTransaction success — session.id:", session.id);

    return {
      pluginTransactionId: session.id,
      redirectUrl:         session.url
    };

  } catch (err) {
    console.error("createTransaction error:", err);
    return { errorCode: "SESSION_CREATION_FAILED" };
  }
};
 
export const refundTransaction = async (options, context) => {
  // Phase 1: manual refunds in Elavon dashboard
  // Phase 2: implement POST /transactions (type: "refund")
  return {};
};