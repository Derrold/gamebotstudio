export const TERMS_PARAGRAPHS = [
  "Game Bot is licensed for one PC. One purchase binds to the computer you activate it on.",
  "Do not share your login, magic sign-in link, or license key. Do not redistribute GameBot-Setup.exe or any copy of the installer.",
  "The installer download works only while you are signed in and the license is active. A dispute, chargeback, refund, or reversal revokes the license and disables the download. If a dispute is decided in our favor and the payment was not refunded, access is turned back on.",
  "All sales are final. No refunds.",
];

export function termsPlainText() {
  return TERMS_PARAGRAPHS.join("\n\n");
}
