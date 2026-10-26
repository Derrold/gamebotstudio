import { hmacSha256Hex, timingSafeEqualHex } from "./crypto_util.js";
import { cleanEmail } from "./email_address.js";

export function idOf(value) {
  if (typeof value === "string" && value) return value;
  if (value && typeof value === "object" && typeof value.id === "string") return value.id;
  return null;
}

export function parseStripeSignature(header) {
  let timestamp = null;
  const signatures = [];
  for (const part of String(header || "").split(",")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key === "t") timestamp = value;
    if (key === "v1" && value) signatures.push(value);
  }
  return { timestamp, signatures };
}

export async function stripeSignatureHeader(secret, rawBody, timestampSec) {
  const digest = await hmacSha256Hex(secret, `${timestampSec}.${rawBody}`);
  return `t=${timestampSec},v1=${digest}`;
}

function fail(status, error) {
  return { ok: false, status, error };
}

export async function readStripeEvent(rawBody, header, env, nowMs) {
  const secrets = [env.STRIPE_WEBHOOK_SECRET, env.STRIPE_WEBHOOK_SECRET_PREVIOUS].filter(
    (value) => typeof value === "string" && value.length > 0,
  );
  if (!secrets.length) return fail(401, "stripe_webhook_secret_not_configured");
  const { timestamp, signatures } = parseStripeSignature(header);
  const timestampSec = Number(timestamp);
  if (!timestamp || !signatures.length || !Number.isFinite(timestampSec)) return fail(400, "invalid_signature");
  const configured = Number(env.STRIPE_TOLERANCE_SECONDS || 300);
  const tolerance = Number.isFinite(configured) && configured > 0 ? configured : 300;
  if (Math.abs(nowMs / 1000 - timestampSec) > tolerance) return fail(400, "stale_signature");

  const payload = `${timestamp}.${rawBody}`;
  let matched = false;
  for (const secret of secrets) {
    const expected = await hmacSha256Hex(secret, payload);
    for (const signature of signatures) {
      if (timingSafeEqualHex(expected, signature)) matched = true;
    }
  }
  if (!matched) return fail(400, "invalid_signature");

  try {
    const event = JSON.parse(rawBody);
    if (!event || typeof event.type !== "string" || !event.data?.object) return fail(400, "invalid_event");
    return { ok: true, event };
  } catch {
    return fail(400, "invalid_json");
  }
}

export function interpretStripeEvent(event) {
  const type = event.type;
  const object = event.data.object || {};
  const livemode = Boolean(event.livemode);
  const base = { livemode, eventId: event.id || null, eventType: type };

  if (type === "checkout.session.completed" || type === "checkout.session.async_payment_succeeded") {
    if (object.payment_status !== "paid") return { ...base, action: "ignore", reason: "not_paid" };
    const paymentIntent = idOf(object.payment_intent);
    return {
      ...base,
      action: "issue",
      provider: "stripe",
      email: cleanEmail(object.customer_details?.email || object.customer_email),
      amountCents: Number.isInteger(object.amount_total) ? object.amount_total : null,
      currency: object.currency || null,
      paymentIds: [paymentIntent, object.id].filter(Boolean),
      primaryPaymentId: paymentIntent || object.id || null,
      checkoutId: object.id || null,
      product: object.metadata?.product || null,
    };
  }

  if (type === "checkout.session.async_payment_failed") {
    return { ...base, action: "ignore", reason: "async_payment_failed" };
  }

  if (type === "payment_intent.succeeded") {
    const email = cleanEmail(object.receipt_email);
    if (!email) return { ...base, action: "ignore", reason: "payment_intent_without_email" };
    const cents = Number.isInteger(object.amount_received) && object.amount_received > 0
      ? object.amount_received
      : object.amount;
    return {
      ...base,
      action: "issue",
      provider: "stripe",
      email,
      amountCents: Number.isInteger(cents) ? cents : null,
      currency: object.currency || null,
      paymentIds: [object.id].filter(Boolean),
      primaryPaymentId: object.id || null,
      checkoutId: null,
      product: object.metadata?.product || null,
    };
  }

  if (type === "charge.dispute.created" || type === "charge.dispute.funds_withdrawn") {
    return {
      ...base,
      action: "revoke",
      provider: "stripe",
      reason: type,
      refunded: false,
      paymentIds: [idOf(object.payment_intent), idOf(object.charge)].filter(Boolean),
    };
  }

  if (type === "charge.refunded") {
    const refundedAmount = Number(object.amount_refunded || 0);
    if (!object.refunded && refundedAmount <= 0) return { ...base, action: "ignore", reason: "not_refunded" };
    return {
      ...base,
      action: "revoke",
      provider: "stripe",
      reason: "charge.refunded",
      refunded: true,
      paymentIds: [idOf(object.payment_intent), object.id].filter(Boolean),
    };
  }

  if (type === "charge.dispute.closed") {
    const paymentIds = [idOf(object.payment_intent), idOf(object.charge)].filter(Boolean);
    if (object.status === "won") {
      return { ...base, action: "reinstate", provider: "stripe", reason: "charge.dispute.closed", paymentIds };
    }
    return { ...base, action: "revoke", provider: "stripe", reason: "charge.dispute.closed", refunded: false, paymentIds };
  }

  if (type === "charge.dispute.funds_reinstated") {
    return {
      ...base,
      action: "reinstate",
      provider: "stripe",
      reason: "charge.dispute.funds_reinstated",
      paymentIds: [idOf(object.payment_intent), idOf(object.charge)].filter(Boolean),
    };
  }

  return { ...base, action: "ignore", reason: "unhandled_event" };
}
