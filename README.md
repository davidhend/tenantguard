# TenantGuard

A self-hosted **Microsoft 365 governance & security dashboard** — see and fix
external-sharing risk, ownerless teams, stale guests, risky sharing links, and
run access-review campaigns. Inspired by commercial M365 governance tools.

**Zero dependencies.** The backend is plain Node.js (stdlib `http`), the frontend
is vanilla JS — there is no `npm install` step at all. State persists to a single
JSON file, so there's no database to run either.

## Run it

**Directly (Node 18+):**

```bash
node server.mjs
# → http://localhost:8080
```

**With Docker (e.g. Docker Desktop on Windows — run from PowerShell in this folder):**

```bash
docker compose up -d --build
# → http://localhost:8080   (data persists in the tenantguard-data volume)
```

It starts with a realistic **seeded demo tenant** (Fabrikam) so every feature is
usable immediately — no Microsoft 365 tenant required.

## Features

| Area | What it does |
|---|---|
| **Dashboard** | Tenant security score (0–100 + grade), findings by severity and by policy, one-click fixes, activity feed |
| **Sites** | SharePoint inventory: sensitivity labels, external-sharing mode, owners, guests, storage; per-site "who has access" and active links |
| **Teams & Groups** | Ownerless / single-owner detection, public teams with guests, add-owner remediation |
| **Guests** | External-user inventory, stale-guest detection (configurable threshold), never-signed-in flags, one-click removal |
| **Sharing links** | Every active link with type ("Anyone" / organization / specific people), expiration status; revoke or force 30-day expiry |
| **Access reviews** | Campaigns scoped to all guests, a department, or one site; keep/revoke decisions per grant; completing the review applies revocations |
| **Policies** | 8 governance rules (block Anyone links, guest expiry, ≥2 owners, no external sharing on Confidential sites, …) with violation counts and **Fix all** enforcement |
| **Activity** | Audit trail of every change made through the app |
| **Settings** | Thresholds, demo reset, and real-tenant connection |

## Connecting a real Microsoft 365 tenant

TenantGuard talks to Microsoft Graph directly (plain REST, no SDK) using an
**Azure App Registration** with the client-credentials flow:

