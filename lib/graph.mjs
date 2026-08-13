// Microsoft Graph client — plain REST via built-in fetch, no SDK.
// Uses the OAuth2 client-credentials flow with an Azure app registration.
// Required application permissions (admin-consented):
//   User.Read.All, Group.Read.All, GroupMember.Read.All, Sites.Read.All,
//   AuditLog.Read.All (optional, for last sign-in dates)

const GRAPH = 'https://graph.microsoft.com/v1.0';

// Long syncs/scans outlive a single access token (~60-75 min), so every
// request pulls from a caching source that refreshes itself before expiry.
function makeAuth({ tenantId, clientId, clientSecret }) {
  let token = null;
  let expiresAt = 0;
  return async (forceRefresh = false) => {
    if (forceRefresh || !token || Date.now() > expiresAt - 5 * 60 * 1000) {
      const res = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          scope: 'https://graph.microsoft.com/.default',
          grant_type: 'client_credentials',
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error_description || body.error || `Token request failed (${res.status})`);
      token = body.access_token;
      expiresAt = Date.now() + (Number(body.expires_in) || 3600) * 1000;
    }
    return token;
  };
}

async function get(auth, url, attempt = 0) {
  const token = await auth();
  const res = await fetch(url.startsWith('http') ? url : GRAPH + url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  // Token expired mid-run — refresh once and retry.
  if (res.status === 401 && attempt < 2) {
    await auth(true);
    return get(auth, url, attempt + 1);
  }
  // Graph throttles aggressively on large tenants — honor Retry-After.
  if (res.status === 429 || res.status === 503) {
    if (attempt >= 6) throw new Error(`Graph throttled repeatedly on ${url}`);
    const wait = Number(res.headers.get('retry-after')) || 2 ** attempt;
    await new Promise(r => setTimeout(r, wait * 1000));
    return get(auth, url, attempt + 1);
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Graph ${url} failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return res.json();
}

// Follows @odata.nextLink pagination. The cap is a runaway backstop, not a
// coverage limit — it defaults far above real tenant sizes.
async function getAll(auth, url, cap = 200000) {
  const items = [];
  let next = url;
  while (next && items.length < cap) {
    const page = await get(auth, next);
    items.push(...(page.value ?? []));
    next = page['@odata.nextLink'];
  }
  return items;
}

// Run fn over items with bounded concurrency (Graph tolerates ~4-10 parallel
// requests per app before throttling kicks in hard).
async function pool(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  }));
  return results;
}

// SharePoint paths arrive URL-encoded but occasionally contain sequences
// decodeURIComponent rejects — never let a weird filename kill a scan.
function safeDecode(str) {
  try { return decodeURIComponent(str); } catch { return str; }
}

export async function testConnection(creds) {
  const auth = makeAuth(creds);
  const org = await get(auth, '/organization');
  return { ok: true, tenantName: org.value?.[0]?.displayName ?? creds.tenantId };
}

