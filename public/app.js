// TenantGuard SPA — hash router + fetch, no framework.

const main = document.getElementById('main');
const SEV_LABEL = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low' };

// ---------- utilities ----------

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function toast(msg, isError = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (isError ? ' error' : '');
  el.textContent = msg;
  document.getElementById('toast-root').appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function ago(iso) {
  if (!iso) return 'never';
  const d = Math.floor((Date.now() - new Date(iso)) / 86400000);
  if (d <= 0) return 'today';
  if (d === 1) return 'yesterday';
  if (d < 30) return `${d} days ago`;
  if (d < 365) return `${Math.floor(d / 30)} mo ago`;
  return `${Math.floor(d / 365)} yr ago`;
}

function sev(level) {
  return `<span class="sev ${level}">${SEV_LABEL[level] ?? level}</span>`;
}

function sharingBadge(mode) {
  if (mode === 'anyone') return '<span class="badge badge-danger">Anyone links allowed</span>';
  if (mode === 'existing-guests') return '<span class="badge badge-warn">Existing guests</span>';
  if (mode === 'internal-only') return '<span class="badge badge-good">Internal only</span>';
  return `<span class="badge badge-neutral">${esc(mode)}</span>`;
}

function sensBadge(label) {
  if (label === 'Highly Confidential') return '<span class="badge badge-danger">Highly Confidential</span>';
  if (label === 'Confidential') return '<span class="badge badge-warn">Confidential</span>';
  return '<span class="badge badge-neutral">General</span>';
}

function modal(html) {
  const root = document.getElementById('modal-root');
  root.innerHTML = `<div class="modal-backdrop"><div class="modal">${html}</div></div>`;
  root.querySelector('.modal-backdrop').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeModal();
  });
  return root.querySelector('.modal');
}
function closeModal() { document.getElementById('modal-root').innerHTML = ''; }
window.closeModal = closeModal;

// Global action helper: POST then re-render the current page.
window.act = async (path, confirmMsg, successMsg) => {
  if (confirmMsg && !confirm(confirmMsg)) return;
  try {
    await api(path, { method: 'POST' });
    toast(successMsg || 'Done');
    render();
  } catch (err) { toast(err.message, true); }
};

// ---------- pages ----------

async function pageDashboard() {
  const s = await api('/api/summary');
  const r = s.risk;
  const riskColor = r.score >= 90 ? 'var(--good)' : r.score >= 75 ? 'var(--warning)' : r.score >= 60 ? 'var(--serious)' : 'var(--critical)';
  const gradeDesc = {
    A: 'Healthy — keep it up.', B: 'Minor issues to clean up.', C: 'Several risks need attention.',
    D: 'Significant exposure — act soon.', F: 'Serious exposure — act now.',
  }[r.grade];

  const policyNames = Object.fromEntries((await api('/api/policies')).map(p => [p.id, p.name]));
  const byPolicy = Object.entries(s.byPolicy).sort((a, b) => b[1] - a[1]);
  const maxCount = Math.max(1, ...byPolicy.map(([, n]) => n));

  const sevTiles = ['critical', 'high', 'medium', 'low'].map(level => `
    <div class="card tile clickable" onclick="location.hash='#/findings/${level}'">
      <div class="label">${sev(level)}</div>
      <div class="value">${s.bySeverity[level]}</div>
      <div class="hint">finding${s.bySeverity[level] === 1 ? '' : 's'}</div>
    </div>`).join('');

  const top = s.findings.slice(0, 8);

  main.innerHTML = `
    <div class="page-head">
      <div><h1>Dashboard</h1>
        <div class="sub">${esc(s.tenantName)} · ${s.counts.sites} sites · ${s.counts.teams} teams · ${s.counts.users} users · ${s.counts.guests} guests${s.lastSync ? ` · synced ${ago(s.lastSync)}` : ''}</div>
      </div>
      ${s.demoMode ? '<span class="badge badge-demo">Demo data — connect a tenant in Settings</span>' : ''}
    </div>

    <div class="grid hero-row">
      <div class="card risk-hero">
        <div class="label muted" style="font-size:12px">Tenant security score</div>
        <div class="score">${r.score}<small> / 100</small></div>
        <div class="grade">Grade ${r.grade}</div>
        <div class="desc">${gradeDesc}</div>
        <div class="risk-meter" role="img" aria-label="Security score ${r.score} out of 100">
          <div style="width:${r.score}%;background:${riskColor}"></div>
        </div>
      </div>
      <div class="grid cols-4" style="align-content:stretch">${sevTiles}</div>
    </div>

    <div class="grid cols-2 mt">
      <div class="card">
        <h2>Top findings</h2>
        ${top.length === 0 ? '<div class="empty">No findings — the tenant is clean.</div>' : top.map(f => `
          <div class="finding">
            <span class="sev ${f.severity}">${SEV_LABEL[f.severity]}</span>
            <div class="body">
              <div class="title">${esc(f.title)}</div>
              <div class="detail">${esc(f.detail)}</div>
            </div>
            ${findingFixBtn(f)}
          </div>`).join('')}
        ${s.findings.length > 8 ? `<div class="mt"><a href="#/findings/all">See all ${s.findings.length} findings →</a></div>` : ''}
      </div>
      <div>
        <div class="card">
          <h2>Findings by policy</h2>
          ${byPolicy.length === 0 ? '<div class="empty">No violations.</div>' : `<div class="barlist">
            ${byPolicy.map(([pid, n]) => `
              <div class="row" title="${esc(policyNames[pid] ?? pid)}: ${n} finding${n === 1 ? '' : 's'}">
                <span class="name">${esc(policyNames[pid] ?? pid)}</span>
                <div class="track"><div class="bar" style="width:${Math.max(3, (n / maxCount) * 100)}%"></div></div>
                <span class="num">${n}</span>
              </div>`).join('')}
          </div>`}
        </div>
        <div class="card mt">
          <h2>Recent activity</h2>
          ${s.activity.map(a => `
            <div class="finding">
              <div class="body">
                <div class="title" style="font-weight:500">${esc(a.action)}</div>
                <div class="detail">${esc(a.detail)}</div>
              </div>
              <span class="muted" style="font-size:12px;white-space:nowrap">${ago(a.at)}</span>
            </div>`).join('')}
        </div>
      </div>
    </div>`;
}

