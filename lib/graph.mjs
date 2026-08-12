// Microsoft Graph client — plain REST via built-in fetch, no SDK.
// Uses the OAuth2 client-credentials flow with an Azure app registration.
// Required application permissions (admin-consented):
//   User.Read.All, Group.Read.All, GroupMember.Read.All, Sites.Read.All,
//   AuditLog.Read.All (optional, for last sign-in dates)

const GRAPH = 'https://graph.microsoft.com/v1.0';

export async function getToken({ tenantId, clientId, clientSecret }) {
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
  return body.access_token;
}

async function get(token, url, attempt = 0) {
  const res = await fetch(url.startsWith('http') ? url : GRAPH + url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  // Graph throttles aggressively on large tenants — honor Retry-After.
  if (res.status === 429 || res.status === 503) {
    if (attempt >= 6) throw new Error(`Graph throttled repeatedly on ${url}`);
    const wait = Number(res.headers.get('retry-after')) || 2 ** attempt;
    await new Promise(r => setTimeout(r, wait * 1000));
    return get(token, url, attempt + 1);
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Graph ${url} failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return res.json();
}

// Follows @odata.nextLink pagination. The cap is a runaway backstop, not a
// coverage limit — it defaults far above real tenant sizes.
async function getAll(token, url, cap = 200000) {
  const items = [];
  let next = url;
  while (next && items.length < cap) {
    const page = await get(token, next);
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

export async function testConnection(creds) {
  const token = await getToken(creds);
  const org = await get(token, '/organization');
  return { ok: true, tenantName: org.value?.[0]?.displayName ?? creds.tenantId };
}

// Pulls users, groups (with owners/members/site), and ALL sites from the
// tenant, and derives per-site permissions from group membership. Read-only.
export async function syncTenant(creds, log = () => {}) {
  const token = await getToken(creds);

  const org = await get(token, '/organization').catch(() => null);
  const tenantName = org?.value?.[0]?.displayName ?? null;

  log('Fetching users…');
  const rawUsers = await getAll(token,
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
  const rawGroups = await getAll(token,
    "/groups?$filter=groupTypes/any(c:c eq 'Unified')&$select=id,displayName,visibility,createdDateTime&$top=999");

  let processed = 0;
  const groups = await pool(rawGroups, 8, async (g) => {
    const [owners, members, site] = await Promise.all([
      getAll(token, `/groups/${g.id}/owners?$select=id&$top=999`).then(r => r.map(o => o.id)).catch(() => []),
      getAll(token, `/groups/${g.id}/members?$select=id&$top=999`).then(r => r.map(m => m.id)).catch(() => []),
      get(token, `/groups/${g.id}/sites/root?$select=id`).catch(() => null),
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
    rawSites = await getAll(token,
      '/sites/getAllSites?$select=id,displayName,name,webUrl,createdDateTime,lastModifiedDateTime&$top=500');
  } catch (err) {
    log(`getAllSites unavailable (${err.message.slice(0, 80)}) — falling back to search`);
    rawSites = await getAll(token, '/sites?search=*&$top=500');
  }

  const groupBySiteId = Object.fromEntries(groups.filter(g => g.siteId).map(g => [g.siteId, g]));
  const sites = rawSites
    .filter(s => s.webUrl && !s.webUrl.includes('-my.sharepoint.com')) // skip OneDrive personal sites
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
  const token = await getToken(creds);
  const maxSites = Math.max(1, opts.maxSites ?? 100);
  const maxItemsPerDrive = opts.maxItemsPerDrive ?? 50000;
  const scopeMap = { anonymous: 'anyone', organization: 'organization', users: 'specific-people' };
  const targets = sites.slice(0, maxSites);
  const links = [];
  let itemsScanned = 0;
  let truncatedDrives = 0;

  for (let done = 0; done < targets.length; done++) {
    const site = targets[done];
    progress({ phase: 'scan', site: site.name, done, total: targets.length, links: links.length, itemsScanned });
    try {
      const drives = await getAll(token, `/sites/${site.id}/drives?$select=id,name`, 100);
      for (const drive of drives) {
        let next = `/drives/${drive.id}/root/delta?$select=id,name,webUrl,shared,parentReference,createdDateTime&$top=200`;
        let scanned = 0;
        while (next) {
          if (scanned >= maxItemsPerDrive) { truncatedDrives++; break; }
          const page = await get(token, next);
          for (const item of page.value ?? []) {
            scanned++; itemsScanned++;
            if (!item.shared) continue;
            const perms = await get(token, `/drives/${drive.id}/items/${item.id}/permissions`).catch(() => null);
            for (const p of perms?.value ?? []) {
              if (!p.link) continue; // membership/direct grants are covered by the permissions model
              const folder = (item.parentReference?.path ?? '').replace(/^\/drives\/[^/]+\/root:?/, '');
              links.push({
                id: `${drive.id}:${item.id}:${p.id}`,
                siteId: site.id,
                item: decodeURIComponent(`${folder}/${item.name}`),
                type: scopeMap[p.link.scope] ?? 'specific-people',
                permission: p.link.type === 'edit' ? 'edit' : 'view',
                createdBy: null, // Graph does not expose the link creator on the permission
                created: item.createdDateTime ?? null,
                expires: p.expirationDateTime ?? null,
                revoked: false,
                url: p.link.webUrl ?? null,
              });
            }
          }
          next = page['@odata.nextLink'] ?? null;
        }
      }
    } catch (err) {
      progress({ phase: 'site-error', site: site.name, error: err.message });
    }
  }
  progress({ phase: 'done', done: targets.length, total: targets.length, links: links.length, itemsScanned, truncatedDrives });
  return { links, sitesScanned: targets.length, itemsScanned, truncatedDrives };
}
