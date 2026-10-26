import { fulfillmentMode } from "./mode.js";
import { termsPlainText } from "./terms.js";

export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function moneyLine(cents, currency) {
  if (!Number.isInteger(cents)) return "Game Bot";
  return `Game Bot — ${String(currency || "usd").toUpperCase()} ${(cents / 100).toFixed(2)}`;
}

export function magicLink(env, token) {
  const site = String(env.PUBLIC_SITE_URL || "https://gamebotstudio.com").replace(/\/$/, "");
  return `${site}/account#login=${encodeURIComponent(token)}`;
}

function wrap({ subject, intro, link, licenseKey, extra }) {
  const support = "alphamaxstudios@gmail.com";
  const text = [
    intro,
    "",
    "Sign in to your account (this link works once):",
    link,
    "",
    `License key: ${licenseKey}`,
    "",
    "On the account page, download GameBot-Setup.exe, run it, and enter the license key.",
    "The download stays on the account page. It is not a public link.",
    extra,
    "",
    termsPlainText(),
    "",
    `Support: ${support}`,
  ].filter((line) => line !== undefined && line !== null).join("\n");

  const html = `<!doctype html><html><body style="font-family:sans-serif;line-height:1.5;color:#10203f">
<p>${escapeHtml(intro)}</p>
<p><a href="${escapeHtml(link)}">Sign in to your Game Bot account</a></p>
<p>License key:<br><strong style="font-family:ui-monospace,monospace;font-size:1.15rem">${escapeHtml(licenseKey)}</strong></p>
<p>On the account page, download GameBot-Setup.exe, run it, and enter the license key. The download is only available while you are signed in.</p>
${extra ? `<p>${escapeHtml(extra)}</p>` : ""}
<p style="white-space:pre-wrap">${escapeHtml(termsPlainText())}</p>
<p>Support: <a href="mailto:${support}">${support}</a></p>
</body></html>`;
  return { subject, text, html };
}

export function renderReceipt({ env, token, license }) {
  return wrap({
    subject: "Your Game Bot receipt and sign-in link",
    intro: `Thank you for buying ${moneyLine(license.amount_cents, license.currency)}.`,
    link: magicLink(env, token),
    licenseKey: license.license_key,
    extra: "This sign-in link expires in 24 hours. From the account page you can email yourself a new one.",
  });
}

export function renderRevokedNotice({ env, token, license }) {
  return wrap({
    subject: "Game Bot access is disabled",
    intro: "This payment was disputed, refunded, or reversed before delivery finished.",
    link: magicLink(env, token),
    licenseKey: license.license_key,
    extra: "The account page will show access disabled. The installer download is turned off and the license will not activate.",
  });
}

export function renderRestored({ env, token, license }) {
  return wrap({
    subject: "Your Game Bot download is back on",
    intro: "The dispute was decided in our favor, so the license is active again.",
    link: magicLink(env, token),
    licenseKey: license.license_key,
    extra: "Sign in to download GameBot-Setup.exe. A refunded payment is not turned back on automatically.",
  });
}

export async function deliverEmail(env, deps, message, to) {
  const mode = fulfillmentMode(env);
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) {
    if (mode === "live") {
      const err = new Error("email_not_configured");
      err.status = 500;
      throw err;
    }
    return { delivery: "preview", preview: { subject: message.subject, text: message.text } };
  }
  const response = await deps.fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: env.EMAIL_FROM,
      to: [to],
      reply_to: env.SUPPORT_EMAIL || "alphamaxstudios@gmail.com",
      subject: message.subject,
      text: message.text,
      html: message.html,
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) {
    console.log(JSON.stringify({ msg: "fulfillment", error: "email_send_failed", status: response.status }));
    const err = new Error("email_send_failed");
    err.status = 502;
    throw err;
  }
  return { delivery: "resend", preview: null };
}
