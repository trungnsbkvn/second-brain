# second-brain.yplawfirm.vn — deployment & operations runbook

Standalone **multi-tenant AI-position rental platform** built on the gbrain
fork. One gbrain server hosts many customers; each customer is one isolated
`source` + a scoped OAuth client. JusHub (the Y&P legal ERP) is tenant #1.

- **Host**: `103.226.249.28` (Ubuntu 24.04; behind NAT — private NIC
  `10.0.0.34`, public IP NATed, so the provider must port-forward 80/443/22).
- **Domain**: `https://second-brain.yplawfirm.vn` (Cloudflare gray-cloud / DNS-only).
- **Topology**: Caddy (443, auto-TLS) → `gbrain serve --http` on
  `127.0.0.1:3131` → PostgreSQL 17 + pgvector (loopback) + Ollama embeddings
  (loopback). LLM = DeepSeek (cloud).
- **Playbooks this follows**: `docs/tutorials/company-brain.md`, `docs/mcp/DEPLOY.md`.

Live surfaces:
- MCP / OAuth: `POST /mcp`, `/token`, `/authorize`, `/.well-known/*`, `/health`
- Admin dashboard + control plane: `/admin` (IP-allowlisted at Caddy)

---

## 1. What's baked in (do not change casually)

| Decision | Value | Why / cost to change |
|---|---|---|
| Embedding model | `ollama:bge-m3` @ **1024d** | Won a 20-pair Vietnamese-legal retrieval eval on the box (bge-m3 top1 20/20 MRR 1.000 vs nomic-embed-text 14/20 MRR 0.802). **Changing dims = full reindex of every source.** |
| Chat / expansion LLM | `deepseek:deepseek-chat` | `DEEPSEEK_API_KEY` in `/etc/gbrain.env`. |
| DB role | `gbrain` has SUPERUSER | Needed for the v35 auto-RLS `CREATE EVENT TRIGGER` (BYPASSRLS alone is insufficient). |
| Tenant isolation | source + scoped OAuth client | gbrain enforces natively at token verification. Fuzz-audited 0 leaks. |
| Dream cross-source guard | config `multi_tenant.strict_source_isolation=true` | Drops the 6 content-mixing dream phases (see §6). |

---

## 2. Server layout

```
/srv/gbrain/app          fork source (deployed from the dev box), run via bun
/srv/gbrain/home         GBRAIN_HOME (config.json, PID files)
/srv/gbrain/.bun         bun runtime
/srv/brain-repos/<src>   one git-backed dir per source (per-tenant export/backup)
/etc/gbrain.env          secrets (mode 600, owner gbrain)
/usr/local/bin/gbrain    CLI wrapper (sources /etc/gbrain.env then runs the fork)
/usr/local/bin/gbrain-*  provisioning + backup scripts
/var/backups/gbrain      nightly dumps (14-day retention)
/root/.gbrain-pg-pass    postgres password for the gbrain role
/root/.yp-admin-creds    JusHub shared client_id/secret (tenant #1)
```

systemd: `gbrain-http` (the MCP/OAuth server) + `gbrain-worker` (minion jobs).
Both `EnvironmentFile=/etc/gbrain.env`. `journalctl -u gbrain-http -f` to tail.

---

## 3. Files in this directory

| File | Target on server |
|---|---|
| `gbrain-http.service` | `/etc/systemd/system/` |
| `gbrain-worker.service` | `/etc/systemd/system/` |
| `Caddyfile` | `/etc/caddy/Caddyfile` — TLS + `/admin*` IP allowlist (**edit the office IP**) |
| `gbrain.env.prod.example` | `/etc/gbrain.env` (mode 600) |
| `gbrain-backup.sh` | `/usr/local/bin/` — cron 02:30, pg_dump + brain-repos tar |
| `gbrain-new-tenant.sh` | `/usr/local/bin/` — provision a business tenant |
| `gbrain-new-jushub-user.sh` | `/usr/local/bin/` — provision one JusHub user (Model B) |
| `gbrain-new-yp-shared.sh` | `/usr/local/bin/` — one-time JusHub shared sources + `yp-admin` client |

---

## 4. Managing tenants & rented agents