function findingFixBtn(f) {
  if (!f.fix) return '';
  const actions = {
    'Revoke link': `act('/api/links/${f.targetId}/revoke','Revoke this sharing link?','Link revoked')`,
    'Set 30-day expiry': `act('/api/links/${f.targetId}/expiry',null,'Expiration set')`,
    'Remove guest': `act('/api/users/${f.targetId}/remove','Remove this guest and all their access?','Guest removed')`,
    'Disable external sharing': `act('/api/sites/${f.targetId}/disable-external','Set this site to internal-only sharing?','External sharing disabled')`,
    'Assign owner': `location.hash='#/groups'`,
    'Start review': `location.hash='#/reviews'`,
  };
  const handler = actions[f.fix];
  return handler ? `<button class="btn small" onclick="${handler.replace(/"/g, '&quot;')}">${esc(f.fix)}</button>` : '';
}

async function pageFindings(filter) {
  const s = await api('/api/summary');
  const list = filter === 'all' ? s.findings : s.findings.filter(f => f.severity === filter);
  main.innerHTML = `
    <div class="page-head">
      <div><h1>Findings${filter !== 'all' ? ` — ${SEV_LABEL[filter]}` : ''}</h1>
        <div class="sub">${list.length} finding${list.length === 1 ? '' : 's'}</div></div>
      <a class="btn" href="#/">← Dashboard</a>
    </div>
    <div class="card">
      ${list.length === 0 ? '<div class="empty">Nothing here.</div>' : list.map(f => `
        <div class="finding">
          <span class="sev ${f.severity}">${SEV_LABEL[f.severity]}</span>
          <div class="body">
            <div class="title">${esc(f.title)}</div>
            <div class="detail">${esc(f.detail)}</div>
          </div>
          ${findingFixBtn(f)}
        </div>`).join('')}
    </div>`;
}

