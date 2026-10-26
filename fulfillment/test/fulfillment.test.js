import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { generateLicenseKey, LICENSE_KEY_RE } from "../src/crypto_util.js";
import { handleRequest } from "../src/http.js";
import { crc32 } from "../src/paypal.js";
import { TERMS_PARAGRAPHS } from "../src/terms.js";
import {
  authHeaders,
  captureEvent,
  deps,
  memoryKv,
  NOW,
  paidSession,
  paypalDeps,
  paypalRequest,
  readJson,
  stripeRequest,
  testEnv,
} from "./helpers.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

async function issueStripe(env, dependencies = deps(), event = paidSession()) {
  return readJson(await handleRequest(await stripeRequest(env, event, dependencies), env, dependencies));
}

async function loginFromPreview(env, dependencies, email = "buyer@example.com") {
  const lookup = await readJson(await handleRequest(
    new Request(`https://fulfillment.example/admin/licenses?email=${encodeURIComponent(email)}`, {
      headers: { authorization: `Bearer ${env.ADMIN_TOKEN}` },
    }),
    env,
    dependencies,
  ));
  const text = lookup.body.licenses[0].last_email.text;
  const token = text.match(/#login=(gbm_[A-Za-z0-9_-]+)/)[1];
  const signed = await readJson(await handleRequest(
    new Request("https://fulfillment.example/auth/magic", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    }),
    env,
    dependencies,
  ));
  return { lookup, text, token, signed };
}

test("crc32 matches the known ASCII vector", () => {
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
});

test("license keys match the public pattern", () => {
  for (let i = 0; i < 20; i++) assert.match(generateLicenseKey(), LICENSE_KEY_RE);
});

test("health and wrangler default to off, with the public portal not ready", async () => {
  const health = await readJson(await handleRequest(new Request("https://fulfillment.example/health"), {}));
  assert.equal(health.body.mode, "off");
  assert.equal(health.body.configured.portal_ready, false);
  const toml = readFileSync(join(root, "fulfillment/wrangler.toml"), "utf8");
  assert.match(toml, /FULFILLMENT_MODE = "off"/);
  assert.doesNotMatch(toml, /PUBLIC_PORTAL_READY = "1"/);
});

test("mode off acknowledges a valid Stripe payment and creates nothing", async () => {
  const env = testEnv({ FULFILLMENT_MODE: "off", LICENSES: memoryKv() });
  const dependencies = deps();
  const response = await issueStripe(env, dependencies);
  assert.equal(response.status, 200);
  assert.equal(response.body.action, "skipped");
  assert.equal(response.body.reason, "fulfillment_disabled");
  const lookup = await readJson(await handleRequest(
    new Request("https://fulfillment.example/admin/licenses?payment_id=pi_test_1&provider=stripe", {
      headers: { authorization: `Bearer ${env.ADMIN_TOKEN}` },
    }),
    env,
    dependencies,
  ));
  assert.equal(lookup.body.license, null);
});

test("test mode blocks live Stripe events", async () => {
  const env = testEnv();
  const event = paidSession();
  event.livemode = true;
  const response = await issueStripe(env, deps(), event);
  assert.equal(response.body.action, "skipped");
  assert.equal(response.body.reason, "live_event_blocked_in_test");
});

test("live mode refuses to fulfill until the public portal is marked ready", async () => {
  const env = testEnv({ FULFILLMENT_MODE: "live" });
  const event = paidSession();
  event.livemode = true;
  const response = await issueStripe(env, deps(), event);
  assert.equal(response.status, 503);
  assert.equal(response.body.error, "portal_not_ready");
});

test("bad, v0-only, and stale Stripe signatures are rejected", async () => {
  const env = testEnv();
  const dependencies = deps();
  const raw = JSON.stringify(paidSession());
  const bad = await readJson(await handleRequest(new Request("https://fulfillment.example/webhooks/stripe", {
    method: "POST",
    headers: { "stripe-signature": "t=1,v1=abcd" },
    body: raw,
  }), env, dependencies));
  assert.equal(bad.status, 400);
  const v0 = await readJson(await handleRequest(new Request("https://fulfillment.example/webhooks/stripe", {
    method: "POST",
    headers: { "stripe-signature": `t=${Math.floor(NOW / 1000)},v0=deadbeef` },
    body: raw,
  }), env, dependencies));
  assert.equal(v0.status, 400);
  const staleHeader = await (await import("../src/stripe_events.js")).stripeSignatureHeader(
    env.STRIPE_WEBHOOK_SECRET,
    raw,
    Math.floor(NOW / 1000) - 3600,
  );
  const stale = await readJson(await handleRequest(new Request("https://fulfillment.example/webhooks/stripe", {
    method: "POST",
    headers: { "stripe-signature": staleHeader },
    body: raw,
  }), env, dependencies));
  assert.equal(stale.status, 400);
  assert.equal(stale.body.error, "stale_signature");
});