Two equivalent surfaces: the **Admin SPA → Rental** page (point-and-click), or
the **CLI scripts** over SSH (scriptable). Both call the same code.

### Tenancy model recap
- **Business tenant** = source `tenant-<slug>` + OAuth `client_credentials`
  client (write: own source; read: own source + `platform-knowledge`).
- **JusHub** = tenant `yp`, keeps per-user Model B: sources `yp-user-<id>`,
  `yp-role-<code>`, `yp-global`; one client per user + the shared `yp-admin`.
- `platform-knowledge` = curated shared source. Reads are granted **per client
  via `federated_read`**, never via the source-level `federated` flag.
- Source ids: lowercase, ≤32 chars, no underscores (role codes normalize
  `_`→`-`, e.g. `hr_manager` → `yp-role-hr-manager`).

### CLI — add a customer
```bash
# provision: source + scoped client + $5/day budget. Prints creds ONCE.
gbrain-new-tenant.sh acme "ACME Corp" 5
# hand the printed client_id/secret to the customer over a secure channel.
# they connect: POST /token (client_credentials) then POST /mcp (Bearer).
```

### CLI — inspect / operate
```bash
sudo -u gbrain gbrain sources list                 # all sources + page counts
sudo -u gbrain gbrain auth list                    # all OAuth clients
# suspend a client (revoke tokens, keep the row — resume with deleted_at=NULL):
sudo -u postgres psql gbrain -c "UPDATE oauth_clients SET deleted_at=now() WHERE client_name='tenant-acme-agent';"
# change a budget cap:
sudo -u postgres psql gbrain -c "UPDATE oauth_clients SET budget_usd_per_day=20 WHERE client_name='tenant-acme-agent';"
# remove a tenant entirely (destructive — exports first if you need the data):
sudo -u gbrain gbrain sources remove tenant-acme --yes --confirm-destructive
```

### Admin SPA — Rental page (`/admin` → Rental)
- **Tenants**: add / suspend / reactivate a business customer.
- **Position catalog**: define rentable position templates (name, version,
  price/mo, status draft|published|retired). Publishing = making it rentable.
- **Agent instances**: one-click **Provision** (tenant × position → new source +
  bound OAuth client, credentials shown ONCE) · Suspend · Resume · Revoke.
- **Requests**: self-service asks → Approve (provisions an instance) / Reject.
- **Usage**: monthly per-instance call counts + spend + CSV export.

> **Rent positions, deliver agent instances.** The catalog holds *positions*
> (templates); a customer rents an *instance* of a position = one bound client
> + one source. Price = per-instance/month + metered usage above the included
> quota.

### Metering & budgets
- Every MCP op is logged to `mcp_request_log` (call counts — reliable day 1).
- LLM-bearing ops (`think`/`query`/`advisor`) carry a flat spend estimate and
  are budget-gated: a client past `budget_usd_per_day` gets HTTP
  `budget_exceeded` (see `LLM_OP_SPEND_CENTS_ESTIMATE` in serve-http.ts).
- Voyage image search + subagents are dollar-metered natively (`mcp_spend_log`).

---

## 5. Managing brain content & knowledge

- **Tenant ingestion** works today: a tenant's own client can `put_page` /
  `import` over MCP into its own source. No extra wiring.
- **Shared platform knowledge** (`platform-knowledge`): only a client with
  write scope on that source can add to it. Provision an editor client:
  ```bash
  sudo -u gbrain gbrain auth register-client platform-editor \
    --grant-types client_credentials --scopes "read write" \
    --source platform-knowledge --federated-read platform-knowledge
  ```
  **Anti-poisoning + PDPL**: never copy a customer's content verbatim into
  `platform-knowledge`. Abstract the know-how, re-author it, then write it —
  no customer→vendor data flowback.
- **Edit / delete pages**: `put_page` (upsert) / `delete_page` over MCP, or the
  gbrain CLI (`gbrain get-page`, `gbrain put-page --file`, `gbrain sources ...`).

---

## 6. The dream / learning loop under multi-tenancy

`gbrain dream` consolidates knowledge nightly. Several phases mix content
**across sources** and would leak between tenants. The guard drops them:

```bash
sudo -u gbrain gbrain config get multi_tenant.strict_source_isolation   # → true
```