async function pageSites() {
  const sites = await api('/api/sites');
  main.innerHTML = `
    <div class="page-head">
      <div><h1>Sites</h1><div class="sub">${sites.length} SharePoint sites</div></div>
      <input class="search" type="text" id="site-search" placeholder="Search sites…">
    </div>
    <div class="card table-wrap"><table>
      <thead><tr><th>Site</th><th>Sensitivity</th><th>External sharing</th><th>Owners</th>
        <th class="num">Guests</th><th class="num">Links</th><th>Last activity</th><th class="num">Findings</th></tr></thead>
      <tbody id="site-rows"></tbody>
    </table></div>`;

  const rows = document.getElementById('site-rows');
  const draw = (term = '') => {
    const t = term.toLowerCase();
    const list = sites.filter(x => !t || x.name.toLowerCase().includes(t) || (x.department ?? '').toLowerCase().includes(t));
    rows.innerHTML = list.length === 0 ? '<tr><td colspan="8" class="empty">No sites match.</td></tr>' : list.map(x => `
      <tr class="row-link" onclick="location.hash='#/sites/${x.id}'">
        <td><strong>${esc(x.name)}</strong><div class="sub">${esc(x.department ?? '')} · ${esc(x.template)}</div></td>
        <td>${sensBadge(x.sensitivity)}</td>
        <td>${sharingBadge(x.externalSharing)}</td>
        <td>${x.owners.length ? esc(x.owners.join(', ')) : '<span class="badge badge-danger">Ownerless</span>'}</td>
        <td class="num">${x.guestCount}</td>
        <td class="num">${x.linkCount}</td>
        <td>${ago(x.lastActivity)}</td>
        <td class="num">${x.findingCount > 0 ? `<span class="badge badge-warn">${x.findingCount}</span>` : '<span class="muted">0</span>'}</td>
      </tr>`).join('');
  };
  draw();
  document.getElementById('site-search').addEventListener('input', e => draw(e.target.value));
}

async function pageSiteDetail(id) {
  const x = await api(`/api/sites/${id}`);
  main.innerHTML = `
    <div class="page-head">
      <div><h1>${esc(x.name)}</h1><div class="sub"><a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.url)}</a></div></div>
      <div class="head-actions">
        ${x.externalSharing !== 'internal-only' ? `<button class="btn danger" onclick="act('/api/sites/${x.id}/disable-external','Set this site to internal-only sharing?','External sharing disabled')">Disable external sharing</button>` : ''}
        <a class="btn" href="#/sites">← Sites</a>
      </div>
    </div>
    <div class="grid cols-2">
      <div class="card">
        <h2>Details</h2>
        <dl class="kv">
          <dt>Template</dt><dd>${esc(x.template)}</dd>
          <dt>Department</dt><dd>${esc(x.department ?? '—')}</dd>
          <dt>Sensitivity</dt><dd>${sensBadge(x.sensitivity)}</dd>
          <dt>External sharing</dt><dd>${sharingBadge(x.externalSharing)}</dd>
          <dt>Storage</dt><dd>${x.storageMB != null ? (x.storageMB / 1000).toFixed(1) + ' GB' : '—'}</dd>
          <dt>Created</dt><dd>${fmtDate(x.created)}</dd>
          <dt>Last activity</dt><dd>${ago(x.lastActivity)}</dd>
          <dt>Items w/ unique permissions</dt><dd>${x.uniquePermissionItems}</dd>
          ${x.group ? `<dt>Connected team</dt><dd>${esc(x.group.name)} (${x.group.privacy})</dd>` : ''}
        </dl>
      </div>
      <div class="card">
        <h2>Findings on this site</h2>
        ${x.findings.length === 0 ? '<div class="empty">No findings.</div>' : x.findings.map(f => `
          <div class="finding">
            <span class="sev ${f.severity}">${SEV_LABEL[f.severity]}</span>
            <div class="body"><div class="title">${esc(f.title)}</div><div class="detail">${esc(f.detail)}</div></div>
          </div>`).join('')}
      </div>
    </div>
    <div class="card mt">
      <h2>Who has access (${x.permissions.length})</h2>
      <div class="table-wrap"><table>
        <thead><tr><th>Person</th><th>Type</th><th>Role</th><th>Source</th><th></th></tr></thead>
        <tbody>${x.permissions.map(p => `
          <tr>
            <td><strong>${esc(p.principal.name)}</strong><div class="sub">${esc(p.principal.email)}</div></td>
            <td>${p.principal.type === 'guest' ? '<span class="badge badge-warn">Guest</span>' : '<span class="badge badge-neutral">Member</span>'}</td>
            <td>${esc(p.role)}</td>
            <td>${esc(p.source)}</td>
            <td class="num">${p.principal.type === 'guest' ? `<button class="btn small danger" onclick="act('/api/users/${p.principal.id}/remove','Remove ${esc(p.principal.name)} and all their access?','Guest removed')">Remove</button>` : ''}</td>
          </tr>`).join('')}</tbody>
      </table></div>
    </div>
    <div class="card mt">
      <h2>Active sharing links (${x.links.length})</h2>
      ${x.links.length === 0 ? '<div class="empty">No active links on this site.</div>' : `
      <div class="table-wrap"><table>
        <thead><tr><th>Item</th><th>Link type</th><th>Permission</th><th>Expires</th><th></th></tr></thead>
        <tbody>${x.links.map(l => `
          <tr>
            <td>${esc(l.item)}</td>
            <td>${linkTypeBadge(l.type)}</td>
            <td>${esc(l.permission)}</td>
            <td>${l.expires ? fmtDate(l.expires) : '<span class="badge badge-warn">Never</span>'}</td>
            <td class="num"><button class="btn small danger" onclick="act('/api/links/${l.id}/revoke','Revoke this link?','Link revoked')">Revoke</button></td>
          </tr>`).join('')}</tbody>
      </table></div>`}
    </div>`;
}