test("a paid checkout creates one account, emails a magic link and key, and does not email a download URL", async () => {
  const env = testEnv();
  const dependencies = deps();
  const first = await issueStripe(env, dependencies);
  const second = await issueStripe(env, dependencies, { ...paidSession(), id: "evt_session_2" });
  assert.equal(first.body.action, "issued");
  assert.equal(first.body.email, "preview");
  assert.equal(second.body.action, "already_issued");
  const { lookup, text } = await loginFromPreview(env, dependencies);
  assert.equal(lookup.body.licenses.length, 1);
  assert.match(lookup.body.licenses[0].license_key, LICENSE_KEY_RE);
  assert.match(text, new RegExp(lookup.body.licenses[0].license_key));
  assert.match(text, /https:\/\/gamebotstudio.com\/account#login=gbm_/);
  assert.match(text, /Do not redistribute GameBot-Setup.exe/);
  assert.match(text, /Do not share your login/);
  assert.doesNotMatch(text, /\/download/);
  assert.equal(lookup.body.account.email, "buyer@example.com");
});

test("unpaid sessions and amount mismatches do not create a license", async () => {
  const env = testEnv();
  const dependencies = deps();
  const unpaid = paidSession({ payment_status: "unpaid" });
  const unpaidResponse = await issueStripe(env, dependencies, unpaid);
  assert.equal(unpaidResponse.body.action, "ignored");
  const wrong = paidSession({ amount_total: 1000 });
  wrong.id = "evt_wrong";
  wrong.data.object.payment_intent = "pi_wrong";
  const wrongResponse = await issueStripe(env, dependencies, wrong);
  assert.equal(wrongResponse.body.action, "needs_review");
  assert.equal(wrongResponse.body.reason, "amount_or_currency");
});

test("download is authenticated, terms-gated, revoked on dispute, and restored when the dispute is won", async () => {
  const env = testEnv();
  const dependencies = deps();
  await issueStripe(env, dependencies);
  const open = await readJson(await handleRequest(new Request("https://fulfillment.example/download?token=shared"), env, dependencies));
  assert.equal(open.status, 401);
  const { signed, lookup } = await loginFromPreview(env, dependencies);
  const session = signed.body.session_token;
  assert.equal(signed.body.account.download_available, false);
  const early = await readJson(await handleRequest(new Request("https://fulfillment.example/download", {
    headers: authHeaders(session),
  }), env, dependencies));
  assert.equal(early.status, 403);
  assert.equal(early.body.error, "terms_required");
  await handleRequest(new Request("https://fulfillment.example/account/terms", {
    method: "POST",
    headers: authHeaders(session),
  }), env, dependencies);
  const file = await handleRequest(new Request("https://fulfillment.example/download", { headers: authHeaders(session) }), env, dependencies);
  assert.equal(file.status, 200);
  assert.match(file.headers.get("content-disposition"), /filename="GameBot-Setup.exe"/);
  assert.equal(await file.text(), "MZ-local-stub");

  const dispute = {
    id: "evt_dispute",
    type: "charge.dispute.created",
    livemode: false,
    data: { object: { id: "dp_1", object: "dispute", payment_intent: "pi_test_1", charge: "ch_1", status: "needs_response" } },
  };
  const revoked = await issueStripe(env, dependencies, dispute);
  assert.equal(revoked.body.action, "revoked");
  const blocked = await readJson(await handleRequest(new Request("https://fulfillment.example/download", {
    headers: authHeaders(session),
  }), env, dependencies));
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.error, "download_disabled");
  const me = await readJson(await handleRequest(new Request("https://fulfillment.example/account/me", {
    headers: authHeaders(session),
  }), env, dependencies));
  assert.equal(me.body.account.access, "disabled");
  assert.equal(me.body.account.download_available, false);
  assert.match(me.body.account.orders[0].status_label, /Access disabled/);

  const won = {
    id: "evt_won",
    type: "charge.dispute.closed",
    livemode: false,
    data: { object: { object: "dispute", payment_intent: "pi_test_1", charge: "ch_1", status: "won" } },
  };
  const restored = await issueStripe(env, dependencies, won);
  assert.equal(restored.body.action, "reinstated");
  const again = await handleRequest(new Request("https://fulfillment.example/download", { headers: authHeaders(session) }), env, dependencies);
  assert.equal(again.status, 200);
  assert.equal(lookup.body.licenses[0].license_key, (await readJson(await handleRequest(
    new Request("https://fulfillment.example/account/me", { headers: authHeaders(session) }),
    env,
    dependencies,
  ))).body.account.orders[0].license_key);
});