// Pulls users, groups (with owners/members/site), and ALL sites from the
// tenant, and derives per-site permissions from group membership. Read-only.
export async function syncTenant(creds, log = () => {}) {
  const auth = makeAuth(creds);

  const org = await get(auth, '/organization').catch(() => null);
  const tenantName = org?.value?.[0]?.displayName ?? null;

  log('Fetching users…');
  const rawUsers = await getAll(auth,
    '/users?$select=id,displayName,mail,userPrincipalName,userType,department,accountEnabled,signInActivity,createdDateTime&$top=999');

  const users = rawUsers.map(u => ({
    id: u.id,
    name: u.displayName ?? u.userPrincipalName,
    email: u.mail ?? u.userPrincipalName,
    type: (u.userType ?? 'Member').toLowerCase() === 'guest' ? 'guest' : 'member',
    department: u.department ?? null,
    lastSignIn: u.signInActivity?.lastSignInDateTime ?? null,
    invitedAt: u.createdDateTime ?? null,
    invitedBy: null,
    enabled: u.accountEnabled !== false,
  }));
  const userById = Object.fromEntries(users.map(u => [u.id, u]));
  log(`Users: ${users.length}`);

  log('Fetching groups…');
  const rawGroups = await getAll(auth,
    "/groups?$filter=groupTypes/any(c:c eq 'Unified')&$select=id,displayName,visibility,createdDateTime&$top=999");

  let processed = 0;
  const groups = await pool(rawGroups, 8, async (g) => {
    const [owners, members, site] = await Promise.all([
      getAll(auth, `/groups/${g.id}/owners?$select=id&$top=999`).then(r => r.map(o => o.id)).catch(() => []),
      getAll(auth, `/groups/${g.id}/members?$select=id&$top=999`).then(r => r.map(m => m.id)).catch(() => []),
      get(auth, `/groups/${g.id}/sites/root?$select=id`).catch(() => null),
    ]);
    processed++;
    if (processed % 100 === 0 || processed === rawGroups.length) log(`Groups: ${processed}/${rawGroups.length}`);
    return {
      id: g.id,
      name: g.displayName,
      type: 'team',
      privacy: (g.visibility ?? 'Private').toLowerCase(),
      owners,
      members,
      guests: members.filter(id => userById[id]?.type === 'guest'),
      siteId: site?.id ?? null,
      lastActivity: null,
      created: g.createdDateTime ?? null,
    };
  });

  log('Fetching sites…');
  let rawSites;
  try {
    // getAllSites is the complete enumeration (search=* misses unindexed sites).
    rawSites = await getAll(auth,
      '/sites/getAllSites?$select=id,displayName,name,webUrl,createdDateTime,lastModifiedDateTime&$top=500');
  } catch (err) {
    log(`getAllSites unavailable (${err.message.slice(0, 80)}) — falling back to search`);
    rawSites = await getAll(auth, '/sites?search=*&$top=500');
  }

  const groupBySiteId = Object.fromEntries(groups.filter(g => g.siteId).map(g => [g.siteId, g]));
  const sites = rawSites
    .filter(s => s.webUrl && !s.webUrl.includes('-my.sharepoint.com') && !s.webUrl.includes('/personal/')) // skip OneDrive personal sites
    .map((s, i) => ({
      id: s.id ?? `site-${i}`,
      name: s.displayName ?? s.name ?? s.webUrl,
      url: s.webUrl,
      template: groupBySiteId[s.id] ? 'Team site' : 'Communication site',
      department: null,
      sensitivity: 'General',           // sensitivity labels need extra Graph calls; default conservatively
      externalSharing: 'unknown',       // tenant sharing settings come from SP admin API
      storageMB: null,
      lastActivity: s.lastModifiedDateTime ?? null,
      created: s.createdDateTime ?? null,
      groupId: groupBySiteId[s.id]?.id ?? null,
      uniquePermissionItems: 0,
    }));
  log(`Sites: ${sites.length}`);

  // Derive "who has access" from group membership for group-connected sites.
  // Members are sampled (owners and guests always included) to keep the
  // permissions table readable on 1000-member teams.
  const permissions = [];
  const siteIds = new Set(sites.map(s => s.id));
  for (const g of groups) {
    if (!g.siteId || !siteIds.has(g.siteId)) continue;
    const ownerSet = new Set(g.owners);
    const guestSet = new Set(g.guests);
    for (const uid of g.owners) permissions.push({ siteId: g.siteId, principalId: uid, role: 'Full control', source: 'Owner' });
    for (const uid of g.guests) permissions.push({ siteId: g.siteId, principalId: uid, role: 'Edit', source: 'Guest access' });
    for (const uid of g.members.filter(id => !ownerSet.has(id) && !guestSet.has(id)).slice(0, 30))
      permissions.push({ siteId: g.siteId, principalId: uid, role: 'Edit', source: 'Group membership' });
  }

  log('Done.');
  return { tenantName, users, groups, sites, links: [], permissions };
}

