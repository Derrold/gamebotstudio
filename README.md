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
- **Checkout:** the Buy buttons open the live Stripe Payment Link (`https://buy.stripe.com/9B63cu5h60bR39AdtjgUM00`) in a new tab. Card (Stripe) is available now. PayPal is listed as coming soon until a real PayPal link exists. Support stays `mailto:alphamaxstudios@gmail.com`.
- **After payment:** Stripe redirects to `https://gamebotstudio.com/?paid=1`. A short script on the page shows a thank-you and tells the buyer to email alphamaxstudios@gmail.com for download instructions. One PC, all sales final.
- **Price:** $99 one-time in the `#pricing` section.
- **Logo:** to use the chrome robot PNG instead, put it in `assets/` and replace the `<svg><use href="#gb-logo"/></svg>` tags with `<img>`.
- **Deploy:** see `DEPLOY-GITHUB-PAGES.md`. Any static host also works (Porkbun Static Hosting, Netlify, Cloudflare Pages); just upload the folder with `index.html` at the web root.
