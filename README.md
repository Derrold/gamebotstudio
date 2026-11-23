# gamebotstudio.com: Game Bot landing page

A static single-page site. No build step, no backend.

```
index.html               page with the logo inlined as an SVG <symbol>
styles.css               dark navy / chrome / blue-red theme, mobile responsive
assets/favicon.svg       robot + controller mark (original)
assets/logo.svg          same mark as a standalone file (for socials/README)
CNAME                    gamebotstudio.com (GitHub Pages custom domain)
.nojekyll                serve files as-is on GitHub Pages
eula.html                Game Bot EULA (effective November 13, 2026)
privacy.html             Privacy policy (effective November 13, 2026)
BUY-PAGE-COPY.md         store blurbs (itch.io / Lemon Squeezy / Payhip)
DEPLOY-GITHUB-PAGES.md   deploy + Porkbun DNS steps
```

- **Preview locally:** open `index.html` in a browser, or run `python -m http.server 8000` in this folder.
- **Legal pages:** `eula.html` and `privacy.html` are effective November 13, 2026. Footer and pricing link to them.
- **Checkout is live (Nov 23 2026).** One purchase button only: “Buy with Stripe” in the Pricing section (opens the $99 Stripe Payment Link). No waitlist, no PayPal. The hero has only a centered “See how it works” button. After payment the success view shows the license key, the Setup download and the key-gated built-in AI model download.
- **One-line flip:** in `index.html`, change `var BUY_LIVE = false;` to `var BUY_LIVE = true;`. That reveals Pay with card and points it at the Stripe `CHECKOUT` URL in the same script (`https://buy.stripe.com/9B63cu5h60bR39AdtjgUM00`). Stripe must redirect to `https://gamebotstudio.com/?paid=1&session_id={CHECKOUT_SESSION_ID}`; the page then calls the license server (`https://gamebot-licenses.alphamaxstudios.workers.dev/v1/claim`) and shows the buyer's key and download link. Leave it `false` until Derrold turns checkout on.
- **After payment:** the return page shows the buyer's license key and a private download link from the license server. One purchase is one PC. The license is personal and non-transferable, except an approved license transfer. Buyers may not copy, resell, or redistribute the software, playbooks, or Alphamax designs. Games the buyer creates with Game Bot are theirs. Sales are final (digital goods, no refunds). If a payment is disputed, charged back, reversed, or fails to clear, Alphamax Studios / Game Bot may revoke the license key and disable download access. 
- **Buyer account (not in this site):** do not add login here. The fulfillment portal owns `/account`. When that page exists, link the thank-you and FAQ account lines to `/account`. Until then, the copy names gamebotstudio.com and does not link a missing page.
- **Videos:** the homepage `#watch` section (right after the hero) embeds the public YouTube intro and walkthrough with lazy-loaded `youtube-nocookie` iframes. No price in the captions.
- **Language:** the current build includes a language/region selector (multi-language UI).
- **Price:** $99 one-time in the `#pricing` section.
- **Logo:** to use the chrome robot PNG instead, put it in `assets/` and replace the `<svg><use href="#gb-logo"/></svg>` tags with `<img>`.
- **Deploy:** see `DEPLOY-GITHUB-PAGES.md`. Any static host also works (Porkbun Static Hosting, Netlify, Cloudflare Pages); just upload the folder with `index.html` at the web root.