test("a refund blocks automatic reinstatement after a later seller win", async () => {
  const env = testEnv();
  const dependencies = deps();
  await issueStripe(env, dependencies);
  const refund = {
    id: "evt_refund",
    type: "charge.refunded",
    livemode: false,
    data: { object: { id: "ch_1", object: "charge", payment_intent: "pi_test_1", refunded: true, amount_refunded: 9900 } },
  };
  assert.equal((await issueStripe(env, dependencies, refund)).body.action, "revoked");
  const won = {
    id: "evt_won_late",
    type: "charge.dispute.closed",
    livemode: false,
    data: { object: { object: "dispute", payment_intent: "pi_test_1", status: "won" } },
  };
  const response = await issueStripe(env, dependencies, won);
  assert.equal(response.body.action, "reinstate_blocked");
  assert.equal(response.body.reason, "refunded");
});

test("admin can revoke and restore, and a second purchase links the same account", async () => {
  const env = testEnv();
  const dependencies = deps();
  await issueStripe(env, dependencies);
  const second = paidSession({ id: "cs_test_2" });
  second.id = "evt_second";
  second.data.object.payment_intent = "pi_test_2";
  await issueStripe(env, dependencies, second);
  const lookup = await readJson(await handleRequest(
    new Request("https://fulfillment.example/admin/licenses?email=buyer@example.com", {
      headers: { authorization: `Bearer ${env.ADMIN_TOKEN}` },
    }),
    env,
    dependencies,
  ));
  assert.equal(lookup.body.licenses.length, 2);
  assert.equal(lookup.body.licenses[0].account_id, lookup.body.licenses[1].account_id);
  const key = lookup.body.licenses[0].license_key;
  const revoked = await readJson(await handleRequest(new Request(`https://fulfillment.example/admin/licenses/${key}/revoke`, {
    method: "POST",
    headers: authHeaders(env.ADMIN_TOKEN),
    body: JSON.stringify({ reason: "support" }),
  }), env, dependencies));
  assert.equal(revoked.body.action, "revoked");
  const restored = await readJson(await handleRequest(new Request(`https://fulfillment.example/admin/licenses/${key}/restore`, {
    method: "POST",
    headers: authHeaders(env.ADMIN_TOKEN),
    body: JSON.stringify({ reason: "support" }),
  }), env, dependencies));
  assert.equal(restored.body.action, "reinstated");
  const denied = await readJson(await handleRequest(
    new Request("https://fulfillment.example/admin/licenses?email=buyer@example.com"),
    env,
    dependencies,
  ));
  assert.equal(denied.status, 401);
});

test("activate binds one PC and a revoked key fails validation", async () => {
  const env = testEnv();
  const dependencies = deps();
  await issueStripe(env, dependencies);
  const lookup = await loginFromPreview(env, dependencies);
  const key = lookup.lookup.body.licenses[0].license_key;
  const machine = "win-4f3a9c2b";
  const other = "win-ffffffffffff";
  const activate = await readJson(await handleRequest(new Request("https://fulfillment.example/v1/licenses/activate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ license_key: key, machine_id: machine }),
  }), env, dependencies));
  assert.equal(activate.body.ok, true);
  const clash = await readJson(await handleRequest(new Request("https://fulfillment.example/v1/licenses/activate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ license_key: key, machine_id: other }),
  }), env, dependencies));
  assert.equal(clash.status, 409);
  const validate = await readJson(await handleRequest(new Request("https://fulfillment.example/v1/licenses/validate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ license_key: key, machine_id: machine }),
  }), env, dependencies));
  assert.equal(validate.body.status, "active");
  await handleRequest(new Request(`https://fulfillment.example/admin/licenses/${key}/revoke`, {
    method: "POST",
    headers: authHeaders(env.ADMIN_TOKEN),
    body: "{}",
  }), env, dependencies);
  const dead = await readJson(await handleRequest(new Request("https://fulfillment.example/v1/licenses/validate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ license_key: key, machine_id: machine }),
  }), env, dependencies));
  assert.equal(dead.status, 403);
  assert.equal(dead.body.error, "revoked");
});

