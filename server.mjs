// TenantGuard — M365 governance & security dashboard.
// Zero-dependency Node.js server: stdlib http + static files + JSON API.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getState, save, resetDemo, newId, logActivity } from './lib/store.mjs';
import { buildSummary, computeFindings } from './lib/insights.mjs';
import { testConnection, syncTenant, scanSharing } from './lib/graph.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(ROOT, 'public');
const PORT = Number(process.env.PORT || 8080);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

// ---------- helpers ----------

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => {
      data += c;
      if (data.length > 1e6) { reject(new Error('Body too large')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

const userName = (s, id) => s.users.find(u => u.id === id)?.name ?? id;
const siteName = (s, id) => s.sites.find(x => x.id === id)?.name ?? id;

// Attach display info the frontend needs, without leaking the whole store.
function decorateReview(s, r) {
  const decided = r.items.filter(i => i.decision).length;
  return {
    ...r,
    reviewer: userName(s, r.reviewerId),
    progress: r.items.length ? Math.round((decided / r.items.length) * 100) : 100,
    items: r.items.map(i => ({
      ...i,
      principal: s.users.find(u => u.id === i.principalId) ?? { name: i.principalId, email: '' },
      siteName: siteName(s, i.siteId),
    })),
  };
}

// ---------- API routes ----------

const routes = [];
function route(method, pattern, handler) {
  // pattern like /api/sites/:id — compile to regex with named groups
  const rx = new RegExp('^' + pattern.replace(/:[^/]+/g, m => `(?<${m.slice(1)}>[^/]+)`) + '$');
  routes.push({ method, rx, handler });
}

route('GET', '/api/summary', (s) => buildSummary(s));

route('GET', '/api/sites', (s, _p, q) => {
  const findings = computeFindings(s);
  const term = (q.get('search') || '').toLowerCase();
  return s.sites
    .filter(x => !term || x.name.toLowerCase().includes(term) || (x.department ?? '').toLowerCase().includes(term))
    .map(x => ({
      ...x,
      owners: (s.groups.find(g => g.id === x.groupId)?.owners ?? []).map(id => userName(s, id)),
      findingCount: findings.filter(f => f.kind === 'site' && f.targetId === x.id).length,
      linkCount: s.links.filter(l => l.siteId === x.id && !l.revoked).length,
      guestCount: s.permissions.filter(p => p.siteId === x.id && p.source === 'Guest access').length,
    }));
});

route('GET', '/api/sites/:id', (s, p) => {
  const site = s.sites.find(x => x.id === p.id);
  if (!site) return { __status: 404, error: 'Site not found' };
  const group = s.groups.find(g => g.id === site.groupId);
  return {
    ...site,
    group: group ? { ...group, ownerNames: group.owners.map(id => userName(s, id)) } : null,
    permissions: s.permissions.filter(x => x.siteId === site.id).map(x => ({
      ...x,
      principal: s.users.find(u => u.id === x.principalId) ?? { name: x.principalId, email: '', type: 'member' },
    })),
    links: s.links.filter(l => l.siteId === site.id && !l.revoked),
    findings: computeFindings(s).filter(f => f.kind === 'site' && f.targetId === site.id),
  };
});

route('POST', '/api/sites/:id/disable-external', (s, p) => {
  const site = s.sites.find(x => x.id === p.id);
  if (!site) return { __status: 404, error: 'Site not found' };
  site.externalSharing = 'internal-only';
  logActivity('External sharing disabled', `${site.name} set to internal only`);
  save();
  return { ok: true };
});

route('GET', '/api/groups', (s) => {
  return s.groups.map(g => ({
    ...g,
    ownerNames: g.owners.map(id => userName(s, id)),
    memberCount: g.members.length,
    guestCount: g.guests.length,
    siteName: g.siteId ? siteName(s, g.siteId) : null,
  }));
});

route('POST', '/api/groups/:id/owners', async (s, p, _q, body) => {
  const g = s.groups.find(x => x.id === p.id);
  if (!g) return { __status: 404, error: 'Group not found' };
  const user = s.users.find(u => u.id === body.userId && u.type === 'member');
  if (!user) return { __status: 400, error: 'Pick an internal user to promote to owner' };
  if (!g.owners.includes(user.id)) g.owners.push(user.id);
  if (!g.members.includes(user.id)) g.members.push(user.id);
  logActivity('Owner assigned', `${user.name} is now an owner of ${g.name}`);
  save();
  return { ok: true };
});

route('GET', '/api/users', (s, _p, q) => {
  const type = q.get('type');
  const staleDays = s.settings.thresholds?.staleGuestDays ?? 90;
  return s.users
    .filter(u => u.enabled && (!type || u.type === type))
    .map(u => {
      const groupsIn = s.groups.filter(g => g.members.includes(u.id) || g.guests.includes(u.id)).map(g => g.name);
      const sitesShared = s.permissions.filter(pm => pm.principalId === u.id).map(pm => siteName(s, pm.siteId));
      const days = u.lastSignIn ? Math.floor((Date.now() - new Date(u.lastSignIn)) / 86400000) : null;
      return {
        ...u,
        invitedByName: u.invitedBy ? userName(s, u.invitedBy) : null,
        daysSinceSignIn: days,
        stale: u.type === 'guest' && (days === null || days >= staleDays),
        groups: groupsIn,
        sites: [...new Set(sitesShared)],
      };
    });
});

route('POST', '/api/users/:id/remove', (s, p) => {
  const u = s.users.find(x => x.id === p.id);
  if (!u) return { __status: 404, error: 'User not found' };
  u.enabled = false;
  // Strip their access everywhere
  s.permissions = s.permissions.filter(pm => pm.principalId !== u.id);
  for (const g of s.groups) {
    g.owners = g.owners.filter(id => id !== u.id);
    g.members = g.members.filter(id => id !== u.id);
    g.guests = g.guests.filter(id => id !== u.id);
  }
  logActivity(u.type === 'guest' ? 'Guest removed' : 'User access removed', `${u.name} (${u.email}) removed from all sites and groups`);
  save();
  return { ok: true };
});

route('GET', '/api/links', (s, _p, q) => {
  const type = q.get('type');
  return s.links
    .filter(l => !l.revoked && (!type || l.type === type))
    .map(l => ({
      ...l,
      siteName: siteName(s, l.siteId),
      sensitivity: s.sites.find(x => x.id === l.siteId)?.sensitivity ?? 'General',
      createdByName: userName(s, l.createdBy),
    }));
});

route('POST', '/api/links/:id/revoke', (s, p) => {
  const l = s.links.find(x => x.id === p.id);
  if (!l) return { __status: 404, error: 'Link not found' };
  l.revoked = true;
  logActivity('Sharing link revoked', `${l.type} link on ${l.item} (${siteName(s, l.siteId)})`);
  save();
  return { ok: true };
});

route('POST', '/api/links/:id/expiry', (s, p, _q, body) => {
  const l = s.links.find(x => x.id === p.id);
  if (!l) return { __status: 404, error: 'Link not found' };
  const days = Number(body.days) || 30;
  l.expires = new Date(Date.now() + days * 86400000).toISOString();
  logActivity('Link expiration set', `${l.item} now expires in ${days} days`);
  save();
  return { ok: true };
});

route('GET', '/api/reviews', (s) => s.reviews.map(r => decorateReview(s, r)));
route('GET', '/api/reviews/:id', (s, p) => {
  const r = s.reviews.find(x => x.id === p.id);
  return r ? decorateReview(s, r) : { __status: 404, error: 'Review not found' };
});

route('POST', '/api/reviews', (s, _p, _q, body) => {
  const { name, scope, reviewerId, dueInDays = 14 } = body;
  if (!name) return { __status: 400, error: 'Review name is required' };
  const review = {
    id: newId('rev'),
    name,
    scope: scope || 'Custom scope',
    status: 'in-progress',
    createdAt: new Date().toISOString(),
    dueDate: new Date(Date.now() + dueInDays * 86400000).toISOString(),
    reviewerId: reviewerId || s.users.find(u => u.type === 'member')?.id,
    items: [],
  };
  // Scope selection: guests everywhere, guests on a department, or a single site
  let perms = s.permissions.filter(pm => pm.source === 'Guest access');
  if (body.siteId) perms = s.permissions.filter(pm => pm.siteId === body.siteId);
  else if (body.department) {
    const deptSites = new Set(s.sites.filter(x => x.department === body.department).map(x => x.id));
    perms = perms.filter(pm => deptSites.has(pm.siteId));
  }
  perms.forEach((pm, i) => review.items.push({
    id: `ri-${i}`,
    principalId: pm.principalId,
    siteId: pm.siteId,
    role: pm.role,
    decision: null,
    decidedAt: null,
  }));
  s.reviews.unshift(review);
  logActivity('Access review started', `"${name}" — ${review.items.length} access grants to review`);
  save();
  return decorateReview(s, review);
});

route('POST', '/api/reviews/:id/items/:itemId', (s, p, _q, body) => {
  const r = s.reviews.find(x => x.id === p.id);
  const item = r?.items.find(i => i.id === p.itemId);
  if (!item) return { __status: 404, error: 'Review item not found' };
  if (!['approved', 'revoked', null].includes(body.decision)) return { __status: 400, error: 'Decision must be approved or revoked' };
  item.decision = body.decision;
  item.decidedAt = body.decision ? new Date().toISOString() : null;
  save();
  return decorateReview(s, r);
});

route('POST', '/api/reviews/:id/complete', (s, p) => {
  const r = s.reviews.find(x => x.id === p.id);
  if (!r) return { __status: 404, error: 'Review not found' };
  const undecided = r.items.filter(i => !i.decision).length;
  if (undecided > 0) return { __status: 400, error: `${undecided} item(s) still need a decision` };
  // Apply revocations
  let revoked = 0;
  for (const item of r.items.filter(i => i.decision === 'revoked')) {
    s.permissions = s.permissions.filter(pm => !(pm.principalId === item.principalId && pm.siteId === item.siteId));
    const site = s.sites.find(x => x.id === item.siteId);
    const grp = s.groups.find(g => g.siteId === item.siteId || g.id === site?.groupId);
    if (grp) {
      grp.guests = grp.guests.filter(id => id !== item.principalId);
      grp.members = grp.members.filter(id => id !== item.principalId);
    }
    revoked++;
  }
  r.status = 'completed';
  r.completedAt = new Date().toISOString();
  logActivity('Access review completed', `"${r.name}" — ${revoked} access grant(s) revoked, ${r.items.length - revoked} approved`);
  save();
  return decorateReview(s, r);
});

// Policies whose violations the enforce endpoint can remediate automatically.
// Others (assign owner, start review) need a human choice, so no "Fix all".
const AUTO_FIXABLE = new Set(['pol-anyone-links', 'pol-link-expiry', 'pol-guest-expiry', 'pol-confidential-external']);

route('GET', '/api/policies', (s) => {
  const findings = computeFindings(s);
  return s.policies.map(p => ({
    ...p,
    violations: findings.filter(f => f.policyId === p.id).length,
    fixable: AUTO_FIXABLE.has(p.id) ? findings.filter(f => f.policyId === p.id && f.fix).length : 0,
  }));
});

route('POST', '/api/policies/:id/toggle', (s, p) => {
  const pol = s.policies.find(x => x.id === p.id);
  if (!pol) return { __status: 404, error: 'Policy not found' };
  pol.enabled = !pol.enabled;
  logActivity(pol.enabled ? 'Policy enabled' : 'Policy disabled', pol.name);
  save();
  return { ok: true, enabled: pol.enabled };
});

// One-click enforcement: applies the standard fix for every violation of a policy.
route('POST', '/api/policies/:id/enforce', (s, p) => {
  const pol = s.policies.find(x => x.id === p.id);
  if (!pol) return { __status: 404, error: 'Policy not found' };
  const findings = computeFindings(s).filter(f => f.policyId === pol.id && f.fix);
  let fixed = 0;
  for (const f of findings) {
    if (f.kind === 'link') {
      const l = s.links.find(x => x.id === f.targetId);
      if (!l) continue;
      if (pol.id === 'pol-anyone-links') { l.revoked = true; fixed++; }
      else if (pol.id === 'pol-link-expiry') { l.expires = new Date(Date.now() + 30 * 86400000).toISOString(); fixed++; }
    } else if (f.kind === 'guest' && pol.id === 'pol-guest-expiry') {
      const u = s.users.find(x => x.id === f.targetId);
      if (!u) continue;
      u.enabled = false;
      s.permissions = s.permissions.filter(pm => pm.principalId !== u.id);
      for (const g of s.groups) {
        g.members = g.members.filter(id => id !== u.id);
        g.guests = g.guests.filter(id => id !== u.id);
      }
      fixed++;
    } else if (f.kind === 'site' && pol.id === 'pol-confidential-external') {
      const site = s.sites.find(x => x.id === f.targetId);
      if (site) { site.externalSharing = 'internal-only'; fixed++; }
    }
  }
  logActivity('Policy enforced', `"${pol.name}" — ${fixed} violation(s) auto-remediated`);
  save();
  return { ok: true, fixed };
});

route('GET', '/api/activity', (s) => s.activity);

route('GET', '/api/settings', (s) => ({
  ...s.settings,
  graph: { ...s.settings.graph, clientSecret: s.settings.graph.clientSecret ? '••••••••' : '' },
}));

route('PUT', '/api/settings', (s, _p, _q, body) => {
  if (body.thresholds) s.settings.thresholds = { ...s.settings.thresholds, ...body.thresholds };
  if (body.graph) {
    const g = body.graph;
    s.settings.graph.tenantId = g.tenantId ?? s.settings.graph.tenantId;
    s.settings.graph.clientId = g.clientId ?? s.settings.graph.clientId;
    if (g.clientSecret && g.clientSecret !== '••••••••') s.settings.graph.clientSecret = g.clientSecret;
  }
  save();
  return { ok: true };
});

route('POST', '/api/graph/test', async (s) => {
  try {
    const result = await testConnection(s.settings.graph);
    s.settings.graph.connected = true;
    save();
    return result;
  } catch (err) {
    s.settings.graph.connected = false;
    save();
    return { __status: 400, ok: false, error: err.message };
  }
});

route('POST', '/api/graph/sync', async (s) => {
  try {
    const data = await syncTenant(s.settings.graph, msg => console.log('[sync]', msg));
    s.users = data.users;
    s.groups = data.groups;
    s.sites = data.sites;
    s.links = data.links;
    s.permissions = data.permissions;
    if (data.tenantName) s.settings.tenantName = data.tenantName;
    s.settings.demoMode = false;
    s.settings.graph.connected = true;
    s.settings.graph.lastSync = new Date().toISOString();
    logActivity('Tenant synced', `${data.users.length} users, ${data.groups.length} groups, ${data.sites.length} sites pulled from Microsoft Graph`, 'System');
    save();
    return { ok: true, counts: { users: data.users.length, groups: data.groups.length, sites: data.sites.length } };
  } catch (err) {
    return { __status: 400, ok: false, error: err.message };
  }
});

// Sharing-link scan runs in the background (it can take many minutes on
// large tenants); the frontend polls scan-status until it finishes.
let scan = { running: false, progress: null, error: null, finishedAt: null, result: null };

route('GET', '/api/graph/scan-status', () => scan);

route('POST', '/api/graph/scan-sharing', (s, _p, _q, body) => {
  if (scan.running) return { __status: 409, error: 'A scan is already running' };
  if (s.settings.demoMode) return { __status: 400, error: 'Sync a real tenant first — demo data already includes links' };
  if (!s.sites.length) return { __status: 400, error: 'No sites to scan. Run "Sync tenant now" first.' };
  const maxSites = Math.max(1, Number(body.maxSites) || 100);
  scan = {
    running: true,
    progress: { done: 0, total: Math.min(maxSites, s.sites.length), links: 0, site: '', itemsScanned: 0 },
    error: null, finishedAt: null, result: null,
  };
  scanSharing(s.settings.graph, s.sites, { maxSites }, p => {
    if (p.phase === 'scan' || p.phase === 'done') scan.progress = p;
    else if (p.phase === 'site-error') console.error('[scan]', p.site, '—', p.error);
  })
    .then(r => {
      s.links = r.links;
      scan.result = r;
      const caveats = [
        r.sitesFailed ? `${r.sitesFailed} site(s) FAILED — coverage is incomplete (first error: ${r.errors[0] ?? 'see server log'})` : '',
        r.truncatedDrives ? `${r.truncatedDrives} very large librar${r.truncatedDrives === 1 ? 'y' : 'ies'} truncated` : '',
      ].filter(Boolean).join('; ');
      logActivity(r.sitesFailed ? 'Sharing scan completed WITH ERRORS' : 'Sharing scan completed',
        `${r.links.length} sharing link(s) found across ${r.sitesScanned - r.sitesFailed}/${r.sitesScanned} site(s), ${r.itemsScanned} items inspected` +
        (caveats ? ` (${caveats})` : ''),
        'System');
      save();
    })
    .catch(err => { scan.error = err.message; })
    .finally(() => { scan.running = false; scan.finishedAt = new Date().toISOString(); });
  return { ok: true, started: true };
});

route('POST', '/api/demo/reset', () => {
  resetDemo();
  logActivity('Demo data reset', 'Tenant restored to the original demo state', 'System');
  return { ok: true };
});

// ---------- server ----------

async function serveStatic(res, urlPath) {
  let filePath = urlPath === '/' ? '/index.html' : urlPath;
  filePath = normalize(filePath).replace(/^(\.\.[/\\])+/, '');
  const full = join(PUBLIC_DIR, filePath);
  if (!full.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end(); return; }
  try {
    const data = await readFile(full);
    res.writeHead(200, { 'Content-Type': MIME[extname(full)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    // SPA fallback: unknown non-API paths get the app shell
    const index = await readFile(join(PUBLIC_DIR, 'index.html'));
    res.writeHead(200, { 'Content-Type': MIME['.html'] });
    res.end(index);
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = url.pathname.match(r.rx);
        if (!m) continue;
        const body = req.method === 'GET' ? {} : await readBody(req);
        const result = await r.handler(getState(), m.groups ?? {}, url.searchParams, body);
        const status = result?.__status ?? 200;
        if (result && typeof result === 'object' && '__status' in result) delete result.__status;
        return json(res, status, result);
      }
      return json(res, 404, { error: 'Not found' });
    }
    await serveStatic(res, url.pathname);
  } catch (err) {
    console.error(err);
    json(res, 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`TenantGuard running at http://localhost:${PORT}`);
  console.log(`Data directory: ${process.env.DATA_DIR || './data'}`);
});
