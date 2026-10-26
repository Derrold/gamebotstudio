import {
  acceptTerms,
  accountPayload,
  activateLicense,
  activeDownloadLicense,
  cleanMachineId,
  exchangeMagic,
  issuePayment,
  reinstatePayments,
  requestMagicLink,
  revokePayments,
  validateLicense,
} from "./accounts.js";
import { LICENSE_KEY_RE, sha256Equal } from "./crypto_util.js";
import { cleanEmail } from "./email_address.js";
import { fulfillmentMode, paypalAllowed, stripeAllowed } from "./mode.js";
import { amountAccepted } from "./money.js";
import { assertPaypalSignature, fetchPaypalPayerEmail, interpretPaypalEvent } from "./paypal.js";
import { createStore } from "./store.js";
import { interpretStripeEvent, readStripeEvent } from "./stripe_events.js";

const JSON_LIMIT = 16384;
const WEBHOOK_LIMIT = 1_000_000;

function corsHeaders(request, env) {
  const origin = request.headers.get("origin");
  if (!origin) return {};
  const allowed = String(env.ALLOWED_ORIGINS || "https://gamebotstudio.com")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (!allowed.includes(origin)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    vary: "Origin",
  };
}

function json(status, body, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...extra,
    },
  });
}

function bearer(request) {
  const header = request.headers.get("authorization") || "";
  const match = header.match(/^Bearer\s+(\S+)$/i);
  if (match) return match[1];
  const cookie = request.headers.get("cookie") || "";
  const session = cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith("gb_session="));
  return session ? decodeURIComponent(session.slice("gb_session=".length)) : null;
}

async function adminOk(request, env) {
  const expected = env.ADMIN_TOKEN || "";
  if (expected.length < 16) return "disabled";
  const header = request.headers.get("authorization") || "";
  const match = header.match(/^Bearer\s+(\S+)$/i);
  if (!match) return "unauthorized";
  const same = await sha256Equal(match[1], expected);
  return same ? "ok" : "unauthorized";
}

