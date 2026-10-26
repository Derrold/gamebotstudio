export function fulfillmentMode(env) {
  const mode = String(env?.FULFILLMENT_MODE || "off").trim().toLowerCase();
  if (mode === "test" || mode === "live") return mode;
  return "off";
}

export function stripeAllowed(env, livemode) {
  const mode = fulfillmentMode(env);
  if (mode === "off") return { ok: false, reason: "fulfillment_disabled" };
  if (mode === "test" && livemode) return { ok: false, reason: "live_event_blocked_in_test" };
  if (mode === "live" && !livemode) return { ok: false, reason: "test_event_blocked_in_live" };
  return { ok: true };
}

export function paypalAllowed(env) {
  const mode = fulfillmentMode(env);
  const paypalEnv = String(env?.PAYPAL_ENV || "sandbox").trim().toLowerCase();
  if (mode === "off") return { ok: false, reason: "fulfillment_disabled" };
  if (mode === "test" && paypalEnv !== "sandbox") return { ok: false, reason: "paypal_env_not_sandbox" };
  if (mode === "live" && paypalEnv !== "live") return { ok: false, reason: "paypal_not_live" };
  return { ok: true };
}