function linkTypeBadge(type) {
  if (type === 'anyone') return '<span class="badge badge-danger">Anyone</span>';
  if (type === 'organization') return '<span class="badge badge-warn">Whole organization</span>';
  return '<span class="badge badge-neutral">Specific people</span>';
}

async function pageGroups() {
  const groups = await api('/api/groups');
  const members = (await api('/api/users?type=member'));
  window.__members = members;
  main.innerHTML = `
    <div class="page-head">
      <div><h1>Teams &amp; Groups</h1><div class="sub">${groups.length} Microsoft 365 groups · ${groups.filter(g => g.owners.length === 0).length} ownerless</div></div>
    </div>
    <div class="card table-wrap"><table>
      <thead><tr><th>Team</th><th>Privacy</th><th>Owners</th><th class="num">Members</th><th class="num">Guests</th><th>Last activity</th><th></th></tr></thead>
      <tbody>${groups.map(g => `
        <tr>
          <td><strong>${esc(g.name)}</strong>${g.siteName ? `<div class="sub">${esc(g.siteName)}</div>` : ''}</td>
          <td>${g.privacy === 'public' ? '<span class="badge badge-warn">Public</span>' : '<span class="badge badge-neutral">Private</span>'}</td>
          <td>${g.ownerNames.length ? esc(g.ownerNames.join(', ')) : '<span class="badge badge-danger">Ownerless</span>'}</td>
          <td class="num">${g.memberCount}</td>
          <td class="num">${g.guestCount > 0 ? `<span class="badge badge-warn">${g.guestCount}</span>` : '0'}</td>
          <td>${ago(g.lastActivity)}</td>
          <td class="num">${g.owners.length < 2 ? `<button class="btn small" onclick="addOwnerModal('${g.id}','${esc(g.name).replace(/'/g, "\\'")}')">Add owner</button>` : ''}</td>
        </tr>`).join('')}</tbody>
    </table></div>`;
}

window.addOwnerModal = (groupId, groupName) => {
  const m = modal(`
    <h2>Add an owner to ${esc(groupName)}</h2>
    <div class="field"><label>Pick an internal user</label>
      <select id="owner-pick">${window.__members.map(u => `<option value="${u.id}">${esc(u.name)} — ${esc(u.department ?? '')}</option>`).join('')}</select>
    </div>
    <div class="actions">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn primary" id="owner-save">Add owner</button>
    </div>`);
  m.querySelector('#owner-save').addEventListener('click', async () => {
    try {
      await api(`/api/groups/${groupId}/owners`, { method: 'POST', body: { userId: m.querySelector('#owner-pick').value } });
      closeModal(); toast('Owner added'); render();
    } catch (err) { toast(err.message, true); }
  });
};

