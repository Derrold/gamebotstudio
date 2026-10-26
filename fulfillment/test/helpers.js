import { createSign, generateKeyPairSync } from "node:crypto";
import { crc32 } from "../src/paypal.js";
import { stripeSignatureHeader } from "../src/stripe_events.js";

export function memoryKv() {
  const map = new Map();
  return {
    async get(key) {
      return map.has(key) ? map.get(key) : null;
    },
    async put(key, value) {
      map.set(key, String(value));
    },
    async delete(key) {
      map.delete(key);
    },
  };
}

export function stubBucket(bytes = "MZ-local-stub") {
  const body = new TextEncoder().encode(bytes);
  return {
    async get(key) {
      if (key !== "GameBot-Setup.exe") return null;
      return { body };
    },
  };
}

export function testEnv(overrides = {}) {
  return {
    FULFILLMENT_MODE: "test",
    PAYPAL_ENV: "sandbox",
    SUPPORT_EMAIL: "alphamaxstudios@gmail.com",
    PUBLIC_SITE_URL: "https://gamebotstudio.com",
    STRIPE_WEBHOOK_SECRET: "test_stripe_webhook_secret",
    PAYPAL_WEBHOOK_ID: "WH-SANDBOX",
    ADMIN_TOKEN: "test-admin-token-0123456789",
    EXPECTED_AMOUNT_CENTS: "9900",
    EXPECTED_CURRENCY: "usd",
    LICENSES: memoryKv(),
    PRODUCT_BUCKET: stubBucket(),
    ...overrides,
  };
}

export const NOW = Date.parse("2026-10-26T18:00:00.000Z");

export function deps(extra = {}) {
  return { now: () => NOW, fetch: async () => { throw new Error("unexpected_fetch"); }, ...extra };
}

export async function stripeRequest(env, event, dependencies) {
  const raw = JSON.stringify(event);
  const header = await stripeSignatureHeader(env.STRIPE_WEBHOOK_SECRET, raw, Math.floor(dependencies.now() / 1000));
  return new Request("https://fulfillment.example/webhooks/stripe", {
    method: "POST",
    headers: { "stripe-signature": header, "content-type": "application/json" },
    body: raw,
  });
}

export function paidSession(overrides = {}) {
  return {
    id: "evt_session_1",
    object: "event",
    type: "checkout.session.completed",
    livemode: false,
    data: {
      object: {
        id: "cs_test_1",
        object: "checkout.session",
        payment_status: "paid",
        amount_total: 9900,
        currency: "usd",
        customer_details: { email: "buyer@example.com" },
        payment_intent: "pi_test_1",
        ...overrides,
      },
    },
  };
}

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
export const paypalCertPem = publicKey.export({ type: "spki", format: "pem" });

export function signPaypal({ raw, webhookId, transmissionId, transmissionTime }) {
  const message = `${transmissionId}|${transmissionTime}|${webhookId}|${crc32(new TextEncoder().encode(raw))}`;
  const signer = createSign("SHA256");
  signer.update(message);
  signer.end();
  return signer.sign(privateKey).toString("base64");
}

export function paypalRequest(env, event, dependencies, transmissionId = "tid-1") {
  const raw = JSON.stringify(event);
  const transmissionTime = new Date(dependencies.now()).toISOString();
  const signature = signPaypal({
    raw,
    webhookId: env.PAYPAL_WEBHOOK_ID,
    transmissionId,
    transmissionTime,
  });
  return new Request("https://fulfillment.example/webhooks/paypal", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "paypal-transmission-id": transmissionId,
      "paypal-transmission-time": transmissionTime,
      "paypal-transmission-sig": signature,
      "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-TEST",
      "paypal-auth-algo": "SHA256withRSA",
    },
    body: raw,
  });
}

export function paypalDeps(dependencies = deps()) {
  return { ...dependencies, fetchCert: async () => paypalCertPem };
}

export function captureEvent(email = "buyer@example.com") {
  return {
    id: "WH-CAP",
    event_type: "PAYMENT.CAPTURE.COMPLETED",
    resource: {
      id: "CAP123",
      status: "COMPLETED",
      amount: { currency_code: "USD", value: "99.00" },
      supplementary_data: { related_ids: { order_id: "ORDER123" } },
      ...(email ? { payer: { email_address: email } } : {}),
    },
  };
}

export async function readJson(response) {
  return { status: response.status, body: await response.json() };
}

export function authHeaders(token) {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}
