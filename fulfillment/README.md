# Game Bot account fulfillment

GitHub Pages cannot receive Stripe or PayPal webhooks. This folder is a Cloudflare Worker that creates a buyer account, emails a one-time sign-in link, and serves `GameBot-Setup.exe` only to that signed-in account.

It ships **off**. Verified webhooks are acknowledged and do not create accounts, send mail, or revoke anything until you change `FULFILLMENT_MODE`. Live mode also refuses to fulfill until `PUBLIC_PORTAL_READY=1`.

The public site still says PayPal is coming soon and tells buyers to email alphamaxstudios@gmail.com. `/account/` shows **Coming soon** while its API base is empty. Do not point the public account page at this worker until the flip-on list below is done.

## Buyer flow (once flipped on)

1. Stripe or PayPal reports a paid $99 order.
2. The worker creates an account for the checkout email, or adds the order to the account that email already has.
3. The buyer gets a receipt email: one-time sign-in link, license key, and the account terms. The email does **not** contain a download URL.
4. They open `https://gamebotstudio.com/account#login=…`, land on one page, agree to the terms, and press **Download GameBot-Setup.exe**.
5. They run the installer and enter the license key. The app calls `POST /v1/licenses/activate` and later `POST /v1/licenses/validate`. One key, one PC.
6. A dispute, chargeback, refund, or reversal revokes the key. Validate fails and the account download returns 403.
7. If the dispute is later decided for the seller and the payment was **not** refunded, the key is turned back on and the download works again. A refund is not undone by a later “seller won” event. Support can still restore a key by hand.

Sharing the login, the sign-in link, or the license key is prohibited. Redistributing `GameBot-Setup.exe` or any copy of the installer is prohibited. Those terms are on the account page, in the receipt, and in `BUY-PAGE-COPY.md`.

There is no password. Magic links are the sign-in. There is no public or emailed installer URL. `GET /download` without a session returns 401 even if someone adds `?token=`.

## What is not live

| Switch | Default | Effect |
| --- | --- | --- |
| `FULFILLMENT_MODE` | `off` | `off` skips every payment and dispute. `test` handles Stripe test-mode events and PayPal sandbox only. `live` handles Stripe live events and requires `PAYPAL_ENV=live` for PayPal. |
| `PAYPAL_ENV` | `sandbox` | Sandbox API host and sandbox webhook id. |
| `PUBLIC_PORTAL_READY` | unset | Live fulfillment returns 503 `portal_not_ready` until this is `1`. |
| Account page API base | empty | `account/index.html` shows Coming soon and does not call an API. |

While mode is `off`, the existing Stripe Payment Link can still take money. This worker will not email a sign-in link and will not revoke a key. Support email remains the delivery path until flip-on.

`test` blocks `livemode: true` Stripe events even if the signing secret would verify them. PayPal events are accepted in `test` only when `PAYPAL_ENV=sandbox`, and the signature is checked with the sandbox webhook id. A live PayPal signature does not verify against sandbox credentials.

## Local staging

From the repo root, with a process-local signing secret and admin token (do not reuse them in Cloudflare):

```bash
export STRIPE_WEBHOOK_SECRET="$(openssl rand -hex 24)"
export ADMIN_TOKEN="$(openssl rand -hex 24)"
node fulfillment/scripts/dev-server.mjs
```

Open http://127.0.0.1:8787/account/ . The dev server uses an in-memory store and a **stub file**, not the real installer. `FULFILLMENT_MODE` defaults to `test` only in that local process.

```bash
cd fulfillment && node --test test/
```

## Deploy the worker (still off)

1. `cd fulfillment`
2. `npx --yes wrangler@4 login`
3. `npx --yes wrangler@4 kv namespace create LICENSES`
4. Paste the id into `wrangler.toml` and uncomment the `[[kv_namespaces]]` block. Do not put secrets in that file.
5. Create the private bucket and upload the real installer **from outside the repo**. Do not commit `GameBot-Setup.exe`.

