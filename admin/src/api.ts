const BASE = '';

// v0.26.3 trust model (D11 + D12): the admin UI does NOT cache the
// bootstrap token in browser JS state. On 401, redirect to login —
// no auto-reauth via saved token, no localStorage/sessionStorage read.
// The HttpOnly cookie set by /admin/login is the only session credential.
async function apiFetch(path: string, options?: RequestInit) {
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...options?.headers },
  });
  if (res.status === 401) {
    // No token cache to retry from. Redirect to login.
    window.location.hash = '#login';
    throw new Error('Unauthorized');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

// v0.36.1.0 (T15 / E6) — SVG fetch (text/plain payload, NOT JSON).
async function apiFetchText(path: string) {
  const res = await fetch(`${BASE}${path}`, { credentials: 'same-origin' });
  if (res.status === 401) {
    window.location.hash = '#login';
    throw new Error('Unauthorized');
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

export const api = {
  login: (token: string) => apiFetch('/admin/login', { method: 'POST', body: JSON.stringify({ token }) }),
  signOutEverywhere: () => apiFetch('/admin/api/sign-out-everywhere', { method: 'POST' }),
  stats: () => apiFetch('/admin/api/stats'),
  health: () => apiFetch('/admin/api/health-indicators'),
  agents: () => apiFetch('/admin/api/agents'),
  requests: (page = 1, qs = '') => apiFetch(`/admin/api/requests?page=${page}${qs}`),
  apiKeys: () => apiFetch('/admin/api/api-keys'),
  createApiKey: (name: string) => apiFetch('/admin/api/api-keys', { method: 'POST', body: JSON.stringify({ name }) }),
  revokeApiKey: (name: string) => apiFetch('/admin/api/api-keys/revoke', { method: 'POST', body: JSON.stringify({ name }) }),
  updateClientTtl: (clientId: string, tokenTtl: number | null) => apiFetch('/admin/api/update-client-ttl', { method: 'POST', body: JSON.stringify({ clientId, tokenTtl }) }),
  revokeClient: (clientId: string) => apiFetch('/admin/api/revoke-client', { method: 'POST', body: JSON.stringify({ clientId }) }),
  // v0.36.1.0 (T15 / E6) — calibration endpoints.
  calibrationProfile: (holder?: string) =>
    apiFetch(`/admin/api/calibration/profile${holder ? `?holder=${encodeURIComponent(holder)}` : ''}`),
  calibrationChart: (type: string, holder?: string) =>
    apiFetchText(`/admin/api/calibration/charts/${encodeURIComponent(type)}${holder ? `?holder=${encodeURIComponent(holder)}` : ''}`),
  // v0.41 D2 — live minion-jobs dashboard snapshot.
  jobsWatch: () => apiFetch('/admin/api/jobs/watch'),
  // Rental control plane (2026-07-10) — /admin/api/cp/* (serve-http-cp.ts).
  cpTenants: () => apiFetch('/admin/api/cp/tenants'),
  cpCreateTenant: (slug: string, name: string) =>
    apiFetch('/admin/api/cp/tenants', { method: 'POST', body: JSON.stringify({ slug, name }) }),
  cpTenantStatus: (id: number, status: string) =>
    apiFetch(`/admin/api/cp/tenants/${id}/status`, { method: 'POST', body: JSON.stringify({ status }) }),
  cpPositions: () => apiFetch('/admin/api/cp/positions'),
  cpSavePosition: (p: { slug: string; name: string; priceMonthCents: number; status: string }) =>
    apiFetch('/admin/api/cp/positions', { method: 'POST', body: JSON.stringify(p) }),
  // Product-console lifecycle (v124) — retire hides a position from tenants;
  // republish flips a retired-but-uploaded position back (publishing a NEW
  // bundle is the `jusaihub pack publish` CLI, not the SPA).
  cpRetirePosition: (id: number) =>
    apiFetch(`/admin/api/cp/positions/${id}/retire`, { method: 'POST', body: '{}' }),
  cpRepublishPosition: (id: number) =>
    apiFetch(`/admin/api/cp/positions/${id}/republish`, { method: 'POST', body: '{}' }),
  cpPositionRatings: (id: number) => apiFetch(`/admin/api/cp/positions/${id}/ratings`),
  cpInstances: () => apiFetch('/admin/api/cp/instances'),
  cpProvision: (tenantId: number, positionId: number | null, budgetUsdPerDay: number) =>
    apiFetch('/admin/api/cp/instances', { method: 'POST', body: JSON.stringify({ tenantId, positionId, budgetUsdPerDay }) }),
  cpInstanceAction: (id: number, action: 'suspend' | 'resume' | 'revoke') =>
    apiFetch(`/admin/api/cp/instances/${id}/status`, { method: 'POST', body: JSON.stringify({ action }) }),
  cpRequests: (status = 'pending') => apiFetch(`/admin/api/cp/requests?status=${status}`),
  cpDecide: (id: number, decision: 'approve' | 'reject') =>
    apiFetch(`/admin/api/cp/requests/${id}/decide`, { method: 'POST', body: JSON.stringify({ decision }) }),
  cpUsage: (month: string) => apiFetch(`/admin/api/cp/usage?month=${month}`),
};
