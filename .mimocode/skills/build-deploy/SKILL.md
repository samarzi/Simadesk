---
name: simadesk:build-deploy
description: "Build and deploy SimaDesk to VPS production. Run type-check, build, and deploy in sequence. Use after completing any code changes that need to go live."
---

# Build & Deploy to VPS

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

3. **Deploy to VPS**:
   ```bash
   scp -r dist/* root@135.106.172.135:/opt/simadesk/dist/
   ssh root@135.106.172.135 "docker cp /opt/simadesk/dist/. simadesk-frontend-1:/usr/share/nginx/html/ && docker exec simadesk-frontend-1 nginx -s reload"
   ```

## Failure handling

- Type errors: fix in-place, re-run from step 1.
- Build errors: check vite/TS output, fix, re-run from step 2.
- Deploy errors: check SSH connectivity, verify `/opt/simadesk/dist/` exists on VPS.

## Notes

- Project root: `/Users/a1111/Desktop/SIMA OS/SIMA-samarzi/Projects/SimaDesk`
- Build output goes to `dist/`.
- Production: self-hosted VPS at 135.106.172.135 with Docker Compose stack.
- The deploy is non-destructive; old bundles are replaced on success.
- CI/CD: GitHub Actions auto-deploys on push to `main`.