// Walks document libraries on the given sites and collects every sharing
// link. Graph has no "list all sharing links" endpoint, so this enumerates
// drive items via delta (flat, efficient) and inspects permissions on items
// carrying the `shared` facet. Expensive on big tenants — hence maxSites.
export async function scanSharing(creds, sites, opts = {}, progress = () => {}) {
  const auth = makeAuth(creds);
  const maxSites = Math.max(1, opts.maxSites ?? 100);
  const maxItemsPerDrive = opts.maxItemsPerDrive ?? 50000;
  const concurrency = Math.min(Math.max(1, opts.concurrency ?? 6), 12);
  const onCheckpoint = opts.onCheckpoint ?? (() => {});
  const shouldStop = opts.shouldStop ?? (() => false);
  const scopeMap = { anonymous: 'anyone', organization: 'organization', users: 'specific-people' };
  const targets = sites.slice(0, maxSites);
  const links = [];
  const errors = [];
  let itemsScanned = 0;
  let truncatedDrives = 0;
  let sitesFailed = 0;
  let done = 0;
  let checkpointBuffer = []; // completed sites awaiting persistence: {siteId, links}

  const report = (siteName) => progress({
    phase: 'scan', site: siteName ?? '', done, total: targets.length,
    links: links.length, itemsScanned, failed: sitesFailed,
  });
  const flush = () => {
    if (!checkpointBuffer.length) return;
    const batch = checkpointBuffer;
    checkpointBuffer = [];
    try { onCheckpoint(batch); } catch (err) { console.error('checkpoint failed:', err.message); }
  };

  await pool(targets, concurrency, async (site) => {
    if (shouldStop()) return;
    const siteLinks = [];
    let siteFailed = false;
    const fail = (label, err) => {
      if (siteFailed) return;
      siteFailed = true;
      sitesFailed++;
      if (errors.length < 8) errors.push(`${label}: ${err.message.slice(0, 160)}`);
      progress({ phase: 'site-error', site: site.name, error: err.message });
    };
    try {
      const drives = await getAll(auth, `/sites/${site.id}/drives?$select=id,name`, 100);
      for (const drive of drives) {
        if (shouldStop()) break;
        try {
          let next = `/drives/${drive.id}/root/delta?$select=id,name,webUrl,shared,parentReference,createdDateTime&$top=200`;
          let scanned = 0;
          while (next) {
            if (shouldStop()) break;
            if (scanned >= maxItemsPerDrive) { truncatedDrives++; break; }
            const page = await get(auth, next);
            for (const item of page.value ?? []) {
              scanned++; itemsScanned++;
              if (!item.shared) continue;
              const perms = await get(auth, `/drives/${drive.id}/items/${item.id}/permissions`).catch(() => null);
              for (const p of perms?.value ?? []) {
                if (!p.link) continue; // membership/direct grants are covered by the permissions model
                const folder = (item.parentReference?.path ?? '').replace(/^\/drives\/[^/]+\/root:?/, '');
                siteLinks.push({
                  id: `${drive.id}:${item.id}:${p.id}`,
                  siteId: site.id,
                  item: safeDecode(`${folder}/${item.name}`),
                  type: scopeMap[p.link.scope] ?? 'specific-people',
                  permission: p.link.type === 'edit' ? 'edit' : 'view',
                  createdBy: null,             // Graph does not expose the link creator
                  created: item.createdDateTime ?? null, // file creation date — link age is not exposed either
                  expires: p.expirationDateTime ?? null,
                  revoked: false,
                  url: p.link.webUrl ?? null,
                });
              }
            }
            next = page['@odata.nextLink'] ?? null;
            report(site.name); // tick every page so huge libraries show movement
          }
        } catch (err) {
          // One bad library shouldn't sink the whole site, let alone the scan.
          fail(`${site.name} (${drive.name})`, err);
        }
      }
    } catch (err) {
      fail(site.name, err);
    }
    // A site interrupted mid-walk is incomplete — leave it unrecorded so the
    // next run rescans it from the start.
    if (shouldStop() && !siteFailed) return;
    links.push(...siteLinks);
    done++;
    // Failed sites are NOT checkpointed, so a resumed scan retries them.
    if (!siteFailed) checkpointBuffer.push({ siteId: site.id, links: siteLinks });
    if (checkpointBuffer.length >= 25) flush();
    report(site.name);
  });
  flush();

  const stopped = shouldStop();
  const result = { links, sitesScanned: done, sitesFailed, itemsScanned, truncatedDrives, errors, stopped };
  progress({ phase: 'done', done, total: targets.length, links: links.length, itemsScanned, failed: sitesFailed });
  return result;
}
