# UPSTREAM.md — fork drift registry (second-brain vs gbrain)

This fork (`github.com/trungnsbkvn/second-brain`, branch `master`) tracks
upstream **`garrytan/gbrain`** (`upstream/master`) and layers a multi-tenant
"AI position rental" **platform** + a signed-pack **marketplace registry** on
top. The overriding rule: **keep divergence minimal and file-isolated** so the
monthly `git merge upstream/master` only ever conflicts in the small, listed
set of touch-point files.

Deploy note: the box runs the `.ts` directly via `bun` — there is **no build
step**. "Deploy" = rsync/scp the files + `systemctl restart gbrain-http
gbrain-worker`. So a merge that type-checks + passes the smoke gate is
deployable as-is.

## A. New files — NEVER conflict (pure additions)

| File | Purpose |
|---|---|
| `src/commands/serve-http-cp.ts` | Control plane `/admin/api/cp/*` (tenants, positions, instances, requests, usage). Migration v123. |
| `src/commands/serve-http-cp-registry.ts` | Marketplace registry: `POST /admin/api/cp/positions/publish` + `/:id/retire` + `/:id/republish`, tenant `GET/POST /api/catalog/*`. Migration v124. |
| `admin/src/pages/Rental.tsx` | Admin SPA: rental control plane + product console (eval/usage/★ratings). |
| `deploy/linux/*` | systemd units, Caddyfile, provisioning + backup scripts, `smoke-cp.sh`, `check-touchpoints.sh`, this runbook. |
| `UPSTREAM.md` | This file. |

If upstream ever adds a file at one of these paths, rename ours — do not merge.

## B. Inline touch-points — conflict-prone (review every merge)

Each entry: **what** we changed + **the merge rule**. Keep the change minimal;
if a hunk grows, extract it into a new file in §A instead.

| File | Our change | Merge rule |
|---|---|---|
| `src/commands/serve-http.ts` | Import + `mountControlPlane({...})` **and** `mountRegistry({...})` calls (~line 1411, kept adjacent); the `LLM_OP_SPEND_CENTS_ESTIMATE` map + `checkBudget`/`recordSpend` metering block; the register-client source fix. | Keep BOTH mount calls together right after the app is built. `mountRegistry` needs `verifyAdminToken` (a closure over `bootstrapHash` + `safeHexEqual`) — don't drop it. |
| `src/core/migrate.ts` | Migrations **v123** (cp_* tables) + **v124** (cp_positions artifact/eval cols + `cp_position_rating`), appended before the closing `];`. | **Append-only. NEVER renumber** existing migrations and never insert below ours. `LATEST_VERSION` is auto-derived. |
| `src/core/cycle.ts` | `CROSS_SOURCE_CONTENT_PHASES` isolation guard (drops cross-source dream phases when `multi_tenant.strict_source_isolation`). | Preserve the guard; re-run the isolation fuzz after any merge that touches dream/cycle. |
| `src/core/config.ts` | One config key: `multi_tenant.strict_source_isolation`. | Keep the key + its default. |
| `src/core/ai/recipes/ollama.ts` | `bge-m3` recipe + `dims_options:[384,768,1024]` (embeddings are baked at 1024d — changing = full reindex). | Keep bge-m3; do NOT change the embedding dim. |
| `src/core/operations.ts` | `volunteer_context` backward-compat: accept legacy `prior_context` as the `window` fallback. | Keep until every client sends `window`. |
| `admin/src/App.tsx` | Route entry for the `rental` page. | Keep the route. |
| `admin/src/api.ts` | The `cp*` client-method block (tenants/positions/instances/requests/usage + publish/retire/republish/ratings). | Keep the block; it mirrors the endpoints in §A. |

## C. Monthly sync + post-merge smoke gate

```bash
git fetch upstream
git checkout master && git merge upstream/master    # resolve ONLY §B files
bun run typecheck                                     # or: tsc --noEmit
bun test                                              # full suite (cycles + migrations)
deploy/linux/smoke-cp.sh                              # cp_* + /api/catalog smoke (needs a running box)
# isolation fuzz — a leak BLOCKS the release (fuzz-audited 0 leaks 2026-07-10)
```

Surface conflicts early — before merging, see exactly which §B files upstream
touched:

```bash
deploy/linux/check-touchpoints.sh                    # hunk counts per touch-point
deploy/linux/check-touchpoints.sh --fail-on-drift    # CI mode
```
