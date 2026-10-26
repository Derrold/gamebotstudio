# Game Bot license API

The Windows app calls this API on the fulfillment worker. The host is the worker origin (for example `https://gamebot-fulfillment.<account>.workers.dev` or `https://api.gamebotstudio.com` after DNS). It is not served by GitHub Pages.

Send JSON. `machine_id` is a stable id for that PC, 8 to 128 characters from `A-Z a-z 0-9 . _ : -`. Hash a shorter fingerprint so it meets the minimum length.

Keys look like `GB-2345-6789-ABCD-EFGH`. That value is a shape example, not a working key.

## Activate

`POST /v1/licenses/activate`

```json
{ "license_key": "GB-2345-6789-ABCD-EFGH", "machine_id": "win-4f3a9c2b8e1d4a67" }
```

First call on an active key binds `machine_id` and returns:

```json
{ "ok": true, "status": "active", "machine_id": "win-4f3a9c2b8e1d4a67" }
```

The same PC can activate again. A different PC gets `409`:

```json
{ "ok": false, "error": "machine_mismatch" }
```

## Validate

`POST /v1/licenses/validate`

```json
{ "license_key": "GB-2345-6789-ABCD-EFGH", "machine_id": "win-4f3a9c2b8e1d4a67" }
```

Active and bound to this PC:

```json
{ "ok": true, "status": "active" }
```

Any other result means the product stays locked. Revoked keys fail validation:

```json
{ "ok": false, "error": "revoked" }
```

| HTTP | `error` | Meaning |
| --- | --- | --- |
| 400 | `invalid_request` | Key is not the `GB-` shape |
| 400 | `invalid_machine_id` | Missing or not 8–128 allowed characters |
| 403 | `not_activated` | Validate before a successful activate |
| 403 | `machine_mismatch` | Key is bound to a different PC |
| 403 | `revoked` | Dispute, refund, reversal, or support revoke |
| 404 | `not_found` | Unknown key |

Treat every non-ok response as locked. A dispute, chargeback, refund, or reversal sets the key to revoked. If that dispute is later decided for the seller and the payment was not refunded, the key becomes active again and validate succeeds for the same PC.

Moving a PC is not self-serve. Support clears the binding with the admin unbind command, or the buyer needs a new purchase.