1. In [Entra admin center](https://entra.microsoft.com) → **App registrations → New registration**. Name it (e.g. `TenantGuard`), single tenant, no redirect URI needed.
2. **API permissions → Add a permission → Microsoft Graph → Application permissions**, add:
   - `User.Read.All`
   - `Group.Read.All`
   - `GroupMember.Read.All`
   - `Sites.Read.All`
   - `AuditLog.Read.All` *(optional — enables last-sign-in dates for stale-guest detection)*
   - `SharePointTenantSettings.Read.All` *(optional — shows the tenant-wide external-sharing policy)*
3. Click **Grant admin consent**.
4. **Certificates & secrets → New client secret** — copy the secret *value*.
5. In TenantGuard → **Settings**, paste the **Tenant ID**, **Client ID** (both on the app's Overview page) and the secret, then **Test connection** and **Sync tenant now**.

Sync is **read-only** against your tenant: it pulls users, groups (with
owners/members/guests), and **all** sites (via `/sites/getAllSites`), and derives
per-site "who has access" from group ownership/membership. By default remediation
buttons update the local model only — real enforcement is opt-in (see below).

## Certificate credentials (per-site sharing config + site enforcement)

Per-site external-sharing **configuration** lives in the SharePoint Admin API,
which rejects client-secret app-only tokens — it requires a certificate:

1. Generate a self-signed certificate (1 command):
   ```bash
   openssl req -x509 -newkey rsa:2048 -keyout tenantguard.key -out tenantguard.crt -days 365 -nodes -subj "/CN=TenantGuard"
   ```
2. In the app registration → **Certificates & secrets → Certificates → Upload
   certificate**, upload `tenantguard.crt`.
3. In the app registration → **API permissions → Add a permission → SharePoint
   (Office 365 SharePoint Online) → Application permissions**, add
   `Sites.FullControl.All`, then **Grant admin consent**.
4. In TenantGuard → Settings, either **browse to a `.pfx`/`.p12` file** (enter
   its password and click *Import .pfx* — the server extracts the certificate
   and key using the `openssl` CLI, included in the Docker image), or pick a
   `.cer`/`.crt` file, or paste PEM values under *Advanced*. If you used the
   openssl command above, bundle a .pfx with:
   ```bash
   openssl pkcs12 -export -out tenantguard.pfx -inkey tenantguard.key -in tenantguard.crt
   ```
   (Exports from the Windows certificate store work too, including legacy
   cipher bundles.)

With the certificate in place, **Settings → Fetch per-site sharing settings**
reads every site collection's real `SharingCapability` (one fast admin-API call
per collection) and replaces the evidence-based values on the Sites page with
actual configuration. When both a secret and a certificate are present, the
certificate is preferred for all token requests (Graph accepts it too).

## Enforcement (write-back)

Off by default. When you flip **Settings → Enforcement** on (real tenant only),
remediation buttons stop being dashboard-only and make real changes:

| Action | What happens in the tenant |
|---|---|
| Revoke sharing link | `DELETE` on the item's permission |
| Set link expiration | `PATCH` with `expirationDateTime` |
| Remove guest | Account sign-in disabled + removed from all known groups |
| Add owner | Added to group owners (and members) |
| Access review "Revoke" | Removed from the site's group on completion |
| Disable external sharing | Site collection set to internal-only (needs the certificate) |

Additional **application permissions** required for write-back (admin-consented):
`Sites.ReadWrite.All` (links), `User.ReadWrite.All` (guest disable),
`Group.ReadWrite.All` and `GroupMember.ReadWrite.All` (owners/members), and the
SharePoint `Sites.FullControl.All` above for site sharing changes.

Failure semantics: the tenant call happens first, and the local model updates
only on success — bulk operations report exactly how many fixes succeeded and
failed, and failures stay visible as findings.

### Sharing links on a real tenant

Microsoft Graph has no "list all sharing links" endpoint — finding them requires
walking every document library. After syncing, use **Settings → Sharing link
scan**: it enumerates drive items (delta queries), inspects every shared item's
permissions, and populates the Sharing links page. Built for big tenants:

- **Chunked & resumable** — each run scans up to *N* sites (default 500);
  finished sites are skipped on the next run and their links kept, so you can
  cover tens of thousands of sites across several runs. Tick *Rescan
  already-scanned sites* to start over.
- **Checkpointed** — results are persisted every 25 sites, and appear on the
  Sharing links page as the scan progresses. A server restart loses at most 25
  sites of progress; failed sites are retried on the next run.
- **Most-active first** — sites are scanned in order of recent activity, so
  real content (and real risk) surfaces early and dormant auto-provisioned
  shells wait until the end.
- **Parallel & throttle-aware** — six sites scan concurrently; Graph 429/503
  responses are retried honoring Retry-After, and access tokens auto-refresh,
  so multi-hour scans keep going.
- Very large libraries are truncated at 50,000 items per drive and reported in
  the activity log — nothing is dropped silently.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | HTTP port |
| `DATA_DIR` | `./data` | Where `state.json` is stored |

## Project layout

```
server.mjs          HTTP server, static files, all API routes
lib/store.mjs       JSON-file-backed state store
lib/seed.mjs        Deterministic demo-tenant generator
lib/insights.mjs    Risk engine: policy checks → findings → score
lib/graph.mjs       Microsoft Graph client (client-credentials, plain fetch)
public/             Frontend SPA (index.html, app.js, styles.css)
data/               Runtime state (gitignored)
```

## Security notes

- The app has **no authentication of its own** — it is meant to run locally or
  behind your own reverse proxy / SSO. Do not expose it to the internet as-is.
- The Graph client secret is stored in `data/state.json` in plain text; protect
  that directory (it is volume-mounted in Docker).
