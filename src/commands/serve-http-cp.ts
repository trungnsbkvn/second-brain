/**
 * Control plane for the multi-tenant "AI position rental" platform
 * (second-brain.yplawfirm.vn) — admin API under /admin/api/cp/*.
 *
 * Kept in its OWN module (mounted from serve-http.ts with one call) so the
 * fork's touch-points on upstream files stay minimal — see
 * deploy/linux/README.md "fork drift" note.
 *
 * Model (migration v123):
 *   tenant   = business customer; slug drives source naming tenant-<slug>[…]
 *   position = rentable catalog template (versioned; artifact refs only)
 *   instance = what a tenant rents: 1 oauth_clients row + 1 gbrain source,
 *              bound write-scope to its own source + federated read of
 *              platform-knowledge. gbrain enforces isolation natively at
 *              token verification (fuzz-audited 2026-07-10, 0 leaks).
 *   request  = self-service ask → admin approve (provisions) / reject
 *
 * Suspend/resume rides oauth_clients soft-delete (deleted_at) — the secret
 * hash survives, so resume does not rotate credentials. Revoke is permanent.
 *
 * Usage/billing: mcp_request_log (per-call, by token_name = client_name) +
 * mcp_spend_log (LLM/image spend cents, by client_id). Note: until the
 * spend instrumentation covers think/query/synthesize, spend_cents only
 * reflects subagent + image ops — call counts are the reliable meter.
 */
import type { Express, Request, Response, NextFunction } from 'express';
import express from 'express';
import { mkdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import type { BrainEngine } from '../core/engine.ts';
import type { SqlQuery, GBrainOAuthProvider } from '../core/oauth-provider.ts';
import { addSource } from '../core/sources-ops.ts';

/** Root for per-source git-backed content dirs (per-tenant export/backup). */
const BRAIN_REPOS_DIR = process.env.GBRAIN_BRAIN_REPOS_DIR ?? '/srv/brain-repos';

/** Shared curated source every tenant client may federated-read. */
const PLATFORM_KNOWLEDGE_SOURCE = 'platform-knowledge';

/** Source ids cap at 32 chars (validateSourceId) — keep tenant slugs short
 * enough that `tenant-<slug>-p<positionId>` still fits. */
const TENANT_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,18}$/;
const POSITION_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

interface MountOpts {
  app: Express;
  sql: SqlQuery;
  engine: BrainEngine;
  oauthProvider: GBrainOAuthProvider;
  requireAdmin: (req: Request, res: Response, next: NextFunction) => void;
}

function bad(res: Response, msg: string): void {
  res.status(400).json({ error: msg });
}

function fail(res: Response, e: unknown): void {
  res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
}

