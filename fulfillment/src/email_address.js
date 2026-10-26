export function cleanEmail(value) {
  if (typeof value !== "string") return null;
  const email = value.trim();
  if (!email || email.length > 254 || /[\r\n\s]/.test(email)) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

export function normalizeEmail(email) {
  return email ? email.toLowerCase() : null;
}
