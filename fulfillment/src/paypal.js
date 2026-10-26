import { createVerify } from "node:crypto";
import { cleanEmail } from "./email_address.js";
import { moneyToCents } from "./money.js";

const CERT_HOSTS = new Set([
  "api.paypal.com",
  "api.sandbox.paypal.com",
  "api-m.paypal.com",
  "api-m.sandbox.paypal.com",
]);

const SELLER_WINS = new Set([
  "RESOLVED_SELLER_FAVOUR",
  "RESOLVED_SELLER_FAVOR",
  "CANCELED_BY_BUYER",
  "DENIED",
]);

export function paypalApiBase(env) {
  if (env.PAYPAL_API_BASE) return String(env.PAYPAL_API_BASE).replace(/\/$/, "");
  if (String(env.PAYPAL_ENV || "sandbox").toLowerCase() === "live") return "https://api-m.paypal.com";
  return "https://api-m.sandbox.paypal.com";
}

export function paypalCertUrlAllowed(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === "https:" && CERT_HOSTS.has(url.hostname) && url.pathname.startsWith("/v1/notifications/certs/");
}

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let bit = 0; bit < 8; bit++) {
      const mask = -(crc & 1);
      crc = (crc >>> 1) ^ (0xedb88320 & mask);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function verifyPaypalSignature({ transmissionId, transmissionTime, webhookId, rawBody, certPem, signatureBase64 }) {
  try {
    const bytes = typeof rawBody === "string" ? new TextEncoder().encode(rawBody) : rawBody;
    const message = `${transmissionId}|${transmissionTime}|${webhookId}|${crc32(bytes)}`;
    const verifier = createVerify("SHA256");
    verifier.update(message);
    verifier.end();
    return verifier.verify(certPem, Buffer.from(signatureBase64, "base64"));
  } catch {
    return false;
  }
}

function httpError(status, error) {
  const err = new Error(error);
  err.status = status;
  return err;
}

const certCache = new Map();

export async function fetchPaypalCert(url, deps) {
  if (!paypalCertUrlAllowed(url)) throw httpError(400, "paypal_cert_url_rejected");
  if (certCache.has(url)) return certCache.get(url);
  const response = await deps.fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw httpError(400, "paypal_cert_fetch_failed");
  const text = await response.text();
  if (text.length > 20000 || (!text.includes("BEGIN CERTIFICATE") && !text.includes("BEGIN PUBLIC KEY"))) {
    throw httpError(400, "paypal_cert_unrecognized");
  }
  certCache.set(url, text);
  return text;
}

export async function assertPaypalSignature({ rawBody, headers, env, deps }) {
  if (!env.PAYPAL_WEBHOOK_ID) throw httpError(401, "paypal_not_configured");
  const transmissionId = headers.get("paypal-transmission-id");
  const transmissionTime = headers.get("paypal-transmission-time");
  const signature = headers.get("paypal-transmission-sig");
  const certUrl = headers.get("paypal-cert-url");
  const algo = (headers.get("paypal-auth-algo") || "").toUpperCase();
  if (!transmissionId || !transmissionTime || !signature || !certUrl) {
    throw httpError(400, "paypal_signature_headers_missing");
  }
  if (algo && !algo.includes("SHA256")) throw httpError(400, "paypal_auth_algo_rejected");
  if (!paypalCertUrlAllowed(certUrl)) throw httpError(400, "paypal_cert_url_rejected");
  const transmitted = Date.parse(transmissionTime);
  if (!Number.isFinite(transmitted)) throw httpError(400, "paypal_transmission_time_invalid");
  const configured = Number(env.PAYPAL_TOLERANCE_SECONDS || 600);
  const tolerance = Number.isFinite(configured) && configured > 0 ? configured : 600;
  if (Math.abs(deps.now() - transmitted) > tolerance * 1000) throw httpError(400, "paypal_transmission_stale");
  const fetchCert = deps.fetchCert || ((url) => fetchPaypalCert(url, deps));
  const pem = await fetchCert(certUrl);
  const valid = verifyPaypalSignature({
    transmissionId,
    transmissionTime,
    webhookId: env.PAYPAL_WEBHOOK_ID,
    rawBody,
    certPem: pem,
    signatureBase64: signature,
  });
  if (!valid) throw httpError(400, "invalid_signature");
}

export function paypalRelatedIds(resource) {
  const ids = new Set();
  if (resource?.id) ids.add(resource.id);
  const orderId = resource?.supplementary_data?.related_ids?.order_id;
  if (orderId) ids.add(orderId);
  for (const link of resource?.links || []) {
    const href = String(link?.href || "");
    const capture = href.match(/\/v2\/payments\/captures\/([A-Za-z0-9]+)/);
    const order = href.match(/\/v2\/checkout\/orders\/([A-Za-z0-9]+)/);
    if (capture) ids.add(capture[1]);
    if (order) ids.add(order[1]);
  }
  for (const tx of resource?.disputed_transactions || []) {
    if (tx?.seller_transaction_id) ids.add(tx.seller_transaction_id);
    if (tx?.buyer_transaction_id) ids.add(tx.buyer_transaction_id);
  }
  return [...ids];
}

function saleFromCapture(resource) {
  const orderId = resource?.supplementary_data?.related_ids?.order_id || null;
  return {
    status: resource?.status || null,
    email: cleanEmail(resource?.payer?.email_address || resource?.payment_source?.paypal?.email_address),
    amountCents: moneyToCents(resource?.amount?.value),
    currency: resource?.amount?.currency_code || null,
    paymentIds: [resource?.id, orderId].filter(Boolean),
    primaryPaymentId: resource?.id || orderId,
    checkoutId: orderId,
    orderId,
  };
}

function saleFromOrder(resource) {
  const capture = resource?.purchase_units?.[0]?.payments?.captures?.[0];
  const amount = capture?.amount || resource?.purchase_units?.[0]?.amount;
  return {
    status: resource?.status || null,
    email: cleanEmail(resource?.payer?.email_address),
    amountCents: moneyToCents(amount?.value),
    currency: amount?.currency_code || null,
    paymentIds: [capture?.id, resource?.id].filter(Boolean),
    primaryPaymentId: capture?.id || resource?.id || null,
    checkoutId: resource?.id || null,
    orderId: resource?.id || null,
  };
}

export function interpretPaypalEvent(event) {
  const type = event?.event_type;
  const resource = event?.resource || {};
  const base = { eventId: event?.id || null, eventType: type, provider: "paypal" };
  if (type === "PAYMENT.CAPTURE.COMPLETED") {
    const sale = saleFromCapture(resource);
    if (sale.status && sale.status !== "COMPLETED") return { ...base, action: "ignore", reason: "not_completed" };
    return { ...base, action: "issue", ...sale };
  }
  if (type === "CHECKOUT.ORDER.COMPLETED") {
    const sale = saleFromOrder(resource);
    if (sale.status && sale.status !== "COMPLETED") return { ...base, action: "ignore", reason: "not_completed" };
    return { ...base, action: "issue", ...sale };
  }
  if (type === "PAYMENT.CAPTURE.REFUNDED" || type === "PAYMENT.CAPTURE.REVERSED") {
    return { ...base, action: "revoke", reason: type, refunded: true, paymentIds: paypalRelatedIds(resource) };
  }
  if (type === "CUSTOMER.DISPUTE.CREATED") {
    return { ...base, action: "revoke", reason: type, refunded: false, paymentIds: paypalRelatedIds(resource) };
  }
  if (type === "CUSTOMER.DISPUTE.RESOLVED") {
    const code = resource?.dispute_outcome?.outcome_code || "";
    const paymentIds = paypalRelatedIds(resource);
    if (SELLER_WINS.has(code)) return { ...base, action: "reinstate", reason: code || type, paymentIds };
    return { ...base, action: "revoke", reason: code || type, refunded: false, paymentIds };
  }
  if (type === "CUSTOMER.DISPUTE.UPDATED") return { ...base, action: "ignore", reason: "dispute_update" };
  return { ...base, action: "ignore", reason: "unhandled_event" };
}

let tokenCache = { key: "", token: "", exp: 0 };

export function clearPaypalTokenCache() {
  tokenCache = { key: "", token: "", exp: 0 };
}

export async function fetchPaypalPayerEmail(orderId, env, deps) {
  if (!/^[A-Za-z0-9]+$/.test(orderId || "")) return { retry: false, email: null };
  const cacheKey = `${env.PAYPAL_CLIENT_ID}:${paypalApiBase(env)}`;
  const now = deps.now();
  let token = tokenCache.token;
  if (tokenCache.key !== cacheKey || tokenCache.exp <= now + 30000) {
    const basic = btoa(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`);
    const response = await deps.fetch(`${paypalApiBase(env)}/v1/oauth2/token`, {
      method: "POST",
      headers: { authorization: `Basic ${basic}`, "content-type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) return { retry: true, email: null };
    const json = await response.json();
    token = json.access_token;
    tokenCache = { key: cacheKey, token, exp: now + Number(json.expires_in || 300) * 1000 };
  }
  const orderResponse = await deps.fetch(`${paypalApiBase(env)}/v2/checkout/orders/${orderId}`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10000),
  });
  if (orderResponse.status >= 500 || orderResponse.status === 429) return { retry: true, email: null };
  if (!orderResponse.ok) return { retry: false, email: null };
  const order = await orderResponse.json();
  return {
    retry: false,
    email: cleanEmail(order?.payer?.email_address || order?.payment_source?.paypal?.email_address),
  };
}
