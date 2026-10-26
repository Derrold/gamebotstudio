#!/usr/bin/env node
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { handleRequest } from "../src/http.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const port = Number(process.env.PORT || 8787);
const stripeSecret = process.env.STRIPE_WEBHOOK_SECRET;
const adminToken = process.env.ADMIN_TOKEN;

if (!stripeSecret || !adminToken || adminToken.length < 16) {
  console.error("Set STRIPE_WEBHOOK_SECRET and ADMIN_TOKEN (16+ chars) for this local process only.");
  process.exit(1);
}

const kv = new Map();
const memoryKv = {
  async get(key) { return kv.has(key) ? kv.get(key) : null; },
  async put(key, value) { kv.set(key, String(value)); },
  async delete(key) { kv.delete(key); },
};
const stub = new TextEncoder().encode("LOCAL STAGING STUB — not the Game Bot installer.\n");
const env = {
  FULFILLMENT_MODE: process.env.FULFILLMENT_MODE || "test",
  PAYPAL_ENV: process.env.PAYPAL_ENV || "sandbox",
  PAYPAL_WEBHOOK_ID: process.env.PAYPAL_WEBHOOK_ID || "",
  PUBLIC_SITE_URL: process.env.PUBLIC_SITE_URL || `http://127.0.0.1:${port}`,
  ALLOWED_ORIGINS: `http://127.0.0.1:${port},http://localhost:${port}`,
  SUPPORT_EMAIL: "alphamaxstudios@gmail.com",
  STRIPE_WEBHOOK_SECRET: stripeSecret,
  ADMIN_TOKEN: adminToken,
  EXPECTED_AMOUNT_CENTS: "9900",
  EXPECTED_CURRENCY: "usd",
  LICENSES: memoryKv,
  PRODUCT_BUCKET: {
    async get(key) {
      if (key !== (process.env.PRODUCT_OBJECT_KEY || "GameBot-Setup.exe")) return null;
      return { body: stub };
    },
  },
  ARTIFACT_STUB: "1",
  PUBLIC_PORTAL_READY: process.env.PUBLIC_PORTAL_READY || "",
};

const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".mp4": "video/mp4",
};

function isApi(pathname) {
  return ["/health", "/download", "/webhooks/", "/v1/", "/auth/", "/admin/", "/account/me", "/account/terms"]
    .some((prefix) => pathname === prefix || (prefix.endsWith("/") && pathname.startsWith(prefix)));
}

function staticPath(pathname) {
  let rel = pathname.replace(/^\/+/, "");
  if (rel === "" || rel.endsWith("/")) rel += "index.html";
  if (rel === "account") rel = "account/index.html";
  const file = normalize(join(root, rel));
  if (file !== root && !file.startsWith(root.endsWith(sep) ? root : root + sep)) return null;
  return file;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  if (url.pathname === "/account") {
    res.writeHead(302, { location: "/account/" });
    res.end();
    return;
  }
  if (!isApi(url.pathname)) {
    const file = staticPath(url.pathname);
    try {
      const body = await readFile(file);
      res.writeHead(200, { "content-type": types[extname(file)] || "application/octet-stream", "cache-control": "no-store" });
      res.end(body);
    } catch {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Not found");
    }
    return;
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const request = new Request(url, { method: req.method, headers: req.headers, body: req.method === "GET" || req.method === "HEAD" ? undefined : Buffer.concat(chunks) });
  const response = await handleRequest(request, env);
  const headers = Object.fromEntries(response.headers.entries());
  res.writeHead(response.status, headers);
  res.end(Buffer.from(await response.arrayBuffer()));
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Local staging only. FULFILLMENT_MODE=${env.FULFILLMENT_MODE}. Stub installer, not the product.`);
  console.log(`http://127.0.0.1:${port}/account/`);
});