async function pageGuests() {
  const guests = await api('/api/users?type=guest');
  const stale = guests.filter(g => g.stale).length;
  main.innerHTML = `
    <div class="page-head">
      <div><h1>Guests</h1><div class="sub">${guests.length} external users · ${stale} stale</div></div>
      <div class="seg" id="guest-filter">
        <button class="active" data-f="all">All</button>
        <button data-f="stale">Stale only</button>
      </div>
    </div>
    <div class="card table-wrap"><table>
      <thead><tr><th>Guest</th><th>Invited</th><th>Last sign-in</th><th>Access to</th><th></th></tr></thead>
      <tbody id="guest-rows"></tbody>
    </table></div>`;

  const rows = document.getElementById('guest-rows');
  const draw = (f = 'all') => {
    const list = f === 'stale' ? guests.filter(g => g.stale) : guests;
    rows.innerHTML = list.length === 0 ? '<tr><td colspan="5" class="empty">No guests.</td></tr>' : list.map(g => `
      <tr>
        <td><strong>${esc(g.name)}</strong><div class="sub">${esc(g.email)}</div></td>
        <td>${fmtDate(g.invitedAt)}${g.invitedByName ? `<div class="sub">by ${esc(g.invitedByName)}</div>` : ''}</td>
        <td>${g.lastSignIn ? ago(g.lastSignIn) : '<span class="badge badge-danger">Never</span>'}${g.stale && g.lastSignIn ? ' <span class="badge badge-warn">Stale</span>' : ''}</td>
        <td>${esc([...g.groups, ...g.sites].slice(0, 3).join(', '))}${g.groups.length + g.sites.length > 3 ? ` <span class="muted">+${g.groups.length + g.sites.length - 3} more</span>` : ''}</td>
        <td class="num"><button class="btn small danger" onclick="act('/api/users/${g.id}/remove','Remove ${esc(g.name).replace(/'/g, "\\'")} and all their access?','Guest removed')">Remove</button></td>
      </tr>`).join('');
  };
  draw();
  document.getElementById('guest-filter').addEventListener('click', e => {
    const btn = e.target.closest('button'); if (!btn) return;
    document.querySelectorAll('#guest-filter button').forEach(b => b.classList.toggle('active', b === btn));
    draw(btn.dataset.f);
  });
}

async function pageLinks() {
  const links = await api('/api/links');
  main.innerHTML = `
    <div class="page-head">
      <div><h1>Sharing links</h1><div class="sub">${links.length} active links · ${links.filter(l => l.type === 'anyone').length} "Anyone" links</div></div>
      <div class="seg" id="link-filter">
        <button class="active" data-f="all">All</button>
        <button data-f="anyone">Anyone</button>
        <button data-f="organization">Organization</button>
        <button data-f="no-expiry">No expiration</button>
      </div>
    </div>
    <div class="card table-wrap"><table>
      <thead><tr><th>Item</th><th>Site</th><th>Link type</th><th>Permission</th><th>Created by</th><th>Expires</th><th></th></tr></thead>
      <tbody id="link-rows"></tbody>
    </table></div>`;

  const rows = document.getElementById('link-rows');
  const draw = (f = 'all') => {
    const list = links.filter(l =>
      f === 'all' ? true : f === 'no-expiry' ? !l.expires : l.type === f);
    rows.innerHTML = list.length === 0 ? '<tr><td colspan="7" class="empty">No links match.</td></tr>' : list.map(l => `
      <tr>
        <td>${esc(l.item.split('/').pop())}<div class="sub">${esc(l.item)}</div></td>
        <td>${esc(l.siteName)} ${l.sensitivity !== 'General' ? sensBadge(l.sensitivity) : ''}</td>
        <td>${linkTypeBadge(l.type)}</td>
        <td>${esc(l.permission)}</td>
        <td>${esc(l.createdByName)}<div class="sub">${ago(l.created)}</div></td>
        <td>${l.expires ? fmtDate(l.expires) : '<span class="badge badge-warn">Never</span>'}</td>
        <td class="num" style="white-space:nowrap">
          ${!l.expires ? `<button class="btn small" onclick="act('/api/links/${l.id}/expiry',null,'30-day expiration set')">Expire in 30d</button>` : ''}
          <button class="btn small danger" onclick="act('/api/links/${l.id}/revoke','Revoke this link?','Link revoked')">Revoke</button>
        </td>
      </tr>`).join('');
  };
  draw();
  document.getElementById('link-filter').addEventListener('click', e => {
    const btn = e.target.closest('button'); if (!btn) return;
    document.querySelectorAll('#link-filter button').forEach(b => b.classList.toggle('active', b === btn));
    draw(btn.dataset.f);
  });
}

async function pageReviews() {
  const reviews = await api('/api/reviews');
  main.innerHTML = `
    <div class="page-head">
      <div><h1>Access reviews</h1><div class="sub">Ask owners to attest who should keep access</div></div>
      <button class="btn primary" onclick="newReviewModal()">New review</button>
    </div>
    ${reviews.length === 0 ? '<div class="card"><div class="empty">No reviews yet. Start one to audit guest access.</div></div>' : `
    <div class="card table-wrap"><table>
      <thead><tr><th>Review</th><th>Status</th><th>Reviewer</th><th>Due</th><th style="width:140px">Progress</th><th class="num">Items</th></tr></thead>
      <tbody>${reviews.map(r => `
        <tr class="row-link" onclick="location.hash='#/reviews/${r.id}'">
          <td><strong>${esc(r.name)}</strong><div class="sub">${esc(r.scope)}</div></td>
          <td>${r.status === 'completed' ? '<span class="badge badge-good">Completed</span>' : '<span class="badge badge-warn">In progress</span>'}</td>
          <td>${esc(r.reviewer)}</td>
          <td>${fmtDate(r.dueDate)}</td>
          <td><div class="progress"><div style="width:${r.progress}%"></div></div><div class="sub">${r.progress}%</div></td>
          <td class="num">${r.items.length}</td>
        </tr>`).join('')}</tbody>
    </table></div>`}`;
  window.__newReviewDeps = null;
}

