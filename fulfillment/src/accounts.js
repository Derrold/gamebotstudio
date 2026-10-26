import { generateLicenseKey, randomToken } from "./crypto_util.js";
import { normalizeEmail } from "./email_address.js";
import { deliverEmail, renderReceipt, renderRestored, renderRevokedNotice } from "./email.js";
import { TERMS_PARAGRAPHS } from "./terms.js";

export function cleanMachineId(value) {
  if (typeof value !== "string") return null;
  const id = value.trim();
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(id)) return null;
  return id;
}

export function statusLabel(license) {
  if (license.status === "active" && license.reinstated_at) {
    return "Active again. The dispute was decided in our favor.";
  }
  if (license.status === "active") return "Paid. You can download the installer from this account.";
  if (license.refunded) return "Access disabled. This payment was refunded or reversed.";
  return "Access disabled. This payment was disputed, refunded, or reversed.";
}

export function publicLicense(license) {
  return {
    license_key: license.license_key,
    status: license.status,
    provider: license.provider,
    payment_id: license.payment_id,
    created_at: license.created_at,
    revoked_at: license.revoked_at,
    revoke_reason: license.revoke_reason,
    reinstated_at: license.reinstated_at,
    refunded: Boolean(license.refunded),
    machine_id: license.machine_id || null,
    amount_cents: license.amount_cents ?? null,
    currency: license.currency || null,
    status_label: statusLabel(license),
  };
}

export function accountPayload(account, licenses) {
  const orders = licenses.map(publicLicense);
  const anyActive = orders.some((order) => order.status === "active");
  const disabled = Boolean(account.disabled);
  const termsAccepted = Boolean(account.terms_accepted_at);
  return {
    email: account.email,
    access: disabled || !anyActive ? "disabled" : "active",
    disabled,
    terms_accepted: termsAccepted,
    terms: TERMS_PARAGRAPHS,
    download_available: anyActive && termsAccepted && !disabled,
    orders,
  };
}

function ttlMs(env, name, fallback) {
  const value = Number(env[name] || fallback);
  return Number.isFinite(value) && value >= 60 ? value * 1000 : fallback * 1000;
}

async function freshKey(store) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const key = generateLicenseKey();
    if (!(await store.getLicense(key))) return key;
  }
  const err = new Error("license_key_collision");
  err.status = 500;
  throw err;
}

async function ensureAccount(store, email, nowIso) {
  const existing = await store.findAccountByEmail(email);
  if (existing) return existing;
  const account = {
    account_id: randomToken("acct_"),
    email,
    created_at: nowIso,
    disabled: false,
    disabled_reason: null,
    terms_accepted_at: null,
    license_keys: [],
  };
  await store.putAccount(account);
  return account;
}

async function sendLicenseMail(store, env, deps, license, kind) {
  const token = randomToken("gbm_");
  const exp = deps.now() + ttlMs(env, "MAGIC_TTL_SECONDS", 86400);
  await store.putMagic(token, { account_id: license.account_id, email: license.email, exp, purpose: kind });
  const message = kind === "revoked"
    ? renderRevokedNotice({ env, token, license })
    : kind === "restored"
      ? renderRestored({ env, token, license })
      : renderReceipt({ env, token, license });
  const result = await deliverEmail(env, deps, message, license.email);
  license.last_email = {
    at: new Date(deps.now()).toISOString(),
    delivery: result.delivery,
    subject: message.subject,
    text: result.delivery === "preview" ? message.text : undefined,
  };
  if (kind === "restored") license.reinstate_notice_settled = true;
  else license.email_settled = true;
  await store.putLicense(license);
  return result.delivery;
}

async function locate(store, provider, paymentIds) {
  let license = null;
  let tombstone = null;
  for (const id of paymentIds) {
    const found = await store.findByPayment(provider, id);
    if (!found) continue;
    if (found.license_key) license = found;
    else if (found.tombstone) tombstone = found;
  }
  return { license, tombstone };
}