```bash
npx --yes wrangler@4 r2 bucket create gamebot-product
npx --yes wrangler@4 r2 object put gamebot-product/GameBot-Setup.exe --file /absolute/path/GameBot-Setup.exe
```

Uncomment the `[[r2_buckets]]` block. The object key is `GameBot-Setup.exe`. The download response always uses that filename. There is no redirect to a public CDN URL, because a public URL can be copied.

6. Leave `FULFILLMENT_MODE = "off"`. Deploy:

```bash
npx --yes wrangler@4 deploy
```

7. Put secrets with `npx --yes wrangler@4 secret put <NAME>`. Start with **test / sandbox** values.

| Secret | Where it comes from |
| --- | --- |
| `STRIPE_WEBHOOK_SECRET` | Stripe Dashboard → Developers → Webhooks → **Test mode** endpoint signing secret. Optional `STRIPE_WEBHOOK_SECRET_PREVIOUS` while you rotate. |
| `PAYPAL_CLIENT_ID` | PayPal Developer → **Sandbox** → REST app |
| `PAYPAL_CLIENT_SECRET` | Same sandbox app |
| `PAYPAL_WEBHOOK_ID` | The webhook id PayPal assigns when you subscribe the sandbox URL |
| `RESEND_API_KEY` | Resend. Leave unset in test mode to store the email text on the license instead of sending. |
| `EMAIL_FROM` | A sender Resend has verified, such as `Game Bot Studio <licenses@your-verified-domain>` |
| `ADMIN_TOKEN` | `openssl rand -hex 32` |

No Stripe secret key (`sk_`) or restricted key (`rk_`) is required. Fulfillment reads the webhook payload. If you later add an API key, create a restricted key and store it with `wrangler secret put`. Never commit it.

Non-secret vars live in `wrangler.toml`: `FULFILLMENT_MODE`, `PAYPAL_ENV`, `PUBLIC_SITE_URL`, `ALLOWED_ORIGINS`, `EXPECTED_AMOUNT_CENTS` (`9900`), `EXPECTED_CURRENCY` (`usd`), `SUPPORT_EMAIL`, magic-link and session lifetimes. `PUBLIC_PORTAL_READY` is not set there.

Worker URL shape after deploy: `https://gamebot-fulfillment.<account-subdomain>.workers.dev`

Confirm `GET /health` shows `"mode":"off"` and `"portal_ready":false`.

## Webhook URLs to register

Register these while mode is still `off`. Use the **test** Stripe endpoint and the **sandbox** PayPal app first. A valid signature with mode `off` returns HTTP 200 and `"action":"skipped"`. Stripe and PayPal will not retry that delivery. After you turn mode to `test` or `live`, resend the events you care about from each dashboard.

Stripe (snapshot payloads, not thin events):

`https://<worker-host>/webhooks/stripe`

Events:

- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`
- `checkout.session.async_payment_failed`
- `charge.dispute.created`
- `charge.dispute.funds_withdrawn`
- `charge.dispute.closed`
- `charge.dispute.funds_reinstated`
- `charge.refunded`

`payment_intent.succeeded` is handled only as a backup when `receipt_email` is present. Payment Links are fulfilled from the Checkout Session events, and only when `payment_status` is `paid`. Signature check is HMAC-SHA256 over `timestamp.rawBody`, `v1` only, 5-minute window. `v0` signatures are ignored.

PayPal sandbox, then later the live app:

`https://<worker-host>/webhooks/paypal`

Events:

- `PAYMENT.CAPTURE.COMPLETED`
- `PAYMENT.CAPTURE.REFUNDED`
- `PAYMENT.CAPTURE.REVERSED`
- `CUSTOMER.DISPUTE.CREATED`
- `CUSTOMER.DISPUTE.RESOLVED`

`CHECKOUT.ORDER.COMPLETED` is accepted if PayPal sends it, but PayPal documents that event for marketplaces. Subscribe to `PAYMENT.CAPTURE.COMPLETED` for the no-code payment link. Verification uses PayPal’s CRC32 message (`transmissionId|transmissionTime|webhookId|crc32`) and the certificate from `paypal-cert-url`. Certificate hosts are limited to PayPal’s API hosts.