window.newReviewModal = async () => {
  const [members, sites] = await Promise.all([api('/api/users?type=member'), api('/api/sites')]);
  const depts = [...new Set(sites.map(s => s.department).filter(Boolean))].sort();
  const m = modal(`
    <h2>New access review</h2>
    <div class="field"><label>Name</label><input type="text" id="rv-name" placeholder="e.g. Q3 guest access review"></div>
    <div class="field"><label>Scope</label>
      <select id="rv-scope">
        <option value="">All guest access, everywhere</option>
        ${depts.map(d => `<option value="dept:${esc(d)}">Guests on ${esc(d)} sites</option>`).join('')}
        ${sites.map(s => `<option value="site:${s.id}">Everyone on: ${esc(s.name)}</option>`).join('')}
      </select></div>
    <div class="field"><label>Reviewer</label>
      <select id="rv-reviewer">${members.map(u => `<option value="${u.id}">${esc(u.name)}</option>`).join('')}</select></div>
    <div class="field"><label>Due in (days)</label><input type="number" id="rv-due" value="14" min="1"></div>
    <div class="actions">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn primary" id="rv-save">Start review</button>
    </div>`);
  m.querySelector('#rv-save').addEventListener('click', async () => {
    const scopeVal = m.querySelector('#rv-scope').value;
    const body = {
      name: m.querySelector('#rv-name').value.trim(),
      reviewerId: m.querySelector('#rv-reviewer').value,
      dueInDays: Number(m.querySelector('#rv-due').value) || 14,
    };
    if (scopeVal.startsWith('dept:')) { body.department = scopeVal.slice(5); body.scope = `Guests on ${body.department} sites`; }
    else if (scopeVal.startsWith('site:')) { body.siteId = scopeVal.slice(5); body.scope = 'Everyone on a single site'; }
    else body.scope = 'All guest access';
    try {
      const r = await api('/api/reviews', { method: 'POST', body });
      closeModal(); toast(`Review started — ${r.items.length} items`); location.hash = `#/reviews/${r.id}`;
    } catch (err) { toast(err.message, true); }
  });
};

async function pageReviewDetail(id) {
  const r = await api(`/api/reviews/${id}`);
  const undecided = r.items.filter(i => !i.decision).length;
  main.innerHTML = `
    <div class="page-head">
      <div><h1>${esc(r.name)}</h1>
        <div class="sub">${esc(r.scope)} · reviewer ${esc(r.reviewer)} · due ${fmtDate(r.dueDate)} ·
        ${r.status === 'completed' ? `completed ${fmtDate(r.completedAt)}` : `${undecided} of ${r.items.length} left to decide`}</div></div>
      <div class="head-actions">
        ${r.status !== 'completed' ? `<button class="btn primary" ${undecided ? 'disabled title="Decide every item first"' : ''}
          onclick="act('/api/reviews/${r.id}/complete','Apply decisions? Revoked grants lose access immediately.','Review completed — decisions applied')">Complete &amp; apply</button>` : ''}
        <a class="btn" href="#/reviews">← Reviews</a>
      </div>
    </div>
    <div class="card table-wrap"><table>
      <thead><tr><th>Person</th><th>Resource</th><th>Role</th><th>Decision</th></tr></thead>
      <tbody>${r.items.map(i => `
        <tr>
          <td><strong>${esc(i.principal.name)}</strong><div class="sub">${esc(i.principal.email)}</div></td>
          <td>${esc(i.siteName)}</td>
          <td>${esc(i.role)}</td>
          <td style="white-space:nowrap">
            ${r.status === 'completed'
              ? (i.decision === 'approved' ? '<span class="badge badge-good">Approved</span>' : '<span class="badge badge-danger">Revoked</span>')
              : `<button class="btn small ${i.decision === 'approved' ? 'primary' : ''}" onclick="decide('${r.id}','${i.id}','approved')">Keep</button>
                 <button class="btn small ${i.decision === 'revoked' ? 'danger' : ''}" style="${i.decision === 'revoked' ? 'background:rgba(208,59,59,0.12)' : ''}" onclick="decide('${r.id}','${i.id}','revoked')">Revoke</button>`}
          </td>
        </tr>`).join('')}</tbody>
    </table></div>`;
}

