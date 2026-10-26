export function moneyToCents(value) {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  const text = String(value ?? "").trim();
  const match = text.match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!match) return null;
  const whole = Number(match[1]);
  const fraction = Number((match[2] || "").padEnd(2, "0"));
  if (!Number.isSafeInteger(whole) || !Number.isSafeInteger(fraction)) return null;
  return whole * 100 + fraction;
}

export function amountAccepted(cents, currency, env) {
  if (String(env.ALLOW_AMOUNT_MISMATCH || "") === "1") return true;
  const expected = Number(env.EXPECTED_AMOUNT_CENTS || 9900);
  const expectedCurrency = String(env.EXPECTED_CURRENCY || "usd").toLowerCase();
  return cents === expected && String(currency || "").toLowerCase() === expectedCurrency;
}