The PayPal capture sample does not include the buyer email. This worker loads `GET /v2/checkout/orders/{order_id}` when `supplementary_data.related_ids.order_id` is present. **Hypothesis:** the no-code link `https://www.paypal.com/ncp/payment/UY5FY7UCJPDYG` emits `PAYMENT.CAPTURE.COMPLETED` with that order id. Confirm it in sandbox. If the order id or payer email is missing, the worker records a review and does not invent an account.

Amount must be 9900 USD cents unless you set `ALLOW_AMOUNT_MISMATCH=1`. A different amount is stored for support and is not fulfilled. That matters if tax is added later and the total is no longer exactly $99.

## Test mode (do this before live)

1. Secrets above are sandbox / Stripe test mode.
2. `npx --yes wrangler@4 secret put` is already done.
3. Change the var and redeploy: `FULFILLMENT_MODE=test`, `PAYPAL_ENV=sandbox`. Keep `PUBLIC_PORTAL_READY` unset.
4. Point the **local** account page at the worker only if you are testing on your machine. The dev server does that by itself. Do not fill `gamebot-api-base` on the public site yet.
5. Stripe test card `4242 4242 4242 4242` on a test Payment Link, or the Stripe CLI `stripe trigger` / resend. PayPal: a sandbox buyer on a sandbox payment link, not the live `UY5FY7UCJPDYG` link.
6. Admin lookup (token from the environment, never as a shell argument you then commit):

```bash
export FULFILLMENT_BASE_URL="https://<worker-host>"
export ADMIN_TOKEN="..."
node fulfillment/scripts/admin.mjs lookup-email buyer@example.com
```

In test mode with no Resend key, `last_email.text` is the receipt preview, including the sign-in link.

7. Open the sign-in link against a host that can reach the API (the dev server, or a temporary API base you do not ship on `main`). Agree to the terms. Download must be `GameBot-Setup.exe` and must require the session.
8. In the Stripe test dashboard, create a dispute (or resend `charge.dispute.created`). Download and `validate` must fail. Close it **won**. Download and `validate` must work again.
9. Refund a different test payment, then close a dispute as won. The license must stay revoked.

`node fulfillment/scripts/admin.mjs` also supports `lookup-payment`, `revoke`, `restore`, `unbind`, `resend`, `disable`, and `enable`.

## Flip on (live)

Do these in order. Stop if a step is not true.

1. Sandbox tests above passed, including revoke and seller-won restore.
2. The real `GameBot-Setup.exe` is the only object at `gamebot-product/GameBot-Setup.exe` in R2. A signed-in download returns that file, with `content-disposition: attachment; filename="GameBot-Setup.exe"`.
3. Resend can send from `EMAIL_FROM`. Send one sandbox receipt to an inbox you control and open the sign-in link.
4. Edit `account/index.html` and set the meta tag to the worker origin:

```html
<meta name="gamebot-api-base" content="https://<worker-host>">
```

`ALLOWED_ORIGINS` must include `https://gamebotstudio.com` (that is already the default). Deploy Pages (push `main`) **after** the worker is ready, or the sign-in link lands on Coming soon and does not consume the token.