export async function issuePayment(store, env, deps, input) {
  const nowIso = new Date(deps.now()).toISOString();
  const ids = [...new Set((input.paymentIds || []).filter(Boolean))];
  const { license: existing, tombstone } = await locate(store, input.provider, ids);
  if (existing) {
    let delivery = existing.email_settled ? existing.last_email?.delivery || "already_sent" : null;
    if (existing.email && !existing.email_settled) {
      delivery = await sendLicenseMail(store, env, deps, existing, existing.status === "active" ? "receipt" : "revoked");
    }
    return { action: "already_issued", license: existing, email: delivery };
  }

  if (!input.email) return { action: "needs_review", reason: "missing_email" };

  const account = await ensureAccount(store, input.email, nowIso);
  const revoked = Boolean(tombstone);
  const license = {
    license_key: await freshKey(store),
    email: input.email,
    account_id: account.account_id,
    provider: input.provider,
    payment_id: input.primaryPaymentId || ids[0],
    payment_ids: ids,
    checkout_id: input.checkoutId || null,
    status: revoked ? "revoked" : "active",
    machine_id: null,
    activated_at: null,
    created_at: nowIso,
    revoked_at: revoked ? tombstone.at || nowIso : null,
    revoke_reason: revoked ? tombstone.reason || "revoked_before_delivery" : null,
    refunded: revoked ? Boolean(tombstone.refunded) : false,
    livemode: Boolean(input.livemode),
    amount_cents: input.amountCents ?? null,
    currency: input.currency || null,
    product: "game-bot",
    reinstated_at: null,
    reinstate_reason: null,
    email_settled: false,
    reinstate_notice_settled: false,
    event_ids: input.eventId ? [input.eventId] : [],
  };
  await store.putLicense(license);
  const delivery = await sendLicenseMail(store, env, deps, license, revoked ? "revoked" : "receipt");
  return { action: revoked ? "issued_revoked" : "issued", license, email: delivery };
}

export async function revokePayments(store, env, deps, input) {
  const nowIso = new Date(deps.now()).toISOString();
  const ids = [...new Set((input.paymentIds || []).filter(Boolean))];
  const { license } = await locate(store, input.provider, ids);
  if (!license) {
    const tombstone = {
      tombstone: true,
      status: "revoked",
      reason: input.reason,
      refunded: Boolean(input.refunded),
      at: nowIso,
      provider: input.provider,
      payment_id: ids[0] || null,
    };
    for (const id of ids) await store.putTombstone(input.provider, id, tombstone);
    return { action: "revoke_pending" };
  }
  if (input.refunded) license.refunded = true;
  if (license.status === "revoked") {
    license.payment_ids = [...new Set([...(license.payment_ids || []), ...ids])];
    await store.putLicense(license);
    return { action: "already_revoked", license };
  }
  license.status = "revoked";
  license.revoked_at = nowIso;
  license.revoke_reason = input.reason || "revoked";
  license.payment_ids = [...new Set([...(license.payment_ids || []), ...ids])];
  if (input.eventId) license.event_ids = [...(license.event_ids || []), input.eventId].slice(-20);
  await store.putLicense(license);
  if (license.email && !input.silent) {
    try {
      await sendLicenseMail(store, env, deps, license, "revoked");
    } catch (err) {
      if (err.status >= 500) throw err;
    }
  }
  return { action: "revoked", license };
}

