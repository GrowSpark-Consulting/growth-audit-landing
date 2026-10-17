# Grow Spark – Business Growth Audit (Next.js)

Next.js (App Router, TypeScript strict) conversion of the static landing page in `assets/`.
Target: <https://growthaudit.growsparkconsulting.com>

`assets/` holds the original HTML/VCF/logo as **read-only reference copies**. The app does not use them.

## Run locally

```bash
npm install
npm run dev          # http://localhost:3000
npm run lint
npm run typecheck
npm run build && npm start
```

## Structure

- `src/app/(landing)/` – `/` (own root layout + `landing.css`, the original CSS verbatim)
- `src/app/(thank-you)/thank-you/` – `/thank-you` (own root layout + `thank-you.css`, original CSS verbatim)
- `src/app/global-not-found.tsx` – 404 page
- `src/components/landing/` – page sections; client components only where needed
  (`CountdownTimer`, `LeadForm`, `ClientStories`, `StickyCta`, `PageEffects`)
- `public/images/growspark-logo.png`, `public/growspark-contact.vcf` – public assets

The two pages have separate root layouts because their original CSS collides (`body`, `.wrap`, `.brand`, `footer`, `:root`).
Keeping each stylesheet verbatim guarantees pixel parity without rewriting selectors.

## Hidden section

The client-story/testimonial section is hidden, not deleted. Set `SHOW_CLIENT_STORIES = true` in
`src/app/(landing)/page.tsx` to bring it back (`ClientStories.tsx` is untouched).

## Environment variables

See `.env.example`. Only `NEXT_PUBLIC_SITE_URL` is used today (canonical / Open Graph base URL).
Never commit `.env*` files; secrets must not use the `NEXT_PUBLIC_` prefix.

## Missing integrations (not faked)

- **Lead form**: the original had no backend. A valid submit only shows the original "preview" notice; **no lead is stored or sent**.
  Needs a real endpoint (CRM, email, webhook, Sheets) – provide the target and credentials.
- **Payment**: the "Continue to payment · ₹999" button is a placeholder; no gateway exists. A gateway (provider TBD)
  must create the order server-side, verify the payment signature/webhook server-side, then redirect to `/thank-you`.
- **`/thank-you` is publicly reachable** and says "Payment confirmed" regardless of payment. Before going live with
  payments, gate it on a server-verified payment (e.g. signed token / order lookup).
- Framework download button on `/thank-you` is intentionally disabled, as in the original.
- No favicon: the only asset is a white-on-transparent logo, unsuitable as a favicon (browsers request `/favicon.ico` → 404).

## Deploy (e.g. Vercel)

1. Push the repo to GitHub and import it in Vercel (framework: Next.js, defaults).
2. Set `NEXT_PUBLIC_SITE_URL=https://growthaudit.growsparkconsulting.com` in Project → Environment Variables.
3. Project → Domains → add `growthaudit.growsparkconsulting.com`.
4. At your DNS provider for `growsparkconsulting.com`, add the record Vercel shows – typically
   `CNAME growthaudit → cname.vercel-dns.com` (use exactly the value Vercel displays).
5. Wait for verification + automatic HTTPS, then check `/`, `/thank-you`, `/growspark-contact.vcf`.