When `true`, `runCycle` drops `CROSS_SOURCE_CONTENT_PHASES` (synthesize,
patterns, synthesize_concepts, grade_takes, calibration_profile,
resolve_symbol_edges) from **every** phase selection — `dream`, per-source
autopilot, and the global-maintenance job. Per-source phases (embed, extract,
orphans, purge, …) still run.

Run per-tenant dream on a cron (as the gbrain user):
```cron
0 3 * * * BASH_ENV=/etc/gbrain.env /usr/local/bin/gbrain dream --source yp-global
```
Do **not** enable unattended global autopilot while multiple tenants' data is
present unless the guard is on.

---

## 7. Backups & disaster recovery

- Nightly `gbrain-backup.sh` (cron 02:30): `pg_dump -Fc gbrain` +
  `tar` of `/srv/brain-repos`, 14-day retention in `/var/backups/gbrain`.
- **Configure offsite** (single box = no HA): uncomment the `rclone` line in
  `gbrain-backup.sh` and set up an rclone remote — the offsite copy IS the DR.
- **Restore drill** (do this periodically):
  ```bash
  sudo -u postgres createdb gbrain_restore_test
  sudo -u postgres pg_restore -d gbrain_restore_test /var/backups/gbrain/gbrain-<date>.dump
  sudo -u postgres psql gbrain_restore_test -c 'SELECT count(*) FROM pages;'
  sudo -u postgres dropdb gbrain_restore_test
  ```
- **Per-tenant restore**: `pg_restore` can't restore one tenant. Each source is
  a git dir under `/srv/brain-repos/<src>` — re-import that dir into a fresh
  source; embeddings rebuild on import.

---

## 8. TLS / cert

Caddy fetches + renews Let's Encrypt automatically (HTTP-01). Requirements:
DNS gray-cloud (direct A record) + inbound 80/443 reachable. If a renewal is
stuck (Caddy backs off up to ~20 min after failures):
```bash
systemctl restart caddy      # forces an immediate ACME retry
journalctl -u caddy -n 30 | grep -i "certificate obtained"
```
If Cloudflare must go orange-cloud later: switch to a Cloudflare **origin
cert** or an `xcaddy` build with the Cloudflare **DNS-01** plugin — do not
fight HTTP-01 through the proxy.

---

## 9. Updating the server (deploy a fork change)

The server runs the fork **from source** via bun. To ship an edit:

```bash
# from the dev box (Git Bash). rsync is cleaner than tar for incremental:
rsync -az --delete --exclude node_modules --exclude bin --exclude .git \
  -e "ssh -i /e/Develop/_SSH/gdata/id_rsa" \
  /e/Develop/YP/second-brain/ root@103.226.249.28:/srv/gbrain/app/

ssh -i /e/Develop/_SSH/gdata/id_rsa root@103.226.249.28 '
  chown -R gbrain:gbrain /srv/gbrain/app
  cd /srv/gbrain/app && sudo -u gbrain /srv/gbrain/.bun/bin/bun install --frozen-lockfile
  sudo -u gbrain /usr/local/bin/gbrain apply-migrations --yes --non-interactive
  systemctl restart gbrain-http gbrain-worker'
```

If you changed the admin SPA, run `bun run build:admin` on the dev box first
(the built assets in `admin/dist` + `src/admin-embedded.ts` are committed and
shipped in the rsync).

---

## 10. Maintaining the fork (git: commit / push / merge / upstream)

This fork lives at **`github.com/trungnsbkvn/second-brain`** (remote `origin`,
default branch `master`). Upstream is `garrytan/gbrain`.

### Commit → push → merge (our platform changes)
```bash
cd /e/Develop/YP/second-brain
git checkout -b feat/<topic>            # never commit straight to master
git add -A
git commit -m "..."                     # see message convention below
git push -u origin feat/<topic>
# merge to master (locally, preserving the branch point):
git checkout master
git merge --no-ff feat/<topic>
git push origin master
```
Our platform code is deliberately isolated so upstream merges stay clean:
- new files: `deploy/linux/*`, `src/commands/serve-http-cp.ts`,
  `admin/src/pages/Rental.tsx`
