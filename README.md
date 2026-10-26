# gamebotstudio.com: Game Bot landing page

A static single-page site. No build step, no backend.

```
index.html               page with the logo inlined as an SVG <symbol>
styles.css               dark navy / chrome / blue-red theme, mobile responsive
assets/favicon.svg       robot + controller mark (original)
assets/logo.svg          same mark as a standalone file (for socials/README)
CNAME                    gamebotstudio.com (GitHub Pages custom domain)
.nojekyll                serve files as-is on GitHub Pages
BUY-PAGE-COPY.md         store blurbs (itch.io / Lemon Squeezy / Payhip)
DEPLOY-GITHUB-PAGES.md   deploy + Porkbun DNS steps
```

- **Preview locally:** open `index.html` in a browser, or run `python -m http.server 8000` in this folder.
- **Checkout is not live.** Header, hero, pricing, and the “How can I pay?” FAQ say Coming soon and offer a notify email. They do not open Stripe or PayPal.
- **One-line flip:** in `index.html`, change `var BUY_LIVE = false;` to `var BUY_LIVE = true;`. That reveals Pay with card and PayPal, and points those controls at the `CHECKOUT` URLs in the same script (Stripe `https://buy.stripe.com/9B63cu5h60bR39AdtjgUM00`, PayPal `https://www.paypal.com/ncp/payment/UY5FY7UCJPDYG`). Leave it `false` until Derrold turns checkout on.
- **After payment:** a return to `https://gamebotstudio.com/?paid=1` shows a thank-you. The buyer creates or signs in to an account on gamebotstudio.com to download the installer and see their license key. One purchase is one PC. The license is personal and non-transferable, except an approved license transfer. Buyers may not copy, resell, or redistribute the software, playbooks, or Alphamax designs. Games the buyer creates with Game Bot are theirs. Sales are final (digital goods, no refunds). If a payment is disputed, charged back, reversed, or fails to clear, Alphamax Studios / Game Bot may revoke the license key and disable download access. Stripe can redirect to `?paid=1` once checkout is live.
- **Buyer account (not in this site):** do not add login here. The fulfillment portal owns `/account`. When that page exists, link the thank-you and FAQ account lines to `/account`. Until then, the copy names gamebotstudio.com and does not link a missing page.
- **Language:** the current build includes a language/region selector (multi-language UI).
- **Price:** $99 one-time in the `#pricing` section.
- **Logo:** to use the chrome robot PNG instead, put it in `assets/` and replace the `<svg><use href="#gb-logo"/></svg>` tags with `<img>`.
- **Deploy:** see `DEPLOY-GITHUB-PAGES.md`. Any static host also works (Porkbun Static Hosting, Netlify, Cloudflare Pages); just upload the folder with `index.html` at the web root.