export async function reinstatePayments(store, env, deps, input) {
  const ids = [...new Set((input.paymentIds || []).filter(Boolean))];
  const { license } = await locate(store, input.provider, ids);
  if (!license) return { action: "reinstate_missing" };
  if (license.refunded && !input.admin) return { action: "reinstate_blocked", reason: "refunded", license };
  if (license.status === "active") {
    if (license.reinstated_at && !license.reinstate_notice_settled && license.email) {
      const email = await sendLicenseMail(store, env, deps, license, "restored");
      return { action: "already_active", license, email };
    }
    return { action: "already_active", license };
  }
  license.status = "active";
  license.reinstated_at = new Date(deps.now()).toISOString();
  license.reinstate_reason = input.reason || "reinstated";
  license.reinstate_notice_settled = false;
  if (input.admin) license.admin_restored = true;
  license.payment_ids = [...new Set([...(license.payment_ids || []), ...ids])];
  await store.putLicense(license);
  let email = null;
  if (license.email) email = await sendLicenseMail(store, env, deps, license, "restored");
  return { action: "reinstated", license, email };
}

export async function exchangeMagic(store, env, deps, token) {
  const record = await store.takeMagic(token, deps.now());
  if (!record) {
    const err = new Error("invalid_or_expired");
    err.status = 400;
    throw err;
  }
  const account = await store.getAccount(record.account_id);
  if (!account || account.disabled) {
    const err = new Error("account_disabled");
    err.status = 403;
    throw err;
  }
  const session = randomToken("gbs_");
  await store.putSession(session, {
    account_id: account.account_id,
    email: account.email,
    exp: deps.now() + ttlMs(env, "SESSION_TTL_SECONDS", 1209600),
  });
  const licenses = await store.licensesForAccount(account);
  return { session, account: accountPayload(account, licenses) };
}

export async function requestMagicLink(store, env, deps, email, options = {}) {
  const account = await store.findAccountByEmail(email);
  if (!account || account.disabled) return { sent: false };
  if (!options.bypassRate) {
    const hour = Math.floor(deps.now() / 3600000);
    const allowed = await store.bumpRate(`${normalizeEmail(email)}:${hour}`, 5);
    if (!allowed) return { sent: false, limited: true };
  }
  const licenses = await store.licensesForAccount(account);
  const license = licenses.find((item) => item.status === "active") || licenses[0];
  if (!license) return { sent: false };
  const kind = license.status === "active" ? (license.reinstated_at ? "restored" : "receipt") : "revoked";
  await sendLicenseMail(store, env, deps, license, kind);
  return { sent: true };
}

export async function acceptTerms(store, account, nowIso) {
  if (!account.terms_accepted_at) {
    account.terms_accepted_at = nowIso;
    await store.putAccount(account);
  }
  return account;
}

export async function activateLicense(store, body, nowIso) {
  const license = await store.getLicense(body.license_key);
  if (!license) return { status: 404, error: "not_found" };
  if (license.status !== "active") return { status: 403, error: "revoked" };
  const machineId = cleanMachineId(body.machine_id);
  if (!machineId) return { status: 400, error: "invalid_machine_id" };
  if (license.machine_id && license.machine_id !== machineId) return { status: 409, error: "machine_mismatch" };
  if (!license.machine_id) {
    license.machine_id = machineId;
    license.activated_at = nowIso;
    await store.putLicense(license);
  }
  return { status: 200, body: { ok: true, status: "active", machine_id: license.machine_id } };
}

export async function validateLicense(store, body) {
  const license = await store.getLicense(body.license_key);
  if (!license) return { status: 404, error: "not_found" };
  if (license.status !== "active") return { status: 403, error: "revoked" };
  const machineId = cleanMachineId(body.machine_id);
  if (!machineId) return { status: 400, error: "invalid_machine_id" };
  if (!license.machine_id) return { status: 403, error: "not_activated" };
  if (license.machine_id !== machineId) return { status: 403, error: "machine_mismatch" };
  return { status: 200, body: { ok: true, status: "active" } };
}

export async function activeDownloadLicense(store, account) {
  if (!account || account.disabled) return { error: "account_disabled", status: 403 };
  if (!account.terms_accepted_at) return { error: "terms_required", status: 403 };
  const licenses = await store.licensesForAccount(account);
  const active = licenses.find((license) => license.status === "active");
  if (!active) return { error: "download_disabled", status: 403 };
  return { license: active };
}