- minimal touch-points on upstream files: `src/commands/serve-http.ts` (one
  `mountControlPlane(...)` call + the register-client source fix + the metering
  block), `src/core/migrate.ts` (migration v123), `src/core/cycle.ts` (the
  isolation guard), `src/core/config.ts` (one config key),
  `src/core/ai/recipes/ollama.ts` (bge-m3 dims), `admin/src/{App,api}.ts(x)`.

### Rebasing on upstream (pull in new gbrain releases)
```bash
git remote add upstream https://github.com/garrytan/gbrain.git   # once
git fetch upstream
git checkout master && git merge upstream/master   # resolve conflicts in the
                                                   # touch-point files above
# then redeploy (§9) and re-run migrations.
```
Do this ~monthly. Because our changes are file-isolated, conflicts are
confined to the handful of touch-point files listed above.

### Commit-message convention
Match the fork's style (`vX.Y.Z type(scope): summary (#refs)`) for
upstream-shaped changes; use plain conventional commits
(`feat(rental): ...`) for our platform code.

---

## 11. Connecting a client (tenant side)

```
POST https://second-brain.yplawfirm.vn/token   grant_type=client_credentials
POST https://second-brain.yplawfirm.vn/mcp     Authorization: Bearer <access_token>
                                                Accept: application/json, text/event-stream
```
Any HTTP client works — it's plain JSON-RPC 2.0 over one POST. That's exactly
how JusHub's `internal/ai/mcp.go` talks to it.

---

## 12. JusHub cutover runbook (point the ERP at this brain)

Pre-req: `curl https://second-brain.yplawfirm.vn/health` → 200 from the JusHub
box. Test locally first (env-override, no config.env edit — see §13).

1. **Shared sources + client** — already provisioned 2026-07-10
   (`gbrain-new-yp-shared.sh`; 17 sources + `yp-admin`; creds in
   `/root/.yp-admin-creds`).
2. **Per active user** (roles comma-separated, underscores OK):
   `gbrain-new-jushub-user.sh <user-id> leader,hr_manager` → capture creds.
3. **JusHub prod `config.env`**:
   ```
   GBRAIN_BASE_URL=https://second-brain.yplawfirm.vn/mcp
   GBRAIN_OAUTH_CLIENT_ID=<yp-admin id>
   GBRAIN_OAUTH_CLIENT_SECRET=<yp-admin secret>
   # UNSET: GBRAIN_EXE, GBRAIN_SERVE_ARGS, GBRAIN_PG_*, GBRAIN_HOME, GBRAIN_DIR
   # (GBrainSupervisor no-ops when GBRAIN_EXE is unset — cmd/server/main.go:469)
   ```
4. Per-user Model B rows:
   `jusaihub gbrain-set-client <user-id> yp-user-<id> <client_id> <client_secret> https://second-brain.yplawfirm.vn/token`
5. **Data**: `jusaihub backfill-gbrain` — idempotent re-mirror of `ai_memory`;
   re-embeds server-side at bge-m3/1024. Do NOT pg_restore the old local
   portable PG (wrong dims, wrong source names).
6. Verify: JusHub chat `brain_search` round-trip; page counts vs `ai_memory`;
   RTT `curl -w '%{time_total}' https://second-brain.yplawfirm.vn/health`
   (>50 ms/call is noticeable in the chat loop — consider co-location).

---

## 13. Test JusHub locally against this brain (non-destructive)

The JusHub config loader does **not** overload existing env vars
(`config.go`: `if os.Getenv(key) == ""`), so shell overrides beat `config.env`
without editing it. From the JusHub repo:

```bash
GBRAIN_BASE_URL=https://second-brain.yplawfirm.vn/mcp \
GBRAIN_OAUTH_CLIENT_ID=<yp-admin id> \
GBRAIN_OAUTH_CLIENT_SECRET=<yp-admin secret> \
GBRAIN_EXE= \
JUSLLM_BASE_URL=https://chat.yplawfirm.vn \
  ./build/jusaihub.exe serve
```
`GBRAIN_EXE=` (empty) stops the local sidecar from launching; JusHub talks to
the remote brain instead. Exercise the AI chat (triggers `brain_search`) and
watch the boot log for the brain wiring. Nothing writes to the remote until
you run `backfill-gbrain`.