window.decide = async (reviewId, itemId, decision) => {
  try {
    await api(`/api/reviews/${reviewId}/items/${itemId}`, { method: 'POST', body: { decision } });
    render();
  } catch (err) { toast(err.message, true); }
};

async function pagePolicies() {
  const policies = await api('/api/policies');
  const cats = [...new Set(policies.map(p => p.category))];
  main.innerHTML = `
    <div class="page-head">
      <div><h1>Policies</h1><div class="sub">Governance rules the risk engine checks continuously</div></div>
    </div>
    ${cats.map(cat => `
      <div class="card ${cat === cats[0] ? '' : 'mt'}">
        <h2>${esc(cat)}</h2>
        ${policies.filter(p => p.category === cat).map(p => `
          <div class="finding">
            <div class="body">
              <div class="title">${esc(p.name)} ${p.enabled ? '' : '<span class="badge badge-neutral">Off</span>'}</div>
              <div class="detail">${esc(p.description)}</div>
            </div>
            <div style="display:flex;gap:8px;align-items:center;flex-shrink:0">
              ${p.enabled && p.violations > 0 ? `<span class="badge badge-warn">${p.violations} violation${p.violations === 1 ? '' : 's'}</span>` : p.enabled ? '<span class="badge badge-good">Compliant</span>' : ''}
              ${p.enabled && p.fixable > 0 ? `<button class="btn small" onclick="act('/api/policies/${p.id}/enforce','Auto-fix ${p.fixable} violation(s)? This revokes links / removes stale guests / disables external sharing as needed.','Policy enforced')">Fix all (${p.fixable})</button>` : ''}
              <button class="btn small" onclick="act('/api/policies/${p.id}/toggle',null,'Policy ${p.enabled ? 'disabled' : 'enabled'}')">${p.enabled ? 'Disable' : 'Enable'}</button>
            </div>
          </div>`).join('')}
      </div>`).join('')}`;
}

async function pageActivity() {
  const activity = await api('/api/activity');
  main.innerHTML = `
    <div class="page-head"><div><h1>Activity</h1><div class="sub">Audit trail of every change made through TenantGuard</div></div></div>
    <div class="card table-wrap"><table>
      <thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Detail</th></tr></thead>
      <tbody>${activity.map(a => `
        <tr>
          <td style="white-space:nowrap">${fmtDate(a.at)}<div class="sub">${ago(a.at)}</div></td>
          <td>${esc(a.actor)}</td>
          <td><strong>${esc(a.action)}</strong></td>
          <td class="muted">${esc(a.detail)}</td>
        </tr>`).join('')}</tbody>
    </table></div>`;
}

