/**
 * Marketplace registry for the "AI position rental" platform — the pack
 * REGISTRY half of the control plane. Kept in its OWN module (mounted from
 * serve-http.ts with one call) so the fork's touch-points on upstream files
 * stay minimal — see deploy/linux/README.md "fork drift" note and UPSTREAM.md.
 *
 * Two surfaces (migration v124 columns on cp_positions + cp_position_rating):
 *
 *   VENDOR (admin cookie OR bootstrap bearer token — the `jusaihub pack
 *   publish` CLI is a machine, so it can't hold a cookie):
 *     POST /admin/api/cp/positions/publish        upload signed .zip + eval,
 *                                                 upsert-by-slug, set published
 *     POST /admin/api/cp/positions/:id/retire     status → retired
 *     POST /admin/api/cp/positions/:id/republish  status → published (needs an
 *                                                 already-uploaded artifact)
 *
 *   TENANT (OAuth client_credentials — the SAME grant JusHub uses for /mcp;
 *   read scope). NOT admin — JusHub is a tenant browsing the storefront:
 *     GET  /api/catalog/positions                 list published positions
 *     GET  /api/catalog/positions/:slug/bundle    stream the signed .zip
 *     POST /api/catalog/positions/:slug/rating    satisfaction/flag feed
 *
 * The platform is a DUMB registry: it never re-verifies the Ed25519 signature.
 * Trust is enforced at INSTALL time by JusHub (PositionPack.InstallFromArchive
 * + PACK_REQUIRE_SIGNATURE). Publishing here only transports the exact same
 * signed bundle the JusHub CLI produces.
 */
import type { Express, Request, Response, NextFunction } from 'express';
import express from 'express';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { mkdirSync, existsSync, writeFileSync, createReadStream } from 'node:fs';
import type { SqlQuery, GBrainOAuthProvider } from '../core/oauth-provider.ts';
import type { AuthInfo } from '../core/operations.ts';

/** Root for stored signed pack bundles (one file per <slug>-<version>). */
const PACK_BUNDLES_DIR = process.env.GBRAIN_PACK_BUNDLES_DIR ?? '/srv/pack-bundles';
/** Mirror of JusHub's packArchiveMaxBytes (pack_manager.go). */
const PACK_BUNDLE_MAX = 20 * 1024 * 1024;
const POSITION_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;
/** Local ZIP entry magic — reject anything that isn't a real archive. */
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

interface RegistryOpts {
  app: Express;
  sql: SqlQuery;
  oauthProvider: GBrainOAuthProvider;
  /** Cookie-session admin gate (from serve-http.ts). */
  requireAdmin: (req: Request, res: Response, next: NextFunction) => void;
  /** Constant-time bootstrap-token check (captures bootstrapHash) — lets the
   * publish CLI authenticate with Authorization: Bearer <bootstrapToken>. */
  verifyAdminToken: (token: string) => boolean;
}

function bad(res: Response, msg: string): void { res.status(400).json({ error: msg }); }
function fail(res: Response, e: unknown): void {
  res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
}

/** Sanitize a header value to a single trimmed line (headers are attacker-
 * controlled on the tenant side; vendor side is trusted but keep it tidy). */
function hdr(req: Request, name: string): string | null {
  const v = req.header(name);
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length ? t.slice(0, 512) : null;
}

