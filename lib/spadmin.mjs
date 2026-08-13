// SharePoint Admin API client — the only place per-site external-sharing
// CONFIGURATION lives (Graph does not expose it). App-only access to this API
// requires certificate credentials; client secrets are rejected by SharePoint.
// Required permission: "Office 365 SharePoint Online" → Application →
// Sites.FullControl.All (admin-consented).
import { makeAuth, httpJson, pool } from './graph.mjs';

// SharingCapability enum used by the SharePoint admin API.
export const SHARING_LABEL = {
  0: 'internal-only',           // Disabled
  1: 'new-and-existing-guests', // ExternalUserSharingOnly
  2: 'anyone',                  // ExternalUserAndGuestSharing (anonymous links)
  3: 'existing-guests',         // ExistingExternalUserSharingOnly
};
const SHARING_VALUE = Object.fromEntries(Object.entries(SHARING_LABEL).map(([n, l]) => [l, Number(n)]));

export function requireCert(creds) {
  if (!creds.certificate || !creds.privateKey) {
    throw new Error('SharePoint admin calls require certificate credentials — add the certificate and private key in Settings');
  }
}

// contoso.sharepoint.com → https://contoso-admin.sharepoint.com
export function adminUrlFromSites(sites) {
  for (const s of sites) {
    try {
      const host = new URL(s.url).host;
      if (host.endsWith('.sharepoint.com')) {
        return `https://${host.split('.')[0].replace(/-admin$/, '')}-admin.sharepoint.com`;
      }
    } catch { /* try the next site */ }
  }
  throw new Error('Could not derive the SharePoint admin URL from any synced site URL');
}

// Graph composite site id: "host,siteCollectionGuid,webGuid" — the admin API
// keys site collections by that middle GUID.
const collectionGuid = (siteId) => (siteId ?? '').split(',')[1] ?? null;

const SP_JSON = { Accept: 'application/json;odata=nometadata' };

// Reads the real SharingCapability for every site collection (one call per
// collection — subsites inherit it). Returns a siteId → label map.
export async function readSharingCapabilities(creds, sites, progress = () => {}) {
  requireCert(creds);
  const adminUrl = adminUrlFromSites(sites);
  const auth = makeAuth(creds, `${adminUrl}/.default`);

  const byGuid = new Map(); // collection guid → [siteId, ...]
  for (const s of sites) {
    const guid = collectionGuid(s.id);
    if (!guid) continue;
    if (!byGuid.has(guid)) byGuid.set(guid, []);
    byGuid.get(guid).push(s.id);
  }
  const guids = [...byGuid.keys()];
  const capBySite = {};
  const errors = [];
  let failed = 0;
  let done = 0;

  await pool(guids, 8, async (guid) => {
    try {
      const r = await httpJson(auth, `${adminUrl}/_api/SPO.Tenant/sites('${guid}')?$select=SharingCapability`, { headers: SP_JSON });
      const label = SHARING_LABEL[r?.SharingCapability];
      if (label) for (const siteId of byGuid.get(guid)) capBySite[siteId] = label;
    } catch (err) {
      failed++;
      if (errors.length < 8) errors.push(`${guid}: ${err.message.slice(0, 140)}`);
    }
    done++;
    if (done % 50 === 0 || done === guids.length) progress({ done, total: guids.length, failed });
  });

  return { capBySite, total: guids.length, failed, errors };
}

// Sets a site collection's SharingCapability (e.g. 'internal-only' to shut
// off external sharing). Classic SP REST MERGE update on SiteProperties.
export async function setSharingCapability(creds, sites, siteId, label) {
  requireCert(creds);
  const value = SHARING_VALUE[label];
  if (value === undefined) throw new Error(`Unknown sharing level "${label}"`);
  const guid = collectionGuid(siteId);
  if (!guid) throw new Error(`Cannot determine the site collection id from "${siteId}"`);
  const adminUrl = adminUrlFromSites(sites);
  const auth = makeAuth(creds, `${adminUrl}/.default`);
  await httpJson(auth, `${adminUrl}/_api/SPO.Tenant/sites('${guid}')`, {
    method: 'POST',
    headers: {
      Accept: 'application/json;odata=verbose',
      'Content-Type': 'application/json;odata=verbose',
      'X-HTTP-Method': 'MERGE',
    },
    body: {
      __metadata: { type: 'Microsoft.Online.SharePoint.TenantAdministration.SiteProperties' },
      SharingCapability: value,
    },
  });
}