async function pageSettings() {
  const s = await api('/api/settings');
  main.innerHTML = `
    <div class="page-head"><div><h1>Settings</h1></div></div>
    <div class="grid cols-2">
      <div class="card">
        <h2>Microsoft 365 connection</h2>
        <p class="muted" style="font-size:12.5px;margin-top:0">
          Uses an Azure <strong>App Registration</strong> with the client-credentials flow.
          Grant it these <em>application</em> permissions with admin consent:
          <code class="inline">User.Read.All</code> <code class="inline">Group.Read.All</code>
          <code class="inline">GroupMember.Read.All</code> <code class="inline">Sites.Read.All</code>
          and optionally <code class="inline">AuditLog.Read.All</code> for sign-in dates.
        </p>
        <div class="field"><label>Tenant ID (directory ID)</label><input type="text" id="g-tenant" value="${esc(s.graph.tenantId)}" placeholder="00000000-0000-…"></div>
        <div class="field"><label>Client ID (application ID)</label><input type="text" id="g-client" value="${esc(s.graph.clientId)}"></div>
        <div class="field"><label>Client secret</label><input type="password" id="g-secret" value="${esc(s.graph.clientSecret)}" placeholder="Secret value"></div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn" id="g-save">Save</button>
          <button class="btn" id="g-test">Test connection</button>
          <button class="btn primary" id="g-sync">Sync tenant now</button>
        </div>
        <p class="muted" style="font-size:12px">
          ${s.graph.connected ? '✓ Connection verified.' : 'Not connected yet.'}
          ${s.graph.lastSync ? ` Last sync: ${ago(s.graph.lastSync)}.` : ''}
          Sync is read-only — remediation actions apply to the local model only.
        </p>
      </div>
      <div>
        <div class="card">
          <h2>Risk thresholds</h2>
          <div class="field"><label>Guest is stale after (days without sign-in)</label>
            <input type="number" id="t-guest" value="${s.thresholds.staleGuestDays}" min="7"></div>
          <div class="field"><label>Site is inactive after (days)</label>
            <input type="number" id="t-site" value="${s.thresholds.inactiveSiteDays}" min="30"></div>
          <button class="btn" id="t-save">Save thresholds</button>
        </div>
        <div class="card mt">
          <h2>Demo data</h2>
          <p class="muted" style="font-size:12.5px;margin-top:0">Currently ${s.demoMode ? 'showing the seeded demo tenant' : 'showing synced tenant data'}.</p>
          <button class="btn danger" onclick="act('/api/demo/reset','Reset all data back to the original demo tenant?','Demo data reset')">Reset demo data</button>
        </div>
      </div>
    </div>`;

  const graphBody = () => ({
    graph: {
      tenantId: document.getElementById('g-tenant').value.trim(),
      clientId: document.getElementById('g-client').value.trim(),
      clientSecret: document.getElementById('g-secret').value,
    },
  });
  document.getElementById('g-save').addEventListener('click', async () => {
    await api('/api/settings', { method: 'PUT', body: graphBody() });
    toast('Connection settings saved');
  });
  document.getElementById('g-test').addEventListener('click', async () => {
    try {
      await api('/api/settings', { method: 'PUT', body: graphBody() });
      const r = await api('/api/graph/test', { method: 'POST' });
      toast(`Connected to ${r.tenantName}`);
    } catch (err) { toast(err.message, true); }
  });
  document.getElementById('g-sync').addEventListener('click', async () => {
    try {
      await api('/api/settings', { method: 'PUT', body: graphBody() });
      toast('Syncing… this can take a minute on large tenants');
      const r = await api('/api/graph/sync', { method: 'POST' });
      toast(`Synced ${r.counts.users} users, ${r.counts.groups} groups, ${r.counts.sites} sites`);
      render();
    } catch (err) { toast(err.message, true); }
  });
  document.getElementById('t-save').addEventListener('click', async () => {
    await api('/api/settings', {
      method: 'PUT',
      body: { thresholds: { staleGuestDays: Number(document.getElementById('t-guest').value) || 90, inactiveSiteDays: Number(document.getElementById('t-site').value) || 180 } },
    });
    toast('Thresholds saved'); render();
  });
}

// ---------- router ----------

const ROUTES = [
  [/^#?\/?$/, () => pageDashboard(), 'dashboard'],
  [/^#\/findings\/(\w+)$/, m => pageFindings(m[1]), 'dashboard'],
  [/^#\/sites$/, () => pageSites(), 'sites'],
  [/^#\/sites\/([^/]+)$/, m => pageSiteDetail(m[1]), 'sites'],
  [/^#\/groups$/, () => pageGroups(), 'groups'],
  [/^#\/guests$/, () => pageGuests(), 'guests'],
  [/^#\/links$/, () => pageLinks(), 'links'],
  [/^#\/reviews$/, () => pageReviews(), 'reviews'],
  [/^#\/reviews\/([^/]+)$/, m => pageReviewDetail(m[1]), 'reviews'],
  [/^#\/policies$/, () => pagePolicies(), 'policies'],
  [/^#\/activity$/, () => pageActivity(), 'activity'],
  [/^#\/settings$/, () => pageSettings(), 'settings'],
];

async function render() {
  const hash = location.hash || '#/';
  for (const [rx, fn, nav] of ROUTES) {
    const m = hash.match(rx);
    if (m) {
      document.querySelectorAll('#nav a').forEach(a => a.classList.toggle('active', a.dataset.page === nav));
      try { await fn(m); } catch (err) {
        main.innerHTML = `<div class="card"><div class="empty">Error: ${esc(err.message)}</div></div>`;
      }
      return;
    }
  }
  location.hash = '#/';
}

async function refreshTenantBadge() {
  try {
    const s = await api('/api/settings');
    document.getElementById('tenant-name').textContent = s.tenantName;
    document.getElementById('tenant-badge').textContent = s.demoMode ? 'demo' : 'live';
  } catch { /* ignore */ }
}

window.addEventListener('hashchange', render);
render();
refreshTenantBadge();
