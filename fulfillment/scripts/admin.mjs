#!/usr/bin/env node
const base = (process.env.FULFILLMENT_BASE_URL || "").replace(/\/$/, "");
const token = process.env.ADMIN_TOKEN || "";
const [command, arg, extra] = process.argv.slice(2);

if (!base || token.length < 16) {
  console.error("Set FULFILLMENT_BASE_URL and ADMIN_TOKEN in the environment. Do not pass the token as an argument.");
  process.exit(1);
}

const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

async function call(path, options = {}) {
  const response = await fetch(`${base}${path}`, { ...options, headers: { ...headers, ...options.headers } });
  const text = await response.text();
  console.log(text);
  if (!response.ok) process.exit(1);
}

const usage = `Commands:
  lookup-email buyer@example.com
  lookup-payment stripe pi_123
  revoke GB-XXXX-XXXX-XXXX-XXXX [reason]
  restore GB-XXXX-XXXX-XXXX-XXXX [reason]
  unbind GB-XXXX-XXXX-XXXX-XXXX
  resend buyer@example.com
  disable buyer@example.com [reason]
  enable buyer@example.com`;

if (command === "lookup-email") await call(`/admin/licenses?email=${encodeURIComponent(arg || "")}`);
else if (command === "lookup-payment") await call(`/admin/licenses?provider=${encodeURIComponent(arg || "")}&payment_id=${encodeURIComponent(extra || "")}`);
else if (command === "revoke" || command === "restore" || command === "unbind") {
  await call(`/admin/licenses/${encodeURIComponent(arg || "")}/${command}`, {
    method: "POST",
    body: JSON.stringify({ reason: extra || "admin" }),
  });
} else if (command === "resend") {
  await call("/admin/accounts/resend", { method: "POST", body: JSON.stringify({ email: arg }) });
} else if (command === "disable" || command === "enable") {
  await call(`/admin/accounts/${command}`, { method: "POST", body: JSON.stringify({ email: arg, reason: extra || "admin" }) });
} else {
  console.error(usage);
  process.exit(1);
}
