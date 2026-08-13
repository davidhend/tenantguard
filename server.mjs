// TenantGuard — M365 governance & security dashboard.
// Zero-dependency Node.js server: stdlib http + static files + JSON API.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getState, save, resetDemo, newId, logActivity } from './lib/store.mjs';
import { buildSummary, computeFindings } from './lib/insights.mjs';
import { testConnection, syncTenant, scanSharing, makeAuth, httpJson, pool } from './lib/graph.mjs';
import { readSharingCapabilities, setSharingCapability } from './lib/spadmin.mjs';

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

// ---------- write-back (enforcement) ----------

// Remediation hits the real tenant only when BOTH are true: live data is
// loaded AND the user explicitly enabled write-back in Settings.
const liveWrites = (s) => !s.settings.demoMode && !!s.settings.writeBack;

let cachedGraphAuth = null;
const graphAuth = (s) => (cachedGraphAuth ??= makeAuth(s.settings.graph));
const resetAuthCache = () => { cachedGraphAuth = null; };

const liveTag = (s) => (liveWrites(s) ? ' (applied to tenant)' : '');

// Scanned link ids are "driveId:itemId:permissionId" — demo/seed links have
// no Graph identity and cannot be written back.
function linkGraphPath(link) {
  const parts = link.id.split(':');
  if (parts.length < 3) return null;
  return `/drives/${parts[0]}/items/${parts[1]}/permissions/${parts.slice(2).join(':')}`;
}

// Remove a user from every group we know they're in. Returns group names
// that failed so callers can report partial success honestly.
async function graphRemoveFromGroups(s, userId) {
  const failures = [];
  const inGroups = s.groups.filter(g => g.members.includes(userId) || g.guests.includes(userId));
  await pool(inGroups, 4, async (g) => {
    try { await httpJson(graphAuth(s), `/groups/${g.id}/members/${userId}/$ref`, { method: 'DELETE' }); }
    catch (err) { failures.push(`${g.name}: ${err.message.slice(0, 120)}`); }
  });
  return failures;
}

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