5. Optionally map `api.gamebotstudio.com` to the worker in Cloudflare and use that host in the meta tag. Cookies are optional. The page keeps the session token from the magic-link response and sends `Authorization: Bearer`.
6. Create a **live** Stripe webhook on the same path and events. Replace `STRIPE_WEBHOOK_SECRET` with the live `whsec_` value. Leave the test endpoint in place only if you still want a separate test worker.
7. Create a **live** PayPal webhook on the live REST app. Replace `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, and `PAYPAL_WEBHOOK_ID`. Set `PAYPAL_ENV=live` and redeploy.
8. Set `FULFILLMENT_MODE=live` and `PUBLIC_PORTAL_READY=1`. Redeploy. `GET /health` must show `"mode":"live"` and `"portal_ready":true`.
9. Resend any test-mode events you do **not** want fulfilled; live mode ignores `livemode: false`. Resend live events that arrived while the endpoint was `off` or not ready. Those were acknowledged and will not retry by themselves.
10. Update the public thank-you and the “not turned on yet” FAQ in a follow-up so buyers are not told to email for a download the account already performs. Until that copy change, the receipt email is still the way into the account.
11. Watch one real $99 payment end to end before announcing it: email arrives, account shows the key, download is the real installer, a made-up machine id can activate once.

`PUBLIC_PORTAL_READY` is the live flag on top of `FULFILLMENT_MODE=live`. Both are required. PayPal also needs `PAYPAL_ENV=live`.

## Admin

```bash
node fulfillment/scripts/admin.mjs lookup-email buyer@example.com
node fulfillment/scripts/admin.mjs lookup-payment stripe pi_123
node fulfillment/scripts/admin.mjs revoke GB-2345-6789-ABCD-EFGH "support"
node fulfillment/scripts/admin.mjs restore GB-2345-6789-ABCD-EFGH "dispute won"
node fulfillment/scripts/admin.mjs unbind GB-2345-6789-ABCD-EFGH
node fulfillment/scripts/admin.mjs resend buyer@example.com
node fulfillment/scripts/admin.mjs disable buyer@example.com "shared login"
```

`disable` turns off every download for that account even if a license is active. `restore` can turn a license back on after a refund; automatic dispute handling will not.

## License API

See `LICENSE_API.md`. Activate and validate are unauthenticated on purpose: the license key is the credential. Download is not. Revoked keys return `403` `revoked`.

## Gaps the owner still has to close

This agent cannot see the Alphamax Stripe account or the PayPal app, and it did not create webhook endpoints or paste signing secrets.

- Paste `STRIPE_WEBHOOK_SECRET` from the Dashboard. Test mode first, then a different live secret at flip-on.
- Paste sandbox, then live, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, and `PAYPAL_WEBHOOK_ID`.
- Confirm in sandbox that the no-code PayPal link emits `PAYMENT.CAPTURE.COMPLETED` and that the order lookup returns `payer.email_address`. PayPal’s own capture sample has the payee email, not the buyer. **Hypothesis** until that sandbox payment is watched.
- PayPal dispute ids: reinstatement matches `disputed_transactions[].seller_transaction_id` to the capture id. Confirm that field on a sandbox dispute.
- PayPal docs use both `RESOLVED_SELLER_FAVOUR` and `RESOLVED_SELLER_FAVOR`. Both restore access. `CANCELED_BY_BUYER` restores access. `RESOLVED_BUYER_FAVOUR` / `RESOLVED_BUYER_FAVOR` stay revoked. `RESOLVED_WITH_PAYOUT` does **not** auto-restore, because PayPal describes that outcome as protection for the merchant **or** the customer. Use admin restore if a sandbox seller-win arrives as `RESOLVED_WITH_PAYOUT`.
- Upload the real installer to R2. It is not in this repo. Until the bucket binding exists, a signed-in download returns 503 `artifact_not_configured`.
- Verify a Resend domain and set `RESEND_API_KEY` plus `EMAIL_FROM`. Test mode without them keeps a preview on the license. Live mode returns 500 `email_not_configured` so the webhook retries instead of dropping the order.
- Generate `ADMIN_TOKEN` locally. None is baked into the worker.
- Set the account page API base and `PUBLIC_PORTAL_READY=1` only in the flip-on list. Doing one without the other either emails a link the public page cannot open, or opens a page with no worker.
- Workers KV is eventually consistent. Two deliveries of the same new payment in the same moment could create two keys. Volume for a single $99 product makes that unlikely. Admin lookup by email shows both if it ever happens.
- The magic-link rate limit is a KV counter, so it is also eventually consistent.
- A seller win does not undo a refund.
- Clearing a PC binding is the admin `unbind` command, not a button on the account page.
- Webhook IP allowlists are not enforced in the worker. Signature checks are the control.
- Open PR #6 adds PayPal buttons and removes “PayPal coming soon.” This change keeps that Coming soon line. If both land, decide whether the public page should keep saying PayPal is coming soon.
