// Risk engine: evaluates the tenant against enabled policies and produces
// findings (with severity + remediation hints) and an overall risk score.

const DAY = 86400000;

function daysSince(iso) {
  if (!iso) return Infinity;
  return Math.floor((Date.now() - new Date(iso).getTime()) / DAY);
}

export function computeFindings(state) {
  const { sites, groups, users, links, policies, reviews, settings } = state;
  const enabled = id => policies.find(p => p.id === id)?.enabled;
  const staleDays = settings.thresholds?.staleGuestDays ?? 90;
  const inactiveDays = settings.thresholds?.inactiveSiteDays ?? 180;
  const findings = [];

  const activeLinks = links.filter(l => !l.revoked);
  const siteById = Object.fromEntries(sites.map(s => [s.id, s]));

  if (enabled('pol-anyone-links')) {
    for (const l of activeLinks.filter(l => l.type === 'anyone')) {
      const site = siteById[l.siteId];
      const confidential = site && site.sensitivity !== 'General';
      findings.push({
        policyId: 'pol-anyone-links',
        severity: confidential ? 'critical' : 'high',
        kind: 'link',
        targetId: l.id,
        title: `"Anyone" link on ${l.item.split('/').pop()}`,
        detail: `Anyone on the internet with this link can ${l.permission} this file on ${site?.name ?? l.siteId}${confidential ? ` — site is labeled ${site.sensitivity}` : ''}.`,
        fix: 'Revoke link',
      });
    }
  }

  if (enabled('pol-link-expiry')) {
    for (const l of activeLinks.filter(l => l.type !== 'anyone' && !l.expires)) {
      findings.push({
        policyId: 'pol-link-expiry',
        severity: 'medium',
        kind: 'link',
        targetId: l.id,
        title: `Link without expiration on ${l.item.split('/').pop()}`,
        detail: `A ${l.type.replace('-', ' ')} link on ${siteById[l.siteId]?.name ?? l.siteId} never expires.`,
        fix: 'Set 30-day expiry',
      });
    }
  }

  if (enabled('pol-guest-expiry')) {
    for (const g of users.filter(u => u.type === 'guest' && u.enabled)) {
      const d = daysSince(g.lastSignIn);
      if (d >= staleDays) {
        findings.push({
          policyId: 'pol-guest-expiry',
          severity: d === Infinity ? 'high' : 'medium',
          kind: 'guest',
          targetId: g.id,
          title: `Stale guest: ${g.name}`,
          detail: g.lastSignIn
            ? `${g.email} has not signed in for ${d} days.`
            : `${g.email} was invited but has never signed in.`,
          fix: 'Remove guest',
        });
      }
    }
  }

  if (enabled('pol-min-owners')) {
    for (const grp of groups) {
      if (grp.owners.length < 2) {
        findings.push({
          policyId: 'pol-min-owners',
          severity: grp.owners.length === 0 ? 'high' : 'low',
          kind: 'group',
          targetId: grp.id,
          title: grp.owners.length === 0 ? `Ownerless team: ${grp.name}` : `Single owner: ${grp.name}`,
          detail: `${grp.name} has ${grp.owners.length} owner${grp.owners.length === 1 ? '' : 's'} and ${grp.members.length} members.`,
          fix: 'Assign owner',
        });
      }
    }
  }

  if (enabled('pol-confidential-external')) {
    for (const s of sites) {
      if (s.sensitivity !== 'General' && s.externalSharing !== 'internal-only') {
        findings.push({
          policyId: 'pol-confidential-external',
          severity: s.sensitivity === 'Highly Confidential' ? 'critical' : 'high',
          kind: 'site',
          targetId: s.id,
          title: `External sharing on ${s.sensitivity} site`,
          detail: `${s.name} is labeled ${s.sensitivity} but allows external sharing (${s.externalSharing.replace('-', ' ')}).`,
          fix: 'Disable external sharing',
        });
      }
    }
  }

  if (enabled('pol-inactive-sites')) {
    for (const s of sites) {
      if (daysSince(s.lastActivity) >= inactiveDays) {
        findings.push({
          policyId: 'pol-inactive-sites',
          severity: 'low',
          kind: 'site',
          targetId: s.id,
          title: `Inactive site: ${s.name}`,
          detail: `No activity for ${daysSince(s.lastActivity)} days. ${Math.round(s.storageMB / 100) / 10} GB in use.`,
          fix: null,
        });
      }
    }
  }

  if (enabled('pol-public-guests')) {
    for (const grp of groups) {
      if (grp.privacy === 'public' && grp.guests.length > 0) {
        findings.push({
          policyId: 'pol-public-guests',
          severity: 'high',
          kind: 'group',
          targetId: grp.id,
          title: `Guests in public team: ${grp.name}`,
          detail: `${grp.guests.length} guest${grp.guests.length === 1 ? '' : 's'} in a public team — public content is visible to everyone in the org, and guests here signal over-sharing.`,
          fix: null,
        });
      }
    }
  }

  if (enabled('pol-review-cadence')) {
    const confidentialSites = sites.filter(s => s.sensitivity !== 'General');
    for (const s of confidentialSites) {
      const reviewed = reviews.some(r => r.status === 'completed'
        && daysSince(r.completedAt) <= 90
        && r.items.some(i => i.siteId === s.id));
      if (!reviewed) {
        findings.push({
          policyId: 'pol-review-cadence',
          severity: 'medium',
          kind: 'site',
          targetId: s.id,
          title: `Access review overdue: ${s.name}`,
          detail: `${s.name} is labeled ${s.sensitivity} but has no completed access review in the last 90 days.`,
          fix: 'Start review',
        });
      }
    }
  }

  const order = { critical: 0, high: 1, medium: 2, low: 3 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);
  return findings;
}

export function computeRiskScore(findings) {
  // 100 = clean. Weighted deductions with diminishing returns per finding.
  const weights = { critical: 6, high: 3, medium: 1.2, low: 0.4 };
  let penalty = 0;
  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of findings) {
    counts[f.severity]++;
    penalty += weights[f.severity] / Math.sqrt(counts[f.severity]);
  }
  const score = Math.max(0, Math.round(100 - penalty));
  const grade = score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : score >= 40 ? 'D' : 'F';
  return { score, grade, counts };
}

export function buildSummary(state) {
  const findings = computeFindings(state);
  const risk = computeRiskScore(findings);
  const { sites, groups, users, links, reviews } = state;
  const guests = users.filter(u => u.type === 'guest' && u.enabled);
  const activeLinks = links.filter(l => !l.revoked);

  return {
    tenantName: state.settings.tenantName,
    demoMode: state.settings.demoMode,
    lastSync: state.settings.graph?.lastSync ?? null,
    risk,
    counts: {
      sites: sites.length,
      teams: groups.length,
      users: users.filter(u => u.type === 'member').length,
      guests: guests.length,
      links: activeLinks.length,
      anyoneLinks: activeLinks.filter(l => l.type === 'anyone').length,
      ownerless: groups.filter(g => g.owners.length === 0).length,
      openReviews: reviews.filter(r => r.status === 'in-progress').length,
    },
    findings,
    bySeverity: risk.counts,
    byPolicy: countBy(findings, f => f.policyId),
    activity: state.activity.slice(0, 10),
  };
}

function countBy(arr, keyFn) {
  const out = {};
  for (const x of arr) {
    const k = keyFn(x);
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}
