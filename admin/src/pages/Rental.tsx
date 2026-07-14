import React, { useEffect, useState } from 'react';
import { api } from '../api';

/**
 * Rental control plane (2026-07-10) — tenants, position catalog, agent
 * instances (one-click provision), request queue, monthly usage. Backed by
 * /admin/api/cp/* (src/commands/serve-http-cp.ts, migration v123).
 */

interface Tenant { id: number; slug: string; name: string; status: string; plan: string | null; instance_count: number; created_at: string }
interface Position {
  id: number; slug: string; name: string; version: string; status: string;
  price_month_cents: number; included_calls_month: number | null; instance_count: number;
  // v124 product-console fields (null until a bundle is published via the CLI).
  eval_score: number | null; eval_model: string | null; evald_at: string | null;
  published_at: string | null; artifact_digest: string | null; pack_name: string | null;
  calls_30d: number; avg_rating: number; rating_count: number; flag_count: number;
}
interface Rating { id: number; stars: number | null; flagged: boolean; comment: string | null; tenant_slug: string | null; created_at: string }
interface Instance { id: number; tenant_slug: string; tenant_name: string; position_slug: string | null; client_id: string; client_name: string; source_id: string; status: string; client_disabled: boolean; provisioned_at: string }
interface RentalRequest { id: number; tenant_slug: string | null; tenant_name: string | null; position_slug: string | null; requested_by: string | null; note: string | null; created_at: string }
interface UsageRow { tenant: string; position: string; instance_id: number; client_name: string; source_id: string; status: string; calls: number; errors: number; spend_cents: number; included_calls_month: number | null }

interface Provision { clientId: string; clientSecret?: string; sourceId: string }

