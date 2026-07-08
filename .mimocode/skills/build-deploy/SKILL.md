---
name: simadesk:build-deploy
description: "Build and deploy SimaDesk to Netlify production. Run type-check, build, and deploy in sequence. Use after completing any code changes that need to go live."
---

# Build & Deploy to Netlify

Sequential pipeline: type-check → build → deploy. Stop on first failure.

## Steps

1. **Type-check** — catch TS errors before build:
   ```bash
   npx tsc --noEmit 2>&1
   ```
   If errors found → fix them before proceeding. Do NOT deploy with type errors.

2. **Build** — produce production bundle:
   ```bash
   npm run build 2>&1 | tail -20
   ```
   Confirms `✓ built` or equivalent success. If build fails → stop and fix.

3. **Deploy to Netlify production**:
   ```bash
   netlify deploy --prod --dir=dist 2>&1 | tail -15
   ```
   Netlify CLI must be authenticated. If deploy hangs, wait up to 3 minutes.
   On success, output the site URL.

## Failure handling

- Type errors: fix in-place, re-run from step 1.
- Build errors: check vite/TS output, fix, re-run from step 2.
- Deploy errors: verify `netlify status` and auth; retry once.

## Notes

- Project root: `/Users/samarzi/Desktop/SIMA OS/SIMA-samarzi/Projects/SimaDesk`
- Build output goes to `dist/`.
- `netlify.toml` configures SPA catch-all and marketplace API proxies.
- The deploy is non-destructive; old bundles are replaced on success.