test("PayPal capture issues, a dispute revokes, and a seller win restores", async () => {
  const env = testEnv();
  const dependencies = paypalDeps();
  const issued = await readJson(await handleRequest(paypalRequest(env, captureEvent(), dependencies), env, dependencies));
  assert.equal(issued.body.action, "issued");
  const { text, signed } = await loginFromPreview(env, dependencies);
  assert.match(text, /account#login=/);
  assert.doesNotMatch(text, /\/download/);
  const dispute = {
    id: "WH-DISPUTE",
    event_type: "CUSTOMER.DISPUTE.CREATED",
    resource: { disputed_transactions: [{ seller_transaction_id: "CAP123" }] },
  };
  const revoked = await readJson(await handleRequest(
    paypalRequest(env, dispute, dependencies, "tid-dispute"),
    env,
    dependencies,
  ));
  assert.equal(revoked.body.action, "revoked");
  const session = signed.body.session_token;
  await handleRequest(new Request("https://fulfillment.example/account/terms", {
    method: "POST",
    headers: authHeaders(session),
  }), env, dependencies);
  const blocked = await readJson(await handleRequest(new Request("https://fulfillment.example/download", {
    headers: authHeaders(session),
  }), env, dependencies));
  assert.equal(blocked.status, 403);
  const won = {
    id: "WH-WON",
    event_type: "CUSTOMER.DISPUTE.RESOLVED",
    resource: {
      dispute_outcome: { outcome_code: "RESOLVED_SELLER_FAVOR" },
      disputed_transactions: [{ seller_transaction_id: "CAP123" }],
    },
  };
  const restored = await readJson(await handleRequest(
    paypalRequest(env, won, dependencies, "tid-won"),
    env,
    dependencies,
  ));
  assert.equal(restored.body.action, "reinstated");
  const file = await handleRequest(new Request("https://fulfillment.example/download", {
    headers: authHeaders(session),
  }), env, dependencies);
  assert.equal(file.status, 200);
});

test("a PayPal buyer win stays revoked and a rejected cert host is not fetched", async () => {
  const env = testEnv();
  const dependencies = paypalDeps();
  await handleRequest(paypalRequest(env, captureEvent(), dependencies), env, dependencies);
  const lost = {
    id: "WH-LOST",
    event_type: "CUSTOMER.DISPUTE.RESOLVED",
    resource: {
      dispute_outcome: { outcome_code: "RESOLVED_BUYER_FAVOUR" },
      disputed_transactions: [{ seller_transaction_id: "CAP123" }],
    },
  };
  await handleRequest(paypalRequest(env, {
    id: "WH-OPEN",
    event_type: "CUSTOMER.DISPUTE.CREATED",
    resource: { disputed_transactions: [{ seller_transaction_id: "CAP123" }] },
  }, dependencies, "tid-open"), env, dependencies);
  const response = await readJson(await handleRequest(
    paypalRequest(env, lost, dependencies, "tid-lost"),
    env,
    dependencies,
  ));
  assert.equal(response.body.action, "already_revoked");
  let fetched = false;
  const evil = new Request("https://fulfillment.example/webhooks/paypal", {
    method: "POST",
    headers: {
      "paypal-transmission-id": "tid",
      "paypal-transmission-time": new Date(NOW).toISOString(),
      "paypal-transmission-sig": "aa",
      "paypal-cert-url": "https://evil.example/v1/notifications/certs/CERT",
      "paypal-auth-algo": "SHA256withRSA",
    },
    body: "{}",
  });
  const rejected = await readJson(await handleRequest(evil, env, {
    ...deps(),
    fetchCert: async () => { fetched = true; return "nope"; },
  }));
  assert.equal(rejected.status, 400);
  assert.equal(rejected.body.error, "paypal_cert_url_rejected");
  assert.equal(fetched, false);
});

test("missing PayPal payer email is loaded from the order before the account is created", async () => {
  const env = testEnv({ PAYPAL_CLIENT_ID: "sandbox-client", PAYPAL_CLIENT_SECRET: "sandbox-secret" });
  const dependencies = paypalDeps(deps({
    fetchPaypalPayerEmail: async (orderId) => {
      assert.equal(orderId, "ORDER123");
      return { retry: false, email: "order-buyer@example.com" };
    },
  }));
  const response = await readJson(await handleRequest(
    paypalRequest(env, captureEvent(null), dependencies, "tid-order"),
    env,
    dependencies,
  ));
  assert.equal(response.body.action, "issued");
  const lookup = await loginFromPreview(env, dependencies, "order-buyer@example.com");
  assert.match(lookup.text, /order-buyer@example.com|License key/);
  assert.equal(lookup.lookup.body.account.email, "order-buyer@example.com");
});

test("the account page and marketing copy keep Coming soon and the license terms", () => {
  const index = readFileSync(join(root, "index.html"), "utf8");
  const account = readFileSync(join(root, "account/index.html"), "utf8");
  const buy = readFileSync(join(root, "BUY-PAGE-COPY.md"), "utf8");
  assert.match(index, /PayPal coming soon/);
  assert.match(index, /AMD support coming soon/);
  assert.match(index, /not turned on yet/);
  assert.match(account, /Coming soon/);
  for (const paragraph of TERMS_PARAGRAPHS) {
    assert.ok(account.includes(paragraph), paragraph);
    assert.ok(buy.includes("Do not redistribute GameBot-Setup.exe"));
  }
  assert.doesNotMatch(account, /href="[^"]*GameBot-Setup\.exe/);
});