export function RentalPage() {
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [positions, setPositions] = useState<Position[]>([]);
  const [instances, setInstances] = useState<Instance[]>([]);
  const [requests, setRequests] = useState<RentalRequest[]>([]);
  const [usage, setUsage] = useState<UsageRow[]>([]);
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [error, setError] = useState('');
  // One-time credential display after a provision — the secret is stored
  // hashed server-side and can never be shown again.
  const [provisioned, setProvisioned] = useState<Provision | null>(null);
  // Ratings drill-down for one position (product-quality signal).
  const [ratingsFor, setRatingsFor] = useState<{ pos: Position; rows: Rating[] } | null>(null);

  const [tSlug, setTSlug] = useState(''); const [tName, setTName] = useState('');
  const [pSlug, setPSlug] = useState(''); const [pName, setPName] = useState('');
  const [pPrice, setPPrice] = useState('0'); const [pStatus, setPStatus] = useState('published');
  const [iTenant, setITenant] = useState(''); const [iPosition, setIPosition] = useState('');
  const [iBudget, setIBudget] = useState('5');

  const reload = async () => {
    try {
      const [t, p, i, r, u] = await Promise.all([
        api.cpTenants(), api.cpPositions(), api.cpInstances(),
        api.cpRequests(), api.cpUsage(month),
      ]);
      setTenants(t.tenants); setPositions(p.positions); setInstances(i.instances);
      setRequests(r.requests); setUsage(u.usage); setError('');
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  useEffect(() => { reload(); }, [month]);

  const run = (fn: () => Promise<unknown>) => async () => {
    try { await fn(); await reload(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  const createTenant = run(async () => { await api.cpCreateTenant(tSlug, tName); setTSlug(''); setTName(''); });
  const savePosition = run(async () => {
    await api.cpSavePosition({ slug: pSlug, name: pName, priceMonthCents: Math.round(Number(pPrice) * 100), status: pStatus });
    setPSlug(''); setPName(''); setPPrice('0');
  });
  const provision = run(async () => {
    const res = await api.cpProvision(Number(iTenant), iPosition ? Number(iPosition) : null, Number(iBudget));
    setProvisioned(res as Provision);
  });

  const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;
  const openRatings = (pos: Position) => async () => {
    try {
      const res = await api.cpPositionRatings(pos.id);
      setRatingsFor({ pos, rows: res.ratings as Rating[] });
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  return (
    <div>
      <h1 className="page-title">Rental Control Plane</h1>
      {error && <div className="warning-bar">{error}</div>}

      {provisioned && (
        <div className="modal-overlay" onClick={() => setProvisioned(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-title">Instance provisioned — credentials shown ONCE</div>
            <p>Hand these to the tenant over a secure channel. The secret is stored hashed and cannot be recovered.</p>
            <div className="code-block mono">
              client_id: {provisioned.clientId}<br />
              client_secret: {provisioned.clientSecret ?? '(public client)'}<br />
              source: {provisioned.sourceId}<br />
              token_url: {window.location.origin}/token<br />
              mcp_url: {window.location.origin}/mcp
            </div>
            <button className="btn btn-primary" onClick={() => setProvisioned(null)}>I saved them</button>
          </div>
        </div>
      )}

      <h2 className="section-title">Tenants</h2>
      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        <input placeholder="slug (a-z0-9-, ≤19)" value={tSlug} onChange={e => setTSlug(e.target.value)} />
        <input placeholder="Display name" value={tName} onChange={e => setTName(e.target.value)} />
        <button className="btn btn-primary" onClick={createTenant} disabled={!tSlug || !tName}>Add tenant</button>
      </div>
      <table>
        <thead><tr><th>slug</th><th>name</th><th>status</th><th>plan</th><th>instances</th><th></th></tr></thead>
        <tbody>
          {tenants.map(t => (
            <tr key={t.id}>
              <td className="mono">{t.slug}</td><td>{t.name}</td><td>{t.status}</td>
              <td>{t.plan ?? '-'}</td><td>{t.instance_count}</td>
              <td>
                {t.status === 'active'
                  ? <button className="btn btn-danger" onClick={run(() => api.cpTenantStatus(t.id, 'suspended'))}>Suspend</button>
                  : <button className="btn btn-secondary" onClick={run(() => api.cpTenantStatus(t.id, 'active'))}>Reactivate</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2 className="section-title">Position catalog</h2>
      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        <input placeholder="slug" value={pSlug} onChange={e => setPSlug(e.target.value)} />
        <input placeholder="Name" value={pName} onChange={e => setPName(e.target.value)} />
        <input placeholder="Price USD/mo" value={pPrice} onChange={e => setPPrice(e.target.value)} style={{ width: 100 }} />
        <select value={pStatus} onChange={e => setPStatus(e.target.value)}>
          <option value="draft">draft</option><option value="published">published</option><option value="retired">retired</option>
        </select>
        <button className="btn btn-primary" onClick={savePosition} disabled={!pSlug || !pName}>Save position</button>
      </div>
      <table>
        <thead><tr>
          <th>slug</th><th>name</th><th>version</th><th>eval</th><th>price/mo</th>
          <th>status</th><th>installs</th><th>calls/30d</th><th>rating</th><th></th>
        </tr></thead>
        <tbody>
          {positions.map(p => (
            <tr key={p.id}>
              <td className="mono">{p.slug}</td><td>{p.name}</td><td>{p.version}</td>
              <td>{p.eval_score != null
                ? <span title={`${p.eval_model ?? ''} · ${p.evald_at?.slice(0, 10) ?? ''}`}
                        style={{ color: p.eval_score >= 0.6 ? '#3fb950' : '#d29922' }}>
                    {(p.eval_score * 100).toFixed(0)}%
                  </span>
                : <span style={{ color: '#666' }}>—</span>}</td>
              <td>{money(p.price_month_cents)}</td>
              <td>{p.status}{!p.artifact_digest ? ' (no bundle)' : ''}</td>
              <td>{p.instance_count}</td>
              <td>{p.calls_30d}</td>
              <td>
                {p.rating_count > 0
                  ? <button className="btn btn-link" onClick={openRatings(p)}>
                      ★ {p.avg_rating.toFixed(1)} ({p.rating_count}){p.flag_count > 0
                        ? <span style={{ color: '#f85149' }}> ⚑{p.flag_count}</span> : null}
                    </button>
                  : <span style={{ color: '#666' }}>—</span>}
              </td>
              <td style={{ display: 'flex', gap: 4 }}>
                {p.status !== 'retired' && <button className="btn btn-secondary" onClick={run(() => api.cpRetirePosition(p.id))}>Retire</button>}
                {p.status === 'retired' && p.artifact_digest && <button className="btn btn-primary" onClick={run(() => api.cpRepublishPosition(p.id))}>Republish</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p style={{ color: '#888', fontSize: 12, marginTop: 4 }}>
        Publishing a bundle + eval score is the <code>jusaihub pack publish</code> CLI (from JusHub).
        The catalog row here only flips lifecycle + shows product signals.
      </p>

      {ratingsFor && (
        <div className="modal-overlay" onClick={() => setRatingsFor(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-title">Ratings — {ratingsFor.pos.name}</div>
            {ratingsFor.rows.length === 0 ? <p>No ratings yet.</p> : (
              <table>
                <thead><tr><th>tenant</th><th>stars</th><th>flag</th><th>comment</th><th>when</th></tr></thead>
                <tbody>
                  {ratingsFor.rows.map(r => (
                    <tr key={r.id}>
                      <td className="mono">{r.tenant_slug ?? '-'}</td>
                      <td>{r.stars != null ? '★'.repeat(r.stars) : '-'}</td>
                      <td>{r.flagged ? '⚑' : ''}</td>
                      <td>{r.comment ?? '-'}</td>
                      <td>{r.created_at?.slice(0, 10)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <button className="btn btn-primary" onClick={() => setRatingsFor(null)}>Close</button>
          </div>
        </div>
      )}

      <h2 className="section-title">Agent instances</h2>
      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        <select value={iTenant} onChange={e => setITenant(e.target.value)}>
          <option value="">— tenant —</option>
          {tenants.filter(t => t.status === 'active').map(t => <option key={t.id} value={t.id}>{t.slug}</option>)}
        </select>
        <select value={iPosition} onChange={e => setIPosition(e.target.value)}>
          <option value="">(no position template)</option>
          {positions.filter(p => p.status === 'published').map(p => <option key={p.id} value={p.id}>{p.slug}</option>)}
        </select>
        <input placeholder="Budget USD/day" value={iBudget} onChange={e => setIBudget(e.target.value)} style={{ width: 110 }} />
        <button className="btn btn-primary" onClick={provision} disabled={!iTenant}>Provision instance</button>
      </div>
      <table>
        <thead><tr><th>tenant</th><th>position</th><th>source</th><th>client</th><th>status</th><th></th></tr></thead>
        <tbody>
          {instances.map(i => (
            <tr key={i.id}>
              <td className="mono">{i.tenant_slug}</td><td>{i.position_slug ?? '-'}</td>
              <td className="mono">{i.source_id}</td>
              <td className="mono" title={i.client_id}>{i.client_name}</td>
              <td>{i.status}{i.client_disabled && i.status === 'active' ? ' (client off)' : ''}</td>
              <td style={{ display: 'flex', gap: 4 }}>
                {i.status === 'active' && <button className="btn btn-secondary" onClick={run(() => api.cpInstanceAction(i.id, 'suspend'))}>Suspend</button>}
                {i.status === 'suspended' && <button className="btn btn-secondary" onClick={run(() => api.cpInstanceAction(i.id, 'resume'))}>Resume</button>}
                {i.status !== 'revoked' && (
                  <button className="btn btn-danger" onClick={() => {
                    if (confirm(`Permanently revoke ${i.client_name}? The credential cannot be recovered.`)) {
                      run(() => api.cpInstanceAction(i.id, 'revoke'))();
                    }
                  }}>Revoke</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2 className="section-title">Pending requests</h2>
      {requests.length === 0 ? <div className="feed-empty">No pending requests</div> : (
        <table>
          <thead><tr><th>tenant</th><th>position</th><th>by</th><th>note</th><th></th></tr></thead>
          <tbody>
            {requests.map(r => (
              <tr key={r.id}>
                <td className="mono">{r.tenant_slug ?? '-'}</td><td>{r.position_slug ?? '-'}</td>
                <td>{r.requested_by ?? '-'}</td><td>{r.note ?? '-'}</td>
                <td style={{ display: 'flex', gap: 4 }}>
                  <button className="btn btn-primary" onClick={run(async () => {
                    const res = await api.cpDecide(r.id, 'approve');
                    if (res.provision) setProvisioned(res.provision as Provision);
                  })}>Approve</button>
                  <button className="btn btn-danger" onClick={run(() => api.cpDecide(r.id, 'reject'))}>Reject</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2 className="section-title">Usage — {month}</h2>
      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        <input type="month" value={month} onChange={e => setMonth(e.target.value)} />
        <a className="btn btn-secondary" href={`/admin/api/cp/usage?month=${month}&format=csv`} target="_blank" rel="noreferrer">CSV</a>
      </div>
      <table>
        <thead><tr><th>tenant</th><th>position</th><th>source</th><th>calls</th><th>errors</th><th>spend</th><th>included</th></tr></thead>
        <tbody>
          {usage.map(u => (
            <tr key={u.instance_id}>
              <td className="mono">{u.tenant}</td><td>{u.position}</td><td className="mono">{u.source_id}</td>
              <td>{u.calls}</td><td>{u.errors}</td><td>{money(u.spend_cents)}</td>
              <td>{u.included_calls_month ?? '∞'}{u.included_calls_month != null && u.calls > u.included_calls_month ? ' ⚠ over' : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