export function mountControlPlane({ app, sql, engine, oauthProvider, requireAdmin }: MountOpts): void {
  const json = express.json();

  // ── tenants ────────────────────────────────────────────────────────────

  app.get('/admin/api/cp/tenants', requireAdmin, async (_req, res) => {
    try {
      const rows = await sql`
        SELECT t.*, count(i.id)::int AS instance_count
        FROM cp_tenants t
        LEFT JOIN cp_agent_instances i ON i.tenant_id = t.id AND i.status <> 'revoked'
        GROUP BY t.id ORDER BY t.created_at DESC`;
      res.json({ tenants: rows });
    } catch (e) { fail(res, e); }
  });

  app.post('/admin/api/cp/tenants', requireAdmin, json, async (req, res) => {
    try {
      const { slug, name, contactEmail, plan, notes } = req.body ?? {};
      if (typeof slug !== 'string' || !TENANT_SLUG_RE.test(slug)) {
        return bad(res, 'slug must match ^[a-z0-9][a-z0-9-]{0,18}$ (≤19 chars — source ids cap at 32)');
      }
      if (typeof name !== 'string' || !name.trim()) return bad(res, 'name required');
      const rows = await sql`
        INSERT INTO cp_tenants (slug, name, contact_email, plan, notes)
        VALUES (${slug}, ${name.trim()}, ${contactEmail ?? null}, ${plan ?? null}, ${notes ?? null})
        ON CONFLICT (slug) DO NOTHING
        RETURNING *`;
      if (rows.length === 0) return bad(res, `tenant slug "${slug}" already exists`);
      res.json({ tenant: rows[0] });
    } catch (e) { fail(res, e); }
  });

  // Suspend/resume/churn a tenant. Suspend disables ALL its instances'
  // OAuth clients (soft-delete + token purge); resume re-enables the ones
  // the tenant-level suspend disabled (instance-level suspends stay put).
  app.post('/admin/api/cp/tenants/:id/status', requireAdmin, json, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const { status } = req.body ?? {};
      if (!Number.isInteger(id)) return bad(res, 'bad tenant id');
      if (!['active', 'suspended', 'churned'].includes(status)) {
        return bad(res, "status must be active|suspended|churned");
      }
      const t = await sql`UPDATE cp_tenants SET status = ${status} WHERE id = ${id} RETURNING *`;
      if (t.length === 0) return bad(res, 'tenant not found');
      if (status === 'suspended' || status === 'churned') {
        await sql`
          UPDATE oauth_clients SET deleted_at = now()
          WHERE deleted_at IS NULL
            AND client_id IN (SELECT client_id FROM cp_agent_instances WHERE tenant_id = ${id})`;
        await sql`
          DELETE FROM oauth_tokens
          WHERE client_id IN (SELECT client_id FROM cp_agent_instances WHERE tenant_id = ${id})`;
      } else {
        await sql`
          UPDATE oauth_clients SET deleted_at = NULL
          WHERE client_id IN (
            SELECT client_id FROM cp_agent_instances WHERE tenant_id = ${id} AND status = 'active')`;
      }
      res.json({ tenant: t[0] });
    } catch (e) { fail(res, e); }
  });

  // ── positions (the rentable catalog) ───────────────────────────────────

  // Vendor product console read (v124): each position carries its eval score
  // (from JusHub RunGoldenEval, stored at publish), install count, 30-day call
  // volume, and satisfaction (avg stars / rating & flag counts). Scalar
  // subqueries keep it a single flat row per position (no GROUP-BY fan-out).
  app.get('/admin/api/cp/positions', requireAdmin, async (_req, res) => {
    try {
      const rows = await sql`
        SELECT p.*,
          (SELECT count(*)::int FROM cp_agent_instances i
             WHERE i.position_id = p.id AND i.status <> 'revoked') AS instance_count,
          (SELECT count(*)::int FROM mcp_request_log l
             WHERE l.token_name IN (SELECT client_id FROM cp_agent_instances WHERE position_id = p.id)
               AND l.created_at >= now() - interval '30 days') AS calls_30d,
          coalesce((SELECT round(avg(stars)::numeric, 2)::float8
             FROM cp_position_rating WHERE position_id = p.id AND stars IS NOT NULL), 0) AS avg_rating,
          (SELECT count(*)::int FROM cp_position_rating
             WHERE position_id = p.id AND stars IS NOT NULL) AS rating_count,
          (SELECT count(*)::int FROM cp_position_rating
             WHERE position_id = p.id AND flagged) AS flag_count
        FROM cp_positions p
        ORDER BY p.slug`;
      res.json({ positions: rows });
    } catch (e) { fail(res, e); }
  });

  // Drill-down: recent ratings/flags for one position (product-quality signal).
  app.get('/admin/api/cp/positions/:id/ratings', requireAdmin, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) return bad(res, 'bad position id');
      const rows = await sql`
        SELECT r.id, r.stars, r.flagged, r.comment, r.created_at,
               t.slug AS tenant_slug
        FROM cp_position_rating r
        LEFT JOIN cp_tenants t ON t.id = r.tenant_id
        WHERE r.position_id = ${id}
        ORDER BY r.created_at DESC LIMIT 100`;
      res.json({ ratings: rows });
    } catch (e) { fail(res, e); }
  });

  app.post('/admin/api/cp/positions', requireAdmin, json, async (req, res) => {
    try {
      const { slug, name, description, version, seedPagesDir, skillpackRef, schemaPackRef,
              priceMonthCents, includedCallsMonth, status } = req.body ?? {};
      if (typeof slug !== 'string' || !POSITION_SLUG_RE.test(slug)) return bad(res, 'bad position slug');
      if (typeof name !== 'string' || !name.trim()) return bad(res, 'name required');
      if (status !== undefined && !['draft', 'published', 'retired'].includes(status)) {
        return bad(res, 'status must be draft|published|retired');
      }
      // Upsert by slug — publishing a new version of a position is an update.
      const rows = await sql`
        INSERT INTO cp_positions
          (slug, name, description, version, seed_pages_dir, skillpack_ref, schema_pack_ref,
           price_month_cents, included_calls_month, status)
        VALUES
          (${slug}, ${name.trim()}, ${description ?? null}, ${version ?? '1.0.0'},
           ${seedPagesDir ?? null}, ${skillpackRef ?? null}, ${schemaPackRef ?? null},
           ${Number(priceMonthCents ?? 0)}, ${includedCallsMonth ?? null}, ${status ?? 'draft'})
        ON CONFLICT (slug) DO UPDATE SET
          name = EXCLUDED.name, description = EXCLUDED.description, version = EXCLUDED.version,
          seed_pages_dir = EXCLUDED.seed_pages_dir, skillpack_ref = EXCLUDED.skillpack_ref,
          schema_pack_ref = EXCLUDED.schema_pack_ref, price_month_cents = EXCLUDED.price_month_cents,
          included_calls_month = EXCLUDED.included_calls_month, status = EXCLUDED.status
        RETURNING *`;
      res.json({ position: rows[0] });
    } catch (e) { fail(res, e); }
  });

  // ── instances: one-click provision ─────────────────────────────────────
  // Same recipe as deploy/linux/gbrain-new-tenant.sh, in-process:
  //   dir → source (isolated) → OAuth client (write own source, federated
  //   read own + platform-knowledge) → budget/bound columns → ledger row.
  // Returns the client secret ONCE — it is stored hashed and unrecoverable.

  async function provisionInstance(tenantId: number, positionId: number | null,
    budgetUsdPerDay: number, maxConcurrent: number) {
    const tenants = await sql`SELECT * FROM cp_tenants WHERE id = ${tenantId}`;
    if (tenants.length === 0) throw new Error('tenant not found');
    const tenant = tenants[0] as { id: number; slug: string; status: string };
    if (tenant.status !== 'active') throw new Error(`tenant is ${tenant.status}`);

    interface CpPositionRow { id: number; slug: string; status: string }
    let position: CpPositionRow | null = null;
    if (positionId != null) {
      const rows = await sql`SELECT * FROM cp_positions WHERE id = ${positionId}`;
      if (rows.length === 0) throw new Error('position not found');
      position = rows[0] as unknown as CpPositionRow;
      if (position.status !== 'published') throw new Error(`position is ${position.status}, not published`);
    }

    // Source id: tenant-<slug> for the first instance, tenant-<slug>-p<pos>
    // (or -i<n>) after that. validateSourceId caps at 32 chars — slugs are
    // pre-capped at 19 so every shape fits.
    const base = `tenant-${tenant.slug}`;
    const taken = await sql`SELECT id FROM sources WHERE id = ${base}`;
    let sourceId = base;
    if (taken.length > 0) {
      sourceId = position ? `${base}-p${position.id}` : `${base}-i2`;
      let n = 2;
      while ((await sql`SELECT id FROM sources WHERE id = ${sourceId}`).length > 0) {
        n += 1;
        sourceId = `${base}-i${n}`;
        if (n > 99) throw new Error('too many instances for this tenant slug');
      }
    }

    // Git-backed content dir → per-tenant export/backup granularity.
    // git init is best-effort (works without git; loses versioning only).
    const dir = `${BRAIN_REPOS_DIR}/${sourceId}`;
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    spawnSync('git', ['-C', dir, 'init', '-q'], { stdio: 'ignore' });

    await addSource(engine, { id: sourceId, name: `${tenant.slug}${position ? ` / ${position.slug}` : ''}`,
      localPath: dir, federated: false });

    const clientName = `${sourceId}-agent`;
    const { clientId, clientSecret } = await oauthProvider.registerClientManual(
      clientName, ['client_credentials'], 'read write', [],
      sourceId, [sourceId, PLATFORM_KNOWLEDGE_SOURCE],
    );

    await sql`
      UPDATE oauth_clients
      SET budget_usd_per_day = ${budgetUsdPerDay}, bound_source_id = ${sourceId},
          bound_max_concurrent = ${maxConcurrent}
      WHERE client_id = ${clientId}`;

    const inst = await sql`
      INSERT INTO cp_agent_instances (tenant_id, position_id, client_id, client_name, source_id)
      VALUES (${tenantId}, ${positionId}, ${clientId}, ${clientName}, ${sourceId})
      RETURNING *`;

    return { instance: inst[0], clientId, clientSecret, sourceId,
      tokenUrl: '/token', mcpUrl: '/mcp' };
  }

  app.get('/admin/api/cp/instances', requireAdmin, async (_req, res) => {
    try {
      const rows = await sql`
        SELECT i.*, t.slug AS tenant_slug, t.name AS tenant_name,
               p.slug AS position_slug, p.name AS position_name,
               (c.deleted_at IS NOT NULL) AS client_disabled
        FROM cp_agent_instances i
        JOIN cp_tenants t ON t.id = i.tenant_id
        LEFT JOIN cp_positions p ON p.id = i.position_id
        LEFT JOIN oauth_clients c ON c.client_id = i.client_id
        ORDER BY i.provisioned_at DESC`;
      res.json({ instances: rows });
    } catch (e) { fail(res, e); }
  });

  app.post('/admin/api/cp/instances', requireAdmin, json, async (req, res) => {
    try {
      const { tenantId, positionId, budgetUsdPerDay, maxConcurrent } = req.body ?? {};
      if (!Number.isInteger(tenantId)) return bad(res, 'tenantId (integer) required');
      const budget = Number(budgetUsdPerDay ?? 5);
      const conc = Number(maxConcurrent ?? 2);
      if (!(budget >= 0 && budget <= 1000)) return bad(res, 'budgetUsdPerDay must be 0..1000');
      const result = await provisionInstance(tenantId,
        Number.isInteger(positionId) ? positionId : null, budget, conc);
      res.json(result);
    } catch (e) { fail(res, e); }
  });

  // suspend | resume | revoke. Revoke is PERMANENT (secret unrecoverable);
  // the source + its content stay (per-tenant data export handles removal).
  app.post('/admin/api/cp/instances/:id/status', requireAdmin, json, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const { action } = req.body ?? {};
      if (!Number.isInteger(id)) return bad(res, 'bad instance id');
      if (!['suspend', 'resume', 'revoke'].includes(action)) {
        return bad(res, 'action must be suspend|resume|revoke');
      }
      const rows = await sql`SELECT * FROM cp_agent_instances WHERE id = ${id}`;
      if (rows.length === 0) return bad(res, 'instance not found');
      const inst = rows[0] as { client_id: string; status: string };
      if (inst.status === 'revoked') return bad(res, 'instance already revoked');

      if (action === 'suspend' || action === 'revoke') {
        await sql`UPDATE oauth_clients SET deleted_at = now()
                  WHERE client_id = ${inst.client_id} AND deleted_at IS NULL`;
        await sql`DELETE FROM oauth_tokens WHERE client_id = ${inst.client_id}`;
      } else {
        await sql`UPDATE oauth_clients SET deleted_at = NULL WHERE client_id = ${inst.client_id}`;
      }
      const status = action === 'suspend' ? 'suspended' : action === 'resume' ? 'active' : 'revoked';
      const upd = await sql`UPDATE cp_agent_instances SET status = ${status} WHERE id = ${id} RETURNING *`;
      res.json({ instance: upd[0] });
    } catch (e) { fail(res, e); }
  });

  // ── rental requests (self-service ask → approve/reject) ────────────────

  app.get('/admin/api/cp/requests', requireAdmin, async (req, res) => {
    try {
      const status = typeof req.query.status === 'string' ? req.query.status : 'pending';
      const rows = await sql`
        SELECT r.*, t.slug AS tenant_slug, t.name AS tenant_name,
               p.slug AS position_slug, p.name AS position_name
        FROM cp_rental_requests r
        LEFT JOIN cp_tenants t ON t.id = r.tenant_id
        LEFT JOIN cp_positions p ON p.id = r.position_id
        WHERE r.status = ${status}
        ORDER BY r.created_at DESC LIMIT 200`;
      res.json({ requests: rows });
    } catch (e) { fail(res, e); }
  });

  app.post('/admin/api/cp/requests', requireAdmin, json, async (req, res) => {
    try {
      const { tenantId, positionId, requestedBy, note } = req.body ?? {};
      if (!Number.isInteger(tenantId)) return bad(res, 'tenantId required');
      const rows = await sql`
        INSERT INTO cp_rental_requests (tenant_id, position_id, requested_by, note)
        VALUES (${tenantId}, ${Number.isInteger(positionId) ? positionId : null},
                ${requestedBy ?? null}, ${note ?? null})
        RETURNING *`;
      res.json({ request: rows[0] });
    } catch (e) { fail(res, e); }
  });

  app.post('/admin/api/cp/requests/:id/decide', requireAdmin, json, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const { decision, decidedBy, decisionNote, budgetUsdPerDay, maxConcurrent } = req.body ?? {};
      if (!Number.isInteger(id)) return bad(res, 'bad request id');
      if (!['approve', 'reject'].includes(decision)) return bad(res, 'decision must be approve|reject');
      const rows = await sql`SELECT * FROM cp_rental_requests WHERE id = ${id} AND status = 'pending'`;
      if (rows.length === 0) return bad(res, 'pending request not found');
      const r = rows[0] as { tenant_id: number; position_id: number | null };

      let provision: Awaited<ReturnType<typeof provisionInstance>> | null = null;
      if (decision === 'approve') {
        provision = await provisionInstance(r.tenant_id, r.position_id,
          Number(budgetUsdPerDay ?? 5), Number(maxConcurrent ?? 2));
      }
      const upd = await sql`
        UPDATE cp_rental_requests
        SET status = ${decision === 'approve' ? 'approved' : 'rejected'},
            decided_by = ${decidedBy ?? null}, decision_note = ${decisionNote ?? null},
            decided_at = now()
        WHERE id = ${id} RETURNING *`;
      res.json({ request: upd[0], ...(provision ? { provision } : {}) });
    } catch (e) { fail(res, e); }
  });

  // ── usage / billing ─────────────────────────────────────────────────────
  // Per-instance monthly rollup: call counts from mcp_request_log + spend
  // cents from mcp_spend_log. NB: mcp_request_log.token_name is a legacy
  // misnomer — the HTTP transport writes authInfo.clientId there, which for
  // OAuth clients is the gbrain_cl_… CLIENT ID (verifyAccessToken returns
  // clientId = row.client_id). Join on i.client_id. CSV via ?format=csv.

  app.get('/admin/api/cp/usage', requireAdmin, async (req, res) => {
    try {
      const month = typeof req.query.month === 'string' ? req.query.month
        : new Date().toISOString().slice(0, 7);
      if (!MONTH_RE.test(month)) return bad(res, 'month must be YYYY-MM');
      const tenantSlug = typeof req.query.tenant === 'string' ? req.query.tenant : null;

      const rows = await sql`
        SELECT t.slug AS tenant, coalesce(p.slug, '-') AS position,
               i.id AS instance_id, i.client_name, i.source_id, i.status,
               coalesce(rl.calls, 0)::int AS calls,
               coalesce(rl.errors, 0)::int AS errors,
               rl.last_call_at,
               -- Cast away driver footguns: int8 → BigInt (JSON.stringify
               -- rejects it) and NUMERIC → string. spend_cents is
               -- NUMERIC(12,4) (fractional cents — Voyage is 0.12¢/image),
               -- so float8 keeps the fraction; price int4 fits $21M/mo.
               coalesce(sp.spend_cents, 0)::float8 AS spend_cents,
               p.included_calls_month,
               p.price_month_cents::int AS price_month_cents
        FROM cp_agent_instances i
        JOIN cp_tenants t ON t.id = i.tenant_id
        LEFT JOIN cp_positions p ON p.id = i.position_id
        LEFT JOIN LATERAL (
          SELECT count(*) AS calls,
                 count(*) FILTER (WHERE l.status <> 'success') AS errors,
                 max(l.created_at) AS last_call_at
          FROM mcp_request_log l
          WHERE l.token_name = i.client_id
            AND to_char(l.created_at, 'YYYY-MM') = ${month}
        ) rl ON true
        LEFT JOIN LATERAL (
          SELECT sum(s.spend_cents) AS spend_cents
          FROM mcp_spend_log s
          WHERE s.client_id = i.client_id
            AND to_char(s.created_at, 'YYYY-MM') = ${month}
        ) sp ON true
        WHERE ${tenantSlug}::text IS NULL OR t.slug = ${tenantSlug}::text
        ORDER BY t.slug, i.id`;

      if (req.query.format === 'csv') {
        const header = 'tenant,position,instance_id,client_name,source_id,status,calls,errors,spend_cents,included_calls_month,price_month_cents';
        const lines = (rows as Record<string, unknown>[]).map(r =>
          [r.tenant, r.position, r.instance_id, r.client_name, r.source_id, r.status,
           r.calls, r.errors, r.spend_cents, r.included_calls_month ?? '', r.price_month_cents ?? '']
            .join(','));
        res.type('text/csv').send([header, ...lines].join('\n'));
        return;
      }
      res.json({ month, usage: rows });
    } catch (e) { fail(res, e); }
  });
}