export function mountRegistry({ app, sql, oauthProvider, requireAdmin, verifyAdminToken }: RegistryOpts): void {
  const json = express.json();
  // Tenant-facing gate: identical to /mcp (OAuth bearer + read scope).
  const requireRead = requireBearerAuth({ verifier: oauthProvider, requiredScopes: ['read'] });

  // Admin cookie OR bootstrap bearer (for the publish CLI).
  function requireVendor(req: Request, res: Response, next: NextFunction): void {
    const auth = String(req.headers.authorization ?? '');
    const m = auth.match(/^Bearer\s+(\S+)$/i);
    if (m && verifyAdminToken(m[1])) { next(); return; }
    requireAdmin(req, res, next);
  }

  // ── vendor: publish (upload signed bundle + eval, upsert-by-slug) ────────
  // Raw zip body; metadata via X-* headers so no multipart dependency (mirrors
  // the /ingest raw-body pattern). Idempotent per (slug,version): re-publishing
  // overwrites the stored bundle + refreshes eval.
  app.post('/admin/api/cp/positions/publish', requireVendor,
    express.raw({ type: () => true, limit: PACK_BUNDLE_MAX }),
    async (req: Request, res: Response) => {
      try {
        const slug = hdr(req, 'x-pack-slug');
        if (!slug || !POSITION_SLUG_RE.test(slug)) {
          return bad(res, 'X-Pack-Slug header must match ^[a-z0-9][a-z0-9-]{0,30}$');
        }
        const version = hdr(req, 'x-pack-version') ?? '1.0.0';
        const packName = hdr(req, 'x-pack-name');
        const name = hdr(req, 'x-position-name') ?? packName ?? slug;
        const description = hdr(req, 'x-position-description');
        const signerKey = hdr(req, 'x-signer-key');
        const contentDigest = hdr(req, 'x-content-digest');
        const evalModel = hdr(req, 'x-eval-model');
        const priceRaw = hdr(req, 'x-price-month-cents');
        const includedRaw = hdr(req, 'x-included-calls-month');

        let evalScore: number | null = null;
        const evalRaw = hdr(req, 'x-eval-score');
        if (evalRaw != null) {
          const n = Number(evalRaw);
          if (!Number.isFinite(n) || n < 0 || n > 1) return bad(res, 'X-Eval-Score must be 0..1');
          evalScore = n;
        }

        const body = req.body;
        if (!Buffer.isBuffer(body) || body.length === 0) return bad(res, 'empty bundle body');
        if (body.length > PACK_BUNDLE_MAX) return bad(res, 'bundle exceeds 20MB');
        if (!body.subarray(0, 4).equals(ZIP_MAGIC)) return bad(res, 'body is not a .zip archive');

        if (!existsSync(PACK_BUNDLES_DIR)) mkdirSync(PACK_BUNDLES_DIR, { recursive: true });
        const artifactPath = `${PACK_BUNDLES_DIR}/${slug}-${version}.zip`;
        writeFileSync(artifactPath, body);

        const priceCents = priceRaw != null && Number.isFinite(Number(priceRaw)) ? Number(priceRaw) : null;
        const included = includedRaw != null && Number.isFinite(Number(includedRaw)) ? Number(includedRaw) : null;
        const evaldAt = evalScore != null ? new Date() : null;

        // Upsert by slug: attach the bundle + eval, publish. COALESCE keeps a
        // previously-set price/description when the CLI omits it.
        const rows = await sql`
          INSERT INTO cp_positions
            (slug, name, description, version, price_month_cents, included_calls_month, status,
             artifact_path, artifact_digest, artifact_size, eval_score, eval_model, evald_at,
             pack_name, signer_key, published_at)
          VALUES
            (${slug}, ${name}, ${description}, ${version}, ${priceCents ?? 0}, ${included}, 'published',
             ${artifactPath}, ${contentDigest}, ${body.length}, ${evalScore},
             ${evalModel}, ${evaldAt},
             ${packName}, ${signerKey}, now())
          ON CONFLICT (slug) DO UPDATE SET
            name = EXCLUDED.name,
            description = COALESCE(EXCLUDED.description, cp_positions.description),
            version = EXCLUDED.version,
            price_month_cents = COALESCE(${priceCents}, cp_positions.price_month_cents),
            included_calls_month = COALESCE(${included}, cp_positions.included_calls_month),
            status = 'published',
            artifact_path = EXCLUDED.artifact_path,
            artifact_digest = EXCLUDED.artifact_digest,
            artifact_size = EXCLUDED.artifact_size,
            eval_score = COALESCE(EXCLUDED.eval_score, cp_positions.eval_score),
            eval_model = COALESCE(EXCLUDED.eval_model, cp_positions.eval_model),
            evald_at = COALESCE(EXCLUDED.evald_at, cp_positions.evald_at),
            pack_name = COALESCE(EXCLUDED.pack_name, cp_positions.pack_name),
            signer_key = COALESCE(EXCLUDED.signer_key, cp_positions.signer_key),
            published_at = now()
          RETURNING id, slug, name, version, status, eval_score, evald_at,
                    artifact_size::int AS artifact_size, published_at`;
        res.json({ position: rows[0] });
      } catch (e) { fail(res, e); }
    });

  app.post('/admin/api/cp/positions/:id/retire', requireVendor, json, async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) return bad(res, 'bad position id');
      const rows = await sql`UPDATE cp_positions SET status = 'retired' WHERE id = ${id} RETURNING id, slug, status`;
      if (rows.length === 0) return bad(res, 'position not found');
      res.json({ position: rows[0] });
    } catch (e) { fail(res, e); }
  });

  // Flip a retired-but-already-uploaded position back to published. Refuses if
  // it never had a bundle (publish the bundle via the CLI first).
  app.post('/admin/api/cp/positions/:id/republish', requireVendor, json, async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) return bad(res, 'bad position id');
      const cur = await sql`SELECT artifact_path FROM cp_positions WHERE id = ${id}`;
      if (cur.length === 0) return bad(res, 'position not found');
      if (!cur[0].artifact_path) return bad(res, 'position has no uploaded artifact — publish via the CLI first');
      const rows = await sql`
        UPDATE cp_positions SET status = 'published', published_at = now()
        WHERE id = ${id} RETURNING id, slug, status`;
      res.json({ position: rows[0] });
    } catch (e) { fail(res, e); }
  });

  // ── tenant: catalog browse ──────────────────────────────────────────────

  app.get('/api/catalog/positions', requireRead, async (_req: Request, res: Response) => {
    try {
      const rows = await sql`
        SELECT p.slug, p.name, p.description, p.version, p.pack_name,
               p.eval_score, p.eval_model, p.evald_at,
               p.price_month_cents::int AS price_month_cents,
               p.included_calls_month, p.published_at,
               round(avg(r.stars)::numeric, 2)::float8 AS avg_rating,
               count(r.id) FILTER (WHERE r.stars IS NOT NULL)::int AS rating_count
        FROM cp_positions p
        LEFT JOIN cp_position_rating r ON r.position_id = p.id
        WHERE p.status = 'published' AND p.artifact_path IS NOT NULL
        GROUP BY p.id
        ORDER BY p.name`;
      res.json({ positions: rows });
    } catch (e) { fail(res, e); }
  });

  app.get('/api/catalog/positions/:slug/bundle', requireRead, async (req: Request, res: Response) => {
    try {
      const slug = String(req.params.slug ?? '');
      if (!POSITION_SLUG_RE.test(slug)) return bad(res, 'bad slug');
      const rows = await sql`
        SELECT artifact_path, version FROM cp_positions
        WHERE slug = ${slug} AND status = 'published' AND artifact_path IS NOT NULL`;
      if (rows.length === 0) return res.status(404).json({ error: 'position not found or not published' });
      const path = String(rows[0].artifact_path);
      if (!existsSync(path)) return res.status(410).json({ error: 'artifact missing on server' });
      res.type('application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${slug}-${rows[0].version}.zip"`);
      createReadStream(path).pipe(res);
    } catch (e) { fail(res, e); }
  });

  app.post('/api/catalog/positions/:slug/rating', requireRead, json, async (req: Request, res: Response) => {
    try {
      const slug = String(req.params.slug ?? '');
      if (!POSITION_SLUG_RE.test(slug)) return bad(res, 'bad slug');
      const authInfo = (req as Request & { auth?: AuthInfo }).auth as AuthInfo;
      const { stars, flagged, comment } = (req.body ?? {}) as { stars?: number; flagged?: boolean; comment?: string };
      if (stars !== undefined && (!Number.isInteger(stars) || stars < 1 || stars > 5)) {
        return bad(res, 'stars must be an integer 1..5');
      }
      const pos = await sql`SELECT id FROM cp_positions WHERE slug = ${slug}`;
      if (pos.length === 0) return res.status(404).json({ error: 'position not found' });
      const positionId = pos[0].id as number;
      // Resolve the rating tenant from the caller's client_id (a shared service
      // client that isn't a rental instance leaves tenant_id null — R2).
      const inst = await sql`SELECT tenant_id FROM cp_agent_instances WHERE client_id = ${authInfo.clientId} LIMIT 1`;
      const tenantId = inst.length ? (inst[0].tenant_id as number | null) : null;
      const rows = await sql`
        INSERT INTO cp_position_rating (position_id, tenant_id, client_id, stars, flagged, comment)
        VALUES (${positionId}, ${tenantId}, ${authInfo.clientId},
                ${stars ?? null}, ${flagged === true}, ${typeof comment === 'string' ? comment.slice(0, 2000) : null})
        RETURNING id, created_at`;
      res.json({ rating: rows[0] });
    } catch (e) { fail(res, e); }
  });
}