function sessionCookie(token, env, request) {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  const maxAge = Number(env.SESSION_TTL_SECONDS || 1209600);
  return `gb_session=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

function last4(value) {
  return value ? String(value).slice(-4) : null;
}

function log(fields) {
  console.log(JSON.stringify({ msg: "fulfillment", ...fields }));
}

async function readLimited(request, limit) {
  const text = await request.text();
  if (text.length > limit) {
    const err = new Error("body_too_large");
    err.status = 413;
    throw err;
  }
  return text;
}

function requireStore(env) {
  const store = createStore(env.LICENSES);
  if (!store) {
    const err = new Error("license_store_not_configured");
    err.status = 503;
    throw err;
  }
  return store;
}

function portalBlocksLive(env) {
  return fulfillmentMode(env) === "live" && String(env.PUBLIC_PORTAL_READY || "") !== "1";
}

async function loadSessionAccount(store, request, deps) {
  const token = bearer(request);
  const session = await store.getSession(token, deps.now());
  if (!session) return null;
  const account = await store.getAccount(session.account_id);
  if (!account) return null;
  return account;
}

function configured(env) {
  return {
    stripe_webhook_secret: Boolean(env.STRIPE_WEBHOOK_SECRET),
    paypal: Boolean(env.PAYPAL_WEBHOOK_ID),
    resend: Boolean(env.RESEND_API_KEY && env.EMAIL_FROM),
    admin: Boolean(env.ADMIN_TOKEN && env.ADMIN_TOKEN.length >= 16),
    kv: Boolean(env.LICENSES),
    product_artifact: Boolean(env.PRODUCT_BUCKET),
    portal_ready: String(env.PUBLIC_PORTAL_READY || "") === "1",
  };
}

async function review(store, sale, reason, nowIso) {
  const paymentId = sale.primaryPaymentId || sale.paymentIds?.[0];
  if (paymentId) {
    await store.putReview(sale.provider, paymentId, {
      reason,
      provider: sale.provider,
      payment_id: paymentId,
      email: sale.email || null,
      amount_cents: sale.amountCents ?? null,
      currency: sale.currency || null,
      at: nowIso,
      livemode: Boolean(sale.livemode),
    });
  }
  return { action: "needs_review", reason };
}

async function onIssue(store, env, deps, sale) {
  if (portalBlocksLive(env)) {
    const err = new Error("portal_not_ready");
    err.status = 503;
    throw err;
  }
  if (sale.product && sale.product !== "game-bot") return review(store, sale, "wrong_product", new Date(deps.now()).toISOString());
  if (!sale.primaryPaymentId) return review(store, sale, "missing_payment_id", new Date(deps.now()).toISOString());
  if (sale.amountCents == null || !amountAccepted(sale.amountCents, sale.currency, env)) {
    return review(store, sale, "amount_or_currency", new Date(deps.now()).toISOString());
  }
  return issuePayment(store, env, deps, sale);
}

async function onRevoke(store, env, deps, sale) {
  if (portalBlocksLive(env)) {
    const err = new Error("portal_not_ready");
    err.status = 503;
    throw err;
  }
  return revokePayments(store, env, deps, sale);
}

async function onReinstate(store, env, deps, sale) {
  if (portalBlocksLive(env)) {
    const err = new Error("portal_not_ready");
    err.status = 503;
    throw err;
  }
  return reinstatePayments(store, env, deps, sale);
}

function outcomeBody(result) {
  return {
    ok: true,
    action: result.action,
    reason: result.reason || undefined,
    license_last4: last4(result.license?.license_key),
    email: result.email || undefined,
  };
}

async function handleStripe(request, env, deps, cors) {
  const raw = await readLimited(request, WEBHOOK_LIMIT);
  const verified = await readStripeEvent(raw, request.headers.get("stripe-signature"), env, deps.now());
  if (!verified.ok) return json(verified.status, { ok: false, error: verified.error }, cors);
  const sale = interpretStripeEvent(verified.event);
  const gate = stripeAllowed(env, sale.livemode);
  if (!gate.ok) return json(200, { ok: true, action: "skipped", reason: gate.reason }, cors);
  if (sale.action === "ignore") return json(200, { ok: true, action: "ignored", reason: sale.reason }, cors);
  const store = requireStore(env);
  const result = sale.action === "issue"
    ? await onIssue(store, env, deps, sale)
    : sale.action === "reinstate"
      ? await onReinstate(store, env, deps, sale)
      : await onRevoke(store, env, deps, sale);
  log({ action: result.action, provider: "stripe", type: sale.eventType, payment_last4: last4(sale.primaryPaymentId || sale.paymentIds?.[0]) });
  return json(200, outcomeBody(result), cors);
}

async function handlePaypal(request, env, deps, cors) {
  const raw = await readLimited(request, WEBHOOK_LIMIT);
  await assertPaypalSignature({ rawBody: raw, headers: request.headers, env, deps });
  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return json(400, { ok: false, error: "invalid_json" }, cors);
  }
  const sale = interpretPaypalEvent(event);
  const gate = paypalAllowed(env);
  if (!gate.ok) return json(200, { ok: true, action: "skipped", reason: gate.reason }, cors);
  if (sale.action === "ignore") return json(200, { ok: true, action: "ignored", reason: sale.reason }, cors);
  const store = requireStore(env);
  if (sale.action === "issue" && !sale.email && sale.orderId && env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET) {
    const lookup = deps.fetchPaypalPayerEmail
      ? await deps.fetchPaypalPayerEmail(sale.orderId, env, deps)
      : await fetchPaypalPayerEmail(sale.orderId, env, deps);
    if (lookup.retry) {
      const err = new Error("paypal_order_lookup_failed");
      err.status = 502;
      throw err;
    }
    sale.email = lookup.email;
  }
  const result = sale.action === "issue"
    ? await onIssue(store, env, deps, sale)
    : sale.action === "reinstate"
      ? await onReinstate(store, env, deps, sale)
      : await onRevoke(store, env, deps, sale);
  log({ action: result.action, provider: "paypal", type: sale.eventType, payment_last4: last4(sale.primaryPaymentId || sale.paymentIds?.[0]) });
  return json(200, outcomeBody(result), cors);
}

async function handleDownload(request, env, deps, cors) {
  const store = requireStore(env);
  const account = await loadSessionAccount(store, request, deps);
  if (!account) return json(401, { ok: false, error: "sign_in_required" }, cors);
  const allowed = await activeDownloadLicense(store, account);
  if (allowed.error) return json(allowed.status, { ok: false, error: allowed.error }, cors);
  const objectKey = env.PRODUCT_OBJECT_KEY || "GameBot-Setup.exe";
  if (!env.PRODUCT_BUCKET) return json(503, { ok: false, error: "artifact_not_configured" }, cors);
  const file = await env.PRODUCT_BUCKET.get(objectKey);
  if (!file) return json(503, { ok: false, error: "artifact_missing" }, cors);
  const headers = {
    "content-type": "application/octet-stream",
    "content-disposition": 'attachment; filename="GameBot-Setup.exe"',
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
    ...cors,
  };
  if (env.ARTIFACT_STUB === "1") headers["x-gamebot-artifact"] = "stub";
  return new Response(file.body, { status: 200, headers });
}

function adminLicense(license) {
  if (!license) return null;
  return {
    ...license,
    last_email: license.last_email || null,
  };
}

async function handleAdmin(request, env, deps, cors, url) {
  const auth = await adminOk(request, env);
  if (auth === "disabled") return json(503, { ok: false, error: "admin_disabled" }, cors);
  if (auth !== "ok") return json(401, { ok: false, error: "unauthorized" }, cors);
  const store = requireStore(env);
  const path = url.pathname;
  const email = cleanEmail(url.searchParams.get("email") || "");
  const paymentId = url.searchParams.get("payment_id");
  const provider = url.searchParams.get("provider");

  if (request.method === "GET" && path === "/admin/licenses") {
    if (email) {
      const account = await store.findAccountByEmail(email);
      const licenses = await store.licensesForEmail(email);
      return json(200, { ok: true, account, licenses: licenses.map(adminLicense) }, cors);
    }
    if (paymentId && provider) {
      const found = await store.findByPayment(provider, paymentId);
      const review = await store.getReview(provider, paymentId);
      return json(200, { ok: true, license: found?.license_key ? adminLicense(found) : null, tombstone: found?.tombstone ? found : null, review }, cors);
    }
    return json(400, { ok: false, error: "invalid_request" }, cors);
  }

  if (request.method === "POST" && path === "/admin/accounts/resend") {
    const body = JSON.parse(await readLimited(request, JSON_LIMIT) || "{}");
    const target = cleanEmail(body.email);
    if (!target) return json(400, { ok: false, error: "invalid_email" }, cors);
    const result = await requestMagicLink(store, env, deps, target, { bypassRate: true });
    const licenses = await store.licensesForEmail(target);
    return json(200, { ok: true, ...result, last_email: licenses[0]?.last_email || null }, cors);
  }

  if (request.method === "POST" && (path === "/admin/accounts/disable" || path === "/admin/accounts/enable")) {
    const body = JSON.parse(await readLimited(request, JSON_LIMIT) || "{}");
    const target = cleanEmail(body.email);
    const account = target ? await store.findAccountByEmail(target) : null;
    if (!account) return json(404, { ok: false, error: "not_found" }, cors);
    account.disabled = path.endsWith("/disable");
    account.disabled_reason = account.disabled ? String(body.reason || "admin").slice(0, 200) : null;
    await store.putAccount(account);
    return json(200, { ok: true, disabled: account.disabled }, cors);
  }

  const licenseMatch = path.match(/^\/admin\/licenses\/(GB(?:-[0-9A-HJKMNP-TV-Z]{4}){4})(?:\/(revoke|restore|unbind))?$/);
  if (!licenseMatch || !LICENSE_KEY_RE.test(licenseMatch[1])) return json(404, { ok: false, error: "not_found" }, cors);
  const license = await store.getLicense(licenseMatch[1]);
  if (!license) return json(404, { ok: false, error: "not_found" }, cors);
  if (request.method === "GET") return json(200, { ok: true, license: adminLicense(license) }, cors);
  if (request.method !== "POST" || !licenseMatch[2]) return json(405, { ok: false, error: "method_not_allowed" }, cors);
  const body = JSON.parse(await readLimited(request, JSON_LIMIT) || "{}");
  const reason = String(body.reason || "admin").slice(0, 200);
  if (licenseMatch[2] === "revoke") {
    const result = await revokePayments(store, env, deps, {
      provider: license.provider,
      paymentIds: license.payment_ids || [license.payment_id],
      reason,
      refunded: false,
      silent: true,
    });
    return json(200, outcomeBody(result), cors);
  }
  if (licenseMatch[2] === "restore") {
    const result = await reinstatePayments(store, env, deps, {
      provider: license.provider,
      paymentIds: license.payment_ids || [license.payment_id],
      reason,
      admin: true,
    });
    return json(200, outcomeBody(result), cors);
  }
  if (license.machine_id) {
    license.machine_id = null;
    license.activated_at = null;
    await store.putLicense(license);
  }
  return json(200, { ok: true, action: "unbound", license_last4: last4(license.license_key) }, cors);
}

export async function handleRequest(request, env = {}, deps = {}) {
  const dependencies = { fetch: globalThis.fetch, now: () => Date.now(), ...deps };
  const cors = corsHeaders(request, env);
  const url = new URL(request.url);
  try {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    if (request.method === "GET" && url.pathname === "/health") {
      return json(200, {
        ok: true,
        service: "gamebot-fulfillment",
        mode: fulfillmentMode(env),
        paypal_env: String(env.PAYPAL_ENV || "sandbox"),
        configured: configured(env),
      }, cors);
    }

    if (request.method === "POST" && url.pathname === "/webhooks/stripe") return await handleStripe(request, env, dependencies, cors);
    if (request.method === "POST" && url.pathname === "/webhooks/paypal") return await handlePaypal(request, env, dependencies, cors);
    if (url.pathname.startsWith("/admin/")) return await handleAdmin(request, env, dependencies, cors, url);

    if (request.method === "POST" && (url.pathname === "/v1/licenses/activate" || url.pathname === "/v1/licenses/validate")) {
      const body = JSON.parse(await readLimited(request, JSON_LIMIT) || "{}");
      if (!LICENSE_KEY_RE.test(body.license_key || "")) return json(400, { ok: false, error: "invalid_request" }, cors);
      if (!cleanMachineId(body.machine_id)) return json(400, { ok: false, error: "invalid_machine_id" }, cors);
      const store = requireStore(env);
      const result = url.pathname.endsWith("/activate")
        ? await activateLicense(store, body, new Date(dependencies.now()).toISOString())
        : await validateLicense(store, body);
      if (result.error) return json(result.status, { ok: false, error: result.error }, cors);
      return json(result.status, result.body, cors);
    }

    if (request.method === "POST" && url.pathname === "/auth/magic") {
      const body = JSON.parse(await readLimited(request, JSON_LIMIT) || "{}");
      const token = typeof body.token === "string" ? body.token.trim() : "";
      if (!token.startsWith("gbm_")) return json(400, { ok: false, error: "invalid_or_expired" }, cors);
      const store = requireStore(env);
      const result = await exchangeMagic(store, env, dependencies, token);
      const headers = { ...cors, "set-cookie": sessionCookie(result.session, env, request) };
      return json(200, { ok: true, session_token: result.session, account: result.account }, headers);
    }

    if (request.method === "POST" && url.pathname === "/auth/magic/request") {
      if (fulfillmentMode(env) === "off") return json(200, { ok: true, action: "skipped", reason: "fulfillment_disabled" }, cors);
      const body = JSON.parse(await readLimited(request, JSON_LIMIT) || "{}");
      const email = cleanEmail(body.email);
      if (!email) return json(200, { ok: true }, cors);
      const store = requireStore(env);
      await requestMagicLink(store, env, dependencies, email);
      return json(200, { ok: true }, cors);
    }

    if (request.method === "POST" && url.pathname === "/auth/logout") {
      const store = requireStore(env);
      await store.deleteSession(bearer(request));
      const headers = { ...cors, "set-cookie": "gb_session=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax" };
      return json(200, { ok: true }, headers);
    }

    if (request.method === "GET" && url.pathname === "/account/me") {
      const store = requireStore(env);
      const account = await loadSessionAccount(store, request, dependencies);
      if (!account) return json(401, { ok: false, error: "sign_in_required" }, cors);
      const licenses = await store.licensesForAccount(account);
      return json(200, { ok: true, account: accountPayload(account, licenses) }, cors);
    }

    if (request.method === "POST" && url.pathname === "/account/terms") {
      const store = requireStore(env);
      const account = await loadSessionAccount(store, request, dependencies);
      if (!account) return json(401, { ok: false, error: "sign_in_required" }, cors);
      const saved = await acceptTerms(store, account, new Date(dependencies.now()).toISOString());
      const licenses = await store.licensesForAccount(saved);
      return json(200, { ok: true, account: accountPayload(saved, licenses) }, cors);
    }

    if (request.method === "GET" && url.pathname === "/download") return await handleDownload(request, env, dependencies, cors);

    return json(404, { ok: false, error: "not_found" }, cors);
  } catch (err) {
    const code = /^[a-z0-9_]+$/.test(err?.message || "") ? err.message : "internal_error";
    log({ error: code });
    return json(err?.status || 500, { ok: false, error: code }, cors);
  }
}
