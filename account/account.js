const coming = document.querySelector("#coming");
const gate = document.querySelector("#gate");
const portal = document.querySelector("#portal");
const alertBox = document.querySelector("#alert");
const ordersEl = document.querySelector("#orders");
const downloadBtn = document.querySelector("#download");
const agreeBtn = document.querySelector("#agree");
const steps = document.querySelector("#steps");
const stubNote = document.querySelector("#stub-note");
const SESSION_KEY = "gb_session";

function apiBase() {
  const configured = document.querySelector('meta[name="gamebot-api-base"]')?.content?.trim() || "";
  if (configured) return configured.replace(/\/$/, "");
  const host = location.hostname;
  if (host === "localhost" || host === "127.0.0.1") return location.origin;
  return "";
}

const api = apiBase();

function showAlert(message) {
  if (!message) {
    alertBox.hidden = true;
    alertBox.textContent = "";
    return;
  }
  alertBox.hidden = false;
  alertBox.textContent = message;
}

function messageFor(code) {
  const messages = {
    terms_required: "Agree to the account terms to enable the download.",
    download_disabled: "Access is disabled. The license was revoked, so the download is off.",
    account_disabled: "Access is disabled for this account.",
    artifact_not_configured: "The installer file is not attached yet. Email alphamaxstudios@gmail.com.",
    artifact_missing: "The installer file is not attached yet. Email alphamaxstudios@gmail.com.",
    invalid_or_expired: "This sign-in link is invalid or already used. Request a new one below.",
    sign_in_required: "Sign in again from the link in your email.",
  };
  return messages[code] || "Something went wrong. Email alphamaxstudios@gmail.com.";
}

function authHeaders() {
  return { authorization: `Bearer ${sessionStorage.getItem(SESSION_KEY)}`, "content-type": "application/json" };
}

function renderAccount(account) {
  coming.hidden = true;
  gate.hidden = true;
  portal.hidden = false;
  document.querySelector("#who").textContent = account.email;
  ordersEl.replaceChildren();
  const disabled = !account.orders.some((order) => order.status === "active");
  steps.hidden = disabled;
  for (const order of account.orders) {
    const card = document.createElement("article");
    card.className = order.status === "active" ? "order" : "order revoked";
    const title = document.createElement("h3");
    title.textContent = order.status === "active" ? "License active" : "Access disabled";
    const label = document.createElement("p");
    label.textContent = order.status_label;
    const key = document.createElement("p");
    key.className = "key";
    key.textContent = order.license_key;
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "copy";
    copy.textContent = "Copy license key";
    copy.addEventListener("click", () => navigator.clipboard?.writeText(order.license_key));
    const machine = document.createElement("p");
    machine.className = "note";
    machine.textContent = order.machine_id ? `Bound to one PC: ${order.machine_id}` : "Not activated yet. One PC after you enter the key.";
    card.append(title, label, key, copy, machine);
    ordersEl.append(card);
  }
  const needsTerms = !account.terms_accepted;
  agreeBtn.hidden = disabled || !needsTerms;
  downloadBtn.hidden = disabled || !account.download_available;
  downloadBtn.disabled = !account.download_available;
  downloadBtn.textContent = "Download GameBot-Setup.exe";
}

async function refresh() {
  const response = await fetch(`${api}/account/me`, { headers: authHeaders() });
  if (response.status === 401) {
    sessionStorage.removeItem(SESSION_KEY);
    showSignedOut();
    return null;
  }
  const body = await response.json();
  if (!response.ok) {
    showAlert(messageFor(body.error));
    return null;
  }
  renderAccount(body.account);
  return body.account;
}

function showSignedOut() {
  if (!api) return;
  coming.hidden = true;
  portal.hidden = true;
  gate.hidden = false;
}

async function exchange(token) {
  const response = await fetch(`${api}/auth/magic`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  const body = await response.json().catch(() => ({}));
  history.replaceState(null, "", `${location.pathname}${location.search}`);
  if (!response.ok) {
    showSignedOut();
    showAlert(messageFor(body.error || "invalid_or_expired"));
    return;
  }
  sessionStorage.setItem(SESSION_KEY, body.session_token);
  showAlert("");
  renderAccount(body.account);
}

downloadBtn.addEventListener("click", async () => {
  showAlert("");
  downloadBtn.disabled = true;
  try {
    const response = await fetch(`${api}/download`, { headers: authHeaders() });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      showAlert(messageFor(body.error));
      downloadBtn.disabled = false;
      return;
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "GameBot-Setup.exe";
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    if (response.headers.get("x-gamebot-artifact") === "stub") {
      stubNote.hidden = false;
      stubNote.textContent = "Local staging sent a stub file, not the real installer.";
    }
  } finally {
    if (sessionStorage.getItem(SESSION_KEY)) downloadBtn.disabled = false;
  }
});

agreeBtn.addEventListener("click", async () => {
  const response = await fetch(`${api}/account/terms`, { method: "POST", headers: authHeaders() });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    showAlert(messageFor(body.error));
    return;
  }
  renderAccount(body.account);
});

document.querySelector("#logout").addEventListener("click", async () => {
  await fetch(`${api}/auth/logout`, { method: "POST", headers: authHeaders() }).catch(() => {});
  sessionStorage.removeItem(SESSION_KEY);
  showAlert("");
  showSignedOut();
});

document.querySelector("#resend").addEventListener("submit", async (event) => {
  event.preventDefault();
  const email = new FormData(event.target).get("email");
  await fetch(`${api}/auth/magic/request`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
  document.querySelector("#gate-msg").textContent = "If that email has a Game Bot purchase, we sent a new sign-in link.";
});

if (!api) {
  coming.hidden = false;
} else if (location.hash.includes("login=")) {
  const token = new URLSearchParams(location.hash.replace(/^#/, "")).get("login");
  exchange(token);
} else if (sessionStorage.getItem(SESSION_KEY)) {
  refresh();
} else {
  showSignedOut();
}
