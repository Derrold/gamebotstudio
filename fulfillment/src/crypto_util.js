const KEY_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function timingSafeEqualHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  if (left.length !== right.length || left.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}

export function timingSafeEqualBytes(a, b) {
  if (!a || !b || a.length !== b.length || a.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function sha256Equal(a, b) {
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(String(a))),
    crypto.subtle.digest("SHA-256", enc.encode(String(b))),
  ]);
  return timingSafeEqualBytes(new Uint8Array(da), new Uint8Array(db));
}

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

export async function hmacSha256Hex(secret, message) {
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function hmacSha256Bytes(secret, message) {
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return new Uint8Array(sig);
}

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(text)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function randomToken(prefix) {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `${prefix}${bytesToBase64Url(bytes)}`;
}

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function base64UrlToBytes(value) {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((value.length + 3) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function generateLicenseKey(randomBytes = crypto.getRandomValues(new Uint8Array(10))) {
  if (randomBytes.length < 10) throw new Error("short_random");
  let bits = 0;
  let value = 0;
  let chars = "";
  for (const byte of randomBytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5 && chars.length < 16) {
      bits -= 5;
      chars += KEY_ALPHABET[(value >>> bits) & 31];
      value &= (1 << bits) - 1;
    }
  }
  if (chars.length !== 16) throw new Error("short_key");
  return `GB-${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}-${chars.slice(12, 16)}`;
}

export const LICENSE_KEY_RE = /^GB(?:-[0-9A-HJKMNP-TV-Z]{4}){4}$/;

export async function signDownloadToken(secret, licenseKey, expSeconds) {
  const payload = bytesToBase64Url(new TextEncoder().encode(JSON.stringify({ k: licenseKey, exp: expSeconds })));
  const sig = await hmacSha256Bytes(secret, payload);
  return `${payload}.${bytesToBase64Url(sig)}`;
}

export async function readDownloadToken(secret, token) {
  if (!secret || typeof token !== "string" || !token.includes(".")) return null;
  const dot = token.indexOf(".");
  const payload = token.slice(0, dot);
  const sigPart = token.slice(dot + 1);
  if (!payload || !sigPart) return null;
  let provided;
  try {
    provided = base64UrlToBytes(sigPart);
  } catch {
    return null;
  }
  const expected = await hmacSha256Bytes(secret, payload);
  if (!timingSafeEqualBytes(expected, provided)) return null;
  try {
    const body = JSON.parse(new TextDecoder().decode(base64UrlToBytes(payload)));
    if (!body || typeof body.k !== "string" || typeof body.exp !== "number") return null;
    return body;
  } catch {
    return null;
  }
}