route('POST', '/api/sites/:id/disable-external', async (s, p) => {
  const site = s.sites.find(x => x.id === p.id);
  if (!site) return { __status: 404, error: 'Site not found' };
  if (liveWrites(s)) {
    try { await setSharingCapability(s.settings.graph, s.sites, site.id, 'internal-only'); }
    catch (err) { return { __status: 502, error: `Tenant update failed: ${err.message}` }; }
  }
  site.externalSharing = 'internal-only';
  logActivity('External sharing disabled' + liveTag(s), `${site.name} set to internal only`);
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
  if (liveWrites(s)) {
    const ref = { '@odata.id': `https://graph.microsoft.com/v1.0/directoryObjects/${user.id}` };
    try { await httpJson(graphAuth(s), `/groups/${g.id}/owners/$ref`, { method: 'POST', body: ref }); }
    catch (err) { return { __status: 502, error: `Tenant update failed: ${err.message}` }; }
    // Owners should usually be members too; "already a member" errors are fine.
    await httpJson(graphAuth(s), `/groups/${g.id}/members/$ref`, { method: 'POST', body: ref }).catch(() => {});
  }
  if (!g.owners.includes(user.id)) g.owners.push(user.id);
  if (!g.members.includes(user.id)) g.members.push(user.id);
  logActivity('Owner assigned' + liveTag(s), `${user.name} is now an owner of ${g.name}`);
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

route('POST', '/api/users/:id/remove', async (s, p) => {
  const u = s.users.find(x => x.id === p.id);
  if (!u) return { __status: 404, error: 'User not found' };
  let failNote = '';
  if (liveWrites(s)) {
    // Disable sign-in first (blocks all access immediately, reversible),
    // then strip group memberships.
    try { await httpJson(graphAuth(s), `/users/${u.id}`, { method: 'PATCH', body: { accountEnabled: false } }); }
    catch (err) { return { __status: 502, error: `Could not disable the account: ${err.message}` }; }
    const failures = await graphRemoveFromGroups(s, u.id);
    if (failures.length) failNote = `; ${failures.length} group removal(s) failed (${failures[0]})`;
  }
  u.enabled = false;
  // Strip their access everywhere
  s.permissions = s.permissions.filter(pm => pm.principalId !== u.id);
  for (const g of s.groups) {
    g.owners = g.owners.filter(id => id !== u.id);
    g.members = g.members.filter(id => id !== u.id);
    g.guests = g.guests.filter(id => id !== u.id);
  }
  logActivity((u.type === 'guest' ? 'Guest removed' : 'User access removed') + liveTag(s),
    `${u.name} (${u.email}) removed from all sites and groups${failNote}`);
  save();
  return { ok: true, warning: failNote || undefined };
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

route('POST', '/api/links/:id/revoke', async (s, p) => {
  const l = s.links.find(x => x.id === p.id);
  if (!l) return { __status: 404, error: 'Link not found' };
  if (liveWrites(s)) {
    const path = linkGraphPath(l);
    if (!path) return { __status: 400, error: 'This link has no Graph identity — re-run the sharing scan first' };
    try { await httpJson(graphAuth(s), path, { method: 'DELETE' }); }
    catch (err) { return { __status: 502, error: `Tenant revoke failed: ${err.message}` }; }
  }
  l.revoked = true;
  logActivity('Sharing link revoked' + liveTag(s), `${l.type} link on ${l.item} (${siteName(s, l.siteId)})`);
  save();
  return { ok: true };
});

route('POST', '/api/links/:id/expiry', async (s, p, _q, body) => {
  const l = s.links.find(x => x.id === p.id);
  if (!l) return { __status: 404, error: 'Link not found' };
  const days = Number(body.days) || 30;
  const expires = new Date(Date.now() + days * 86400000).toISOString();
  if (liveWrites(s)) {
    const path = linkGraphPath(l);
    if (!path) return { __status: 400, error: 'This link has no Graph identity — re-run the sharing scan first' };
    try { await httpJson(graphAuth(s), path, { method: 'PATCH', body: { expirationDateTime: expires } }); }
    catch (err) { return { __status: 502, error: `Tenant update failed: ${err.message}` }; }
  }
  l.expires = expires;
  logActivity('Link expiration set' + liveTag(s), `${l.item} now expires in ${days} days`);
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

route('POST', '/api/reviews/:id/complete', async (s, p) => {
  const r = s.reviews.find(x => x.id === p.id);
  if (!r) return { __status: 404, error: 'Review not found' };
  const undecided = r.items.filter(i => !i.decision).length;
  if (undecided > 0) return { __status: 400, error: `${undecided} item(s) still need a decision` };
  // Apply revocations
  let revoked = 0;
  const failures = [];
  for (const item of r.items.filter(i => i.decision === 'revoked')) {
    const site = s.sites.find(x => x.id === item.siteId);
    const grp = s.groups.find(g => g.siteId === item.siteId || g.id === site?.groupId);
    if (liveWrites(s) && grp) {
      // If the tenant removal fails, keep the local grant too — the model
      // must not claim access was revoked while it still exists.
      try { await httpJson(graphAuth(s), `/groups/${grp.id}/members/${item.principalId}/$ref`, { method: 'DELETE' }); }
      catch (err) {
        failures.push(`${userName(s, item.principalId)} on ${siteName(s, item.siteId)}: ${err.message.slice(0, 120)}`);
        continue;
      }
    }
    s.permissions = s.permissions.filter(pm => !(pm.principalId === item.principalId && pm.siteId === item.siteId));
    if (grp) {
      grp.guests = grp.guests.filter(id => id !== item.principalId);
      grp.members = grp.members.filter(id => id !== item.principalId);
    }
    revoked++;
  }
  r.status = 'completed';
  r.completedAt = new Date().toISOString();
  logActivity('Access review completed' + liveTag(s),
    `"${r.name}" — ${revoked} access grant(s) revoked, ${r.items.length - revoked - failures.length} approved` +
    (failures.length ? `; ${failures.length} revocation(s) FAILED in the tenant (${failures[0]})` : ''));
  save();
  const out = decorateReview(s, r);
  if (failures.length) out.warning = `${failures.length} revocation(s) failed in the tenant and were kept locally: ${failures[0]}`;
  return out;
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

// One-click enforcement: applies the standard fix for every violation of a
// policy. With write-back on, each fix hits the tenant first and the local
// model only updates on success — failures are counted and reported.
route('POST', '/api/policies/:id/enforce', async (s, p) => {
  const pol = s.policies.find(x => x.id === p.id);
  if (!pol) return { __status: 404, error: 'Policy not found' };
  const findings = computeFindings(s).filter(f => f.policyId === pol.id && f.fix);
  const live = liveWrites(s);
  let fixed = 0;
  const failures = [];
  const fail = (label, err) => { if (failures.length < 8) failures.push(`${label}: ${err.message.slice(0, 120)}`); else failures.length++; };

  await pool(findings, live ? 4 : findings.length || 1, async (f) => {
    try {
      if (f.kind === 'link') {
        const l = s.links.find(x => x.id === f.targetId);
        if (!l) return;
        if (pol.id === 'pol-anyone-links') {
          if (live) {
            const path = linkGraphPath(l);
            if (!path) throw new Error('link has no Graph identity');
            await httpJson(graphAuth(s), path, { method: 'DELETE' });
          }
          l.revoked = true; fixed++;
        } else if (pol.id === 'pol-link-expiry') {
          const expires = new Date(Date.now() + 30 * 86400000).toISOString();
          if (live) {
            const path = linkGraphPath(l);
            if (!path) throw new Error('link has no Graph identity');
            await httpJson(graphAuth(s), path, { method: 'PATCH', body: { expirationDateTime: expires } });
          }
          l.expires = expires; fixed++;
        }
      } else if (f.kind === 'guest' && pol.id === 'pol-guest-expiry') {
        const u = s.users.find(x => x.id === f.targetId);
        if (!u) return;
        if (live) {
          await httpJson(graphAuth(s), `/users/${u.id}`, { method: 'PATCH', body: { accountEnabled: false } });
          await graphRemoveFromGroups(s, u.id);
        }
        u.enabled = false;
        s.permissions = s.permissions.filter(pm => pm.principalId !== u.id);
        for (const g of s.groups) {
          g.members = g.members.filter(id => id !== u.id);
          g.guests = g.guests.filter(id => id !== u.id);
        }
        fixed++;
      } else if (f.kind === 'site' && pol.id === 'pol-confidential-external') {
        const site = s.sites.find(x => x.id === f.targetId);
        if (!site) return;
        if (live) await setSharingCapability(s.settings.graph, s.sites, site.id, 'internal-only');
        site.externalSharing = 'internal-only'; fixed++;
      }
    } catch (err) {
      fail(f.title, err);
    }
  });

  logActivity('Policy enforced' + liveTag(s),
    `"${pol.name}" — ${fixed} violation(s) remediated` +
    (failures.length ? `; ${failures.length} FAILED (${failures[0]})` : ''));
  save();
  return { ok: true, fixed, failed: failures.length, errors: failures };
});

route('GET', '/api/activity', (s) => s.activity);

const MASK = '••••••••';

route('GET', '/api/settings', (s) => ({
  ...s.settings,
  writeBack: !!s.settings.writeBack,
  graph: {
    ...s.settings.graph,
    clientSecret: s.settings.graph.clientSecret ? MASK : '',
    privateKey: s.settings.graph.privateKey ? MASK : '',
  },
}));

route('PUT', '/api/settings', (s, _p, _q, body) => {
  if (body.thresholds) s.settings.thresholds = { ...s.settings.thresholds, ...body.thresholds };
  if (body.graph) {
    const g = body.graph;
    s.settings.graph.tenantId = g.tenantId ?? s.settings.graph.tenantId;
    s.settings.graph.clientId = g.clientId ?? s.settings.graph.clientId;
    if (g.clientSecret !== undefined && g.clientSecret !== MASK) s.settings.graph.clientSecret = g.clientSecret;
    if (g.certificate !== undefined) s.settings.graph.certificate = g.certificate.trim();
    if (g.privateKey !== undefined && g.privateKey !== MASK) s.settings.graph.privateKey = g.privateKey.trim();
    resetAuthCache();
  }
  if (typeof body.writeBack === 'boolean' && body.writeBack !== !!s.settings.writeBack) {
    s.settings.writeBack = body.writeBack;
    logActivity(body.writeBack ? 'Enforcement mode ENABLED' : 'Enforcement mode disabled',
      body.writeBack
        ? 'Remediation actions now make real changes in the tenant via Microsoft Graph / SharePoint'
        : 'Remediation actions apply to the local model only');
  }
  save();
  return { ok: true };
});

// ---------- per-site sharing configuration (SharePoint admin API) ----------

let spJob = { running: false, progress: null, error: null, finishedAt: null, result: null };

route('GET', '/api/spadmin/status', () => spJob);

route('POST', '/api/spadmin/sharing-sync', (s) => {
  if (spJob.running) return { __status: 409, error: 'A sharing-settings sync is already running' };
  if (s.settings.demoMode) return { __status: 400, error: 'Sync a real tenant first' };
  if (!s.sites.length) return { __status: 400, error: 'No sites — run "Sync tenant now" first' };
  if (!s.settings.graph.certificate || !s.settings.graph.privateKey) {
    return { __status: 400, error: 'Certificate credentials are required for the SharePoint admin API — add them in Settings' };
  }
  spJob = { running: true, progress: { done: 0, total: 0, failed: 0 }, error: null, finishedAt: null, result: null };
  readSharingCapabilities(s.settings.graph, s.sites, p => { spJob.progress = p; })
    .then(r => {
      let updated = 0;
      for (const site of s.sites) {
        const cap = r.capBySite[site.id];
        if (cap) { site.externalSharing = cap; updated++; }
      }
      spJob.result = { updated, total: r.total, failed: r.failed, errors: r.errors };
      logActivity(r.failed ? 'Per-site sharing settings synced WITH ERRORS' : 'Per-site sharing settings synced',
        `${updated} site(s) updated from the SharePoint admin API` +
        (r.failed ? `; ${r.failed} of ${r.total} lookups failed (first: ${r.errors[0] ?? 'see log'})` : ''),
        'System');
      save();
    })
    .catch(err => { spJob.error = err.message; })
    .finally(() => { spJob.running = false; spJob.finishedAt = new Date().toISOString(); });
  return { ok: true, started: true };
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
    s.settings.tenantSharing = data.tenantSharing ?? null;
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
let scan = { running: false, progress: null, error: null, finishedAt: null, result: null, stopRequested: false };

route('GET', '/api/graph/scan-status', () => scan);

route('POST', '/api/graph/scan-stop', () => {
  if (!scan.running) return { __status: 400, error: 'No scan is running' };
  scan.stopRequested = true;
  return { ok: true };
});

route('POST', '/api/graph/scan-sharing', (s, _p, _q, body) => {
  if (scan.running) return { __status: 409, error: 'A scan is already running' };
  if (s.settings.demoMode) return { __status: 400, error: 'Sync a real tenant first — demo data already includes links' };
  if (!s.sites.length) return { __status: 400, error: 'No sites to scan. Run "Sync tenant now" first.' };

  // Scans are chunked and resumable: completed sites are remembered (and
  // their links kept), so each run picks up where the last one stopped.
  if (body.fresh || !s.lastScan) s.lastScan = { scannedSiteIds: [] };
  const scannedSet = new Set(s.lastScan.scannedSiteIds);
  const candidates = s.sites
    .filter(x => !scannedSet.has(x.id))
    // Most recently active sites first: real content (and real risk) surfaces
    // early; dormant auto-provisioned shells wait until the end.
    .sort((a, b) => new Date(b.lastActivity ?? 0) - new Date(a.lastActivity ?? 0));
  if (!candidates.length) {
    return { __status: 400, error: 'All sites have already been scanned. Tick "Rescan already-scanned sites" to start over.' };
  }

  const maxSites = Math.max(1, Number(body.maxSites) || 100);
  scan = {
    running: true,
    progress: { done: 0, total: Math.min(maxSites, candidates.length), links: 0, site: '', itemsScanned: 0 },
    error: null, finishedAt: null, result: null, stopRequested: false,
  };
  const onCheckpoint = (batch) => {
    const ids = new Set(batch.map(b => b.siteId));
    s.links = s.links.filter(l => !ids.has(l.siteId)).concat(batch.flatMap(b => b.links));
    s.lastScan.scannedSiteIds.push(...batch.map(b => b.siteId));
    // An "Anyone" link is proof the site permits anonymous sharing.
    const anyoneSites = new Set(batch.flatMap(b => b.links.filter(l => l.type === 'anyone').map(l => l.siteId)));
    for (const site of s.sites) {
      if (anyoneSites.has(site.id)) site.externalSharing = 'anyone';
    }
    save();
  };
  scanSharing(s.settings.graph, candidates, { maxSites, onCheckpoint, shouldStop: () => scan.stopRequested }, p => {
    if (p.phase === 'scan' || p.phase === 'done') scan.progress = p;
    else if (p.phase === 'site-error') console.error('[scan]', p.site, '—', p.error);
  })
    .then(r => {
      scan.result = r; // links already merged into state via checkpoints
      const remaining = s.sites.length - s.lastScan.scannedSiteIds.length;
      const caveats = [
        r.sitesFailed ? `${r.sitesFailed} site(s) failed and will be retried next run (first error: ${r.errors[0] ?? 'see server log'})` : '',
        r.truncatedDrives ? `${r.truncatedDrives} very large librar${r.truncatedDrives === 1 ? 'y' : 'ies'} truncated` : '',
      ].filter(Boolean).join('; ');
      logActivity(r.stopped ? 'Sharing scan stopped by user'
        : r.sitesFailed ? 'Sharing scan chunk completed WITH ERRORS' : 'Sharing scan chunk completed',
        `${r.links.length} link(s) found on ${r.sitesScanned - r.sitesFailed}/${r.sitesScanned} site(s), ${r.itemsScanned} items inspected; ` +
        `${s.links.filter(l => !l.revoked).length} links known in total, ${remaining} site(s) left to scan` +
        (caveats ? ` (${caveats})` : ''),
        'System');
      save();
    })
    .catch(err => { scan.error = err.message; })
    .finally(() => { scan.running = false; scan.finishedAt = new Date().toISOString(); });
  return { ok: true, started: true, sitesInThisRun: Math.min(maxSites, candidates.length), sitesRemaining: candidates.length };
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
