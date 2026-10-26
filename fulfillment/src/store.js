import { sha256Hex } from "./crypto_util.js";
import { normalizeEmail } from "./email_address.js";

function parse(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function createStore(kv) {
  if (!kv) return null;

  async function getLicense(key) {
    return parse(await kv.get(`lic:${key}`));
  }

  async function putLicense(license) {
    await kv.put(`lic:${license.license_key}`, JSON.stringify(license));
    const ids = license.payment_ids?.length ? license.payment_ids : [license.payment_id];
    for (const id of ids) {
      if (id) await kv.put(`pay:${license.provider}:${id}`, license.license_key);
    }
    const email = normalizeEmail(license.email);
    if (email) {
      const indexKey = `email:${email}`;
      const current = parse(await kv.get(indexKey)) || [];
      if (!current.includes(license.license_key)) current.push(license.license_key);
      await kv.put(indexKey, JSON.stringify(current));
    }
    if (license.account_id) {
      const account = parse(await kv.get(`acct:${license.account_id}`));
      if (account) {
        const keys = account.license_keys || [];
        if (!keys.includes(license.license_key)) keys.push(license.license_key);
        account.license_keys = keys;
        await kv.put(`acct:${account.account_id}`, JSON.stringify(account));
      }
    }
  }

  async function findByPayment(provider, paymentId) {
    if (!paymentId) return null;
    const raw = await kv.get(`pay:${provider}:${paymentId}`);
    if (!raw) return null;
    if (raw.startsWith("GB-")) return getLicense(raw);
    return parse(raw);
  }

  async function putTombstone(provider, paymentId, tombstone) {
    if (!paymentId) return;
    const existing = await kv.get(`pay:${provider}:${paymentId}`);
    if (existing && existing.startsWith("GB-")) return;
    await kv.put(`pay:${provider}:${paymentId}`, JSON.stringify(tombstone));
  }

  async function getAccount(accountId) {
    return parse(await kv.get(`acct:${accountId}`));
  }

  async function putAccount(account) {
    await kv.put(`acct:${account.account_id}`, JSON.stringify(account));
    const email = normalizeEmail(account.email);
    if (email) await kv.put(`acctemail:${email}`, account.account_id);
  }

  async function findAccountByEmail(email) {
    const emailKey = normalizeEmail(email);
    if (!emailKey) return null;
    const accountId = await kv.get(`acctemail:${emailKey}`);
    if (!accountId) return null;
    return getAccount(accountId);
  }

  async function licensesForAccount(account) {
    const keys = account?.license_keys || [];
    const licenses = [];
    for (const key of keys) {
      const license = await getLicense(key);
      if (license) licenses.push(license);
    }
    return licenses;
  }

  async function licensesForEmail(email) {
    const emailKey = normalizeEmail(email);
    if (!emailKey) return [];
    const keys = parse(await kv.get(`email:${emailKey}`)) || [];
    const licenses = [];
    for (const key of keys) {
      const license = await getLicense(key);
      if (license) licenses.push(license);
    }
    return licenses;
  }

  async function putMagic(token, record) {
    const digest = await sha256Hex(token);
    await kv.put(`magic:${digest}`, JSON.stringify(record));
  }

  async function takeMagic(token, now) {
    const digest = await sha256Hex(token);
    const key = `magic:${digest}`;
    const record = parse(await kv.get(key));
    if (!record) return null;
    await kv.delete(key);
    if (record.exp <= now) return null;
    return record;
  }

  async function putSession(token, record) {
    const digest = await sha256Hex(token);
    await kv.put(`sess:${digest}`, JSON.stringify(record));
  }

  async function getSession(token, now) {
    if (!token) return null;
    const digest = await sha256Hex(token);
    const record = parse(await kv.get(`sess:${digest}`));
    if (!record || record.exp <= now) return null;
    return record;
  }

  async function deleteSession(token) {
    if (!token) return;
    const digest = await sha256Hex(token);
    await kv.delete(`sess:${digest}`);
  }

  async function putReview(provider, paymentId, review) {
    if (!paymentId) return;
    await kv.put(`review:${provider}:${paymentId}`, JSON.stringify(review));
  }

  async function getReview(provider, paymentId) {
    return parse(await kv.get(`review:${provider}:${paymentId}`));
  }

  async function bumpRate(bucket, limit) {
    const key = `rate:${bucket}`;
    const current = Number(await kv.get(key)) || 0;
    if (current >= limit) return false;
    await kv.put(key, String(current + 1));
    return true;
  }

  return {
    getLicense,
    putLicense,
    findByPayment,
    putTombstone,
    getAccount,
    putAccount,
    findAccountByEmail,
    licensesForAccount,
    licensesForEmail,
    putMagic,
    takeMagic,
    putSession,
    getSession,
    deleteSession,
    putReview,
    getReview,
    bumpRate,
  };
}
