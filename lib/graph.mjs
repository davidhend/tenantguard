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

async function get(token, url) {
  const res = await fetch(url.startsWith('http') ? url : GRAPH + url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Graph ${url} failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return res.json();
}

// Follows @odata.nextLink pagination, with a safety cap.
async function getAll(token, url, cap = 2000) {
  const items = [];
  let next = url;
  while (next && items.length < cap) {
    const page = await get(token, next);
    items.push(...(page.value ?? []));
    next = page['@odata.nextLink'];
  }
  return items;
}

export async function testConnection(creds) {
  const token = await getToken(creds);
  const org = await get(token, '/organization');
  return { ok: true, tenantName: org.value?.[0]?.displayName ?? creds.tenantId };
}

// Pulls users, groups (with owners/members), and sites from the real tenant
// and maps them into the app's data model. Read-only.
export async function syncTenant(creds, log = () => {}) {
  const token = await getToken(creds);

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

  log('Fetching groups…');
  const rawGroups = await getAll(token,
    "/groups?$filter=groupTypes/any(c:c eq 'Unified')&$select=id,displayName,visibility,createdDateTime&$top=999");

  const groups = [];
  for (const g of rawGroups) {
    let owners = [], members = [];
    try { owners = (await getAll(token, `/groups/${g.id}/owners?$select=id&$top=999`)).map(o => o.id); } catch { /* skip */ }
    try { members = (await getAll(token, `/groups/${g.id}/members?$select=id&$top=999`)).map(m => m.id); } catch { /* skip */ }
    const userById = Object.fromEntries(users.map(u => [u.id, u]));
    groups.push({
      id: g.id,
      name: g.displayName,
      type: 'team',
      privacy: (g.visibility ?? 'Private').toLowerCase(),
      owners,
      members,
      guests: members.filter(id => userById[id]?.type === 'guest'),
      siteId: null,
      lastActivity: null,
      created: g.createdDateTime ?? null,
    });
    log(`Groups: ${groups.length}/${rawGroups.length}`);
  }

  log('Fetching sites…');
  const rawSites = await getAll(token, '/sites?search=*&$top=200', 500);
  const sites = rawSites
    .filter(s => !s.webUrl?.includes('-my.sharepoint.com')) // skip OneDrive personal sites
    .map((s, i) => ({
      id: s.id ?? `site-${i}`,
      name: s.displayName ?? s.name ?? s.webUrl,
      url: s.webUrl,
      template: 'Team site',
      department: null,
      sensitivity: 'General',           // sensitivity labels need extra Graph calls; default conservatively
      externalSharing: 'unknown',       // tenant sharing settings come from SP admin API
      storageMB: null,
      lastActivity: s.lastModifiedDateTime ?? null,
      created: s.createdDateTime ?? null,
      groupId: null,
      uniquePermissionItems: 0,
    }));

  log('Done.');
  return { users, groups, sites, links: [], permissions: [] };
}
