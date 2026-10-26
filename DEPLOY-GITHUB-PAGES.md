# Deploy gamebotstudio.com on GitHub Pages (free)

## 1. Push the site
1. Create a public GitHub repo, e.g. `gamebotstudio-site`.
2. Upload everything in this folder to the repo root: `index.html`, `styles.css`, `assets/`, `CNAME`, `.nojekyll`.
   (CLI: `git init && git add . && git commit -m "Game Bot site" && git branch -M main && git remote add origin https://github.com/<you>/gamebotstudio-site.git && git push -u origin main`)
3. Repo → Settings → Pages → Source: **Deploy from a branch** → Branch `main`, folder `/ (root)` → Save.
4. Custom domain should already read `gamebotstudio.com` (from the CNAME file).

## 2. Point Porkbun DNS at GitHub
Porkbun → Domain Management → gamebotstudio.com → DNS. Delete the default parking ALIAS/A/CNAME records first, then add:

| Type  | Host | Answer |
|-------|------|--------|
| A     | (blank) | 185.199.108.153 |
| A     | (blank) | 185.199.109.153 |
| A     | (blank) | 185.199.110.153 |
| A     | (blank) | 185.199.111.153 |
| AAAA  | (blank) | 2606:50c0:8000::153 |
| AAAA  | (blank) | 2606:50c0:8001::153 |
| AAAA  | (blank) | 2606:50c0:8002::153 |
| AAAA  | (blank) | 2606:50c0:8003::153 |
| CNAME | www  | `<your-github-username>.github.io` |

## 3. HTTPS + verify
- DNS takes minutes to a few hours. When Settings → Pages shows "DNS check successful", tick **Enforce HTTPS** (certificate can take up to ~1 hr).
- Recommended: GitHub → your profile Settings → Pages → **Add a verified domain** → add the TXT record it gives you at Porkbun. Stops anyone else claiming the domain on Pages.
- Check: `nslookup gamebotstudio.com` returns 185.199.108-111.153; https://gamebotstudio.com loads.

## Updating
Edit files, commit and push to `main`. Pages redeploys in about a minute.

## Fulfillment is not part of Pages
Pushing this repo does not issue licenses or accept webhooks. Account delivery is the Cloudflare Worker in `fulfillment/`. It ships **off**. The public pages keep Coming soon until you follow the flip-on list in `fulfillment/README.md`. The account page at `/account/` stays in that Coming soon state while its API base is empty.
