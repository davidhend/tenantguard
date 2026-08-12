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
3. Click **Grant admin consent**.
4. **Certificates & secrets → New client secret** — copy the secret *value*.
5. In TenantGuard → **Settings**, paste the **Tenant ID**, **Client ID** (both on the app's Overview page) and the secret, then **Test connection** and **Sync tenant now**.

Sync is **read-only** against your tenant: it pulls users, groups (with
owners/members/guests), and sites. Remediation buttons update the local model —
wiring them to Graph write calls (remove guest, revoke link) is straightforward
in `lib/graph.mjs` if you want real enforcement, but read-only is the safe default.

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
