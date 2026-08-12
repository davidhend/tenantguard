// Generates a realistic demo Microsoft 365 tenant so the app is useful
// out of the box, with governance problems deliberately planted for the
// risk engine to find. Deterministic (seeded PRNG) so resets are stable.

function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const FIRST = ['Ava', 'Liam', 'Noah', 'Emma', 'Mia', 'Ethan', 'Sofia', 'Lucas', 'Ines', 'Marc', 'Julie', 'Omar', 'Priya', 'Chen', 'Sam', 'Nadia', 'Erik', 'Rosa', 'Tomas', 'Keiko', 'Dana', 'Felix', 'Grace', 'Hugo', 'Iris', 'Jon', 'Kara', 'Leo', 'Maya', 'Nils'];
const LAST = ['Tremblay', 'Nguyen', 'Smith', 'Garcia', 'Kowalski', 'Okafor', 'Dubois', 'Rossi', 'Kim', 'Patel', 'Muller', 'Silva', 'Ivanov', 'Larsen', 'Costa', 'Haddad', 'Novak', 'Berg', 'Tanaka', 'Moreau'];
const GUEST_DOMAINS = ['contractorhub.com', 'acmepartners.io', 'nordicdesign.se', 'lawfirmllp.com', 'agencyone.co', 'freelance.dev'];
const DEPTS = ['Finance', 'Human Resources', 'Marketing', 'Engineering', 'Sales', 'Legal', 'Operations', 'IT'];
const SITE_TOPICS = ['Budget Planning', 'Payroll', 'Recruiting', 'Brand Assets', 'Product Roadmap', 'Customer Contracts', 'Vendor Management', 'Compliance Docs', 'Quarterly Reports', 'Team Handbook', 'Event Planning', 'Research Archive', 'Client Deliverables', 'Onboarding', 'Strategy 2026', 'Press Kit', 'Audit Evidence', 'Sales Playbook', 'Design System', 'Incident Runbooks', 'Benefits Enrollment', 'Board Materials', 'Partner Portal', 'Training Materials'];
const FILES = ['Budget_FY26.xlsx', 'Salaries_Review.xlsx', 'Contract_Draft_v3.docx', 'Roadmap.pptx', 'Customer_List.csv', 'NDA_Signed.pdf', 'Offer_Letter_Template.docx', 'Audit_Findings.docx', 'Merger_Notes.docx', 'Passwords_DO_NOT_SHARE.txt', 'Board_Deck_Q3.pptx', 'Employee_Handbook.pdf', 'Vendor_Quotes.xlsx', 'Design_Assets.zip', 'Financial_Model.xlsx'];
const SENSITIVITY = ['General', 'General', 'General', 'Confidential', 'Confidential', 'Highly Confidential'];

function pick(rng, arr) { return arr[Math.floor(rng() * arr.length)]; }
function daysAgo(rng, min, max) {
  const d = new Date();
  d.setDate(d.getDate() - Math.floor(min + rng() * (max - min)));
  return d.toISOString();
}

export function seedDemoTenant() {
  const rng = makeRng(20260811);
  const users = [];
  const usedNames = new Set();

  for (let i = 0; i < 48; i++) {
    let name;
    do { name = `${pick(rng, FIRST)} ${pick(rng, LAST)}`; } while (usedNames.has(name));
    usedNames.add(name);
    const email = name.toLowerCase().replace(' ', '.') + '@fabrikam.com';
    users.push({
      id: `u-${i}`,
      name,
      email,
      type: 'member',
      department: pick(rng, DEPTS),
      lastSignIn: daysAgo(rng, 0, 40),
      enabled: true,
    });
  }
  for (let i = 0; i < 14; i++) {
    let name;
    do { name = `${pick(rng, FIRST)} ${pick(rng, LAST)}`; } while (usedNames.has(name));
    usedNames.add(name);
    const email = name.toLowerCase().replace(' ', '.') + '@' + pick(rng, GUEST_DOMAINS);
    users.push({
      id: `g-${i}`,
      name,
      email,
      type: 'guest',
      department: null,
      // Plant a mix of active and stale guests (some never signed in).
      lastSignIn: i % 3 === 0 ? null : daysAgo(rng, i % 4 === 1 ? 95 : 2, i % 4 === 1 ? 400 : 60),
      invitedAt: daysAgo(rng, 30, 500),
      invitedBy: `u-${Math.floor(rng() * 48)}`,
      enabled: true,
    });
  }

  const members = users.filter(u => u.type === 'member');
  const guests = users.filter(u => u.type === 'guest');

  const groups = [];
  const sites = [];
  const links = [];
  const permissions = [];

  SITE_TOPICS.forEach((topic, i) => {
    const dept = pick(rng, DEPTS);
    const isTeam = i % 3 !== 2; // two thirds are Teams-connected
    const siteId = `s-${i}`;
    const slug = topic.replace(/\s+/g, '');
    const sensitivity = pick(rng, SENSITIVITY);
    const ownerCount = i % 7 === 3 ? 0 : i % 5 === 4 ? 1 : 2; // plant ownerless + single-owner
    const owners = [];
    for (let o = 0; o < ownerCount; o++) owners.push(pick(rng, members).id);
    const memberIds = new Set(owners);
    const memberCount = 3 + Math.floor(rng() * 20);
    while (memberIds.size < memberCount) memberIds.add(pick(rng, members).id);
    const groupGuests = [];
    if (i % 4 === 1 || i % 4 === 3) {
      const gCount = 1 + Math.floor(rng() * 3);
      for (let g = 0; g < gCount; g++) groupGuests.push(pick(rng, guests).id);
    }
    const lastActivity = i % 6 === 5 ? daysAgo(rng, 190, 420) : daysAgo(rng, 0, 90);
    const externalSharing = i % 3 === 0 ? 'anyone' : i % 3 === 1 ? 'existing-guests' : 'internal-only';
    const isPublic = isTeam && i % 5 === 0;

    sites.push({
      id: siteId,
      name: topic,
      url: `https://fabrikam.sharepoint.com/sites/${slug}`,
      template: isTeam ? 'Team site' : 'Communication site',
      department: dept,
      sensitivity,
      externalSharing,
      storageMB: Math.floor(50 + rng() * 8000),
      lastActivity,
      created: daysAgo(rng, 200, 900),
      groupId: isTeam ? `grp-${i}` : null,
      uniquePermissionItems: i % 4 === 0 ? Math.floor(rng() * 14) + 2 : 0,
    });

    if (isTeam) {
      groups.push({
        id: `grp-${i}`,
        name: topic,
        type: 'team',
        privacy: isPublic ? 'public' : 'private',
        owners,
        members: [...memberIds],
        guests: [...new Set(groupGuests)],
        siteId,
        lastActivity,
        created: daysAgo(rng, 200, 900),
      });
    }

    // Direct permissions on the site
    owners.forEach(uid => permissions.push({ siteId, principalId: uid, role: 'Full control', source: 'Owner' }));
    [...memberIds].filter(id => !owners.includes(id)).slice(0, 6)
      .forEach(uid => permissions.push({ siteId, principalId: uid, role: 'Edit', source: isTeam ? 'Group membership' : 'Direct' }));
    [...new Set(groupGuests)].forEach(gid => permissions.push({ siteId, principalId: gid, role: 'Edit', source: 'Guest access' }));

    // Sharing links — plant risky "anyone" links, some on confidential content, some expired-less
    const linkCount = Math.floor(rng() * 5) + (externalSharing === 'anyone' ? 2 : 0);
    for (let l = 0; l < linkCount; l++) {
      const linkType = externalSharing === 'anyone' && l < 2 ? 'anyone'
        : rng() < 0.4 ? 'organization' : 'specific-people';
      links.push({
        id: `lnk-${i}-${l}`,
        siteId,
        item: `/${slug}/${pick(rng, FILES)}`,
        type: linkType, // anyone | organization | specific-people
        permission: rng() < 0.5 ? 'edit' : 'view',
        createdBy: pick(rng, members).id,
        created: daysAgo(rng, 1, 300),
        expires: linkType === 'anyone' && l === 0 ? null : rng() < 0.5 ? null : daysAgo(rng, -60, -5),
        revoked: false,
      });
    }
  });

  const policies = [
    { id: 'pol-guest-expiry', name: 'Guest access expires after 90 days of inactivity', category: 'External sharing', enabled: true, auto: false, description: 'Guests who have not signed in for 90 days should have their access removed.' },
    { id: 'pol-anyone-links', name: 'Block "Anyone" sharing links', category: 'External sharing', enabled: true, auto: false, description: 'Links that work for anyone on the internet are not allowed. Existing ones should be revoked.' },
    { id: 'pol-link-expiry', name: 'Sharing links must have an expiration date', category: 'External sharing', enabled: true, auto: false, description: 'Every sharing link must expire; links without an expiration date are flagged.' },
    { id: 'pol-min-owners', name: 'Teams and groups need at least 2 owners', category: 'Ownership', enabled: true, auto: false, description: 'Ownerless or single-owner groups are a continuity risk. Flag any group with fewer than 2 owners.' },
    { id: 'pol-confidential-external', name: 'No external sharing on Confidential sites', category: 'Sensitive data', enabled: true, auto: false, description: 'Sites labeled Confidential or Highly Confidential must have external sharing disabled.' },
    { id: 'pol-inactive-sites', name: 'Flag sites inactive for 180+ days', category: 'Lifecycle', enabled: true, auto: false, description: 'Stale sites accumulate risk and cost. Flag for archival or deletion.' },
    { id: 'pol-public-guests', name: 'Public teams must not contain guests', category: 'External sharing', enabled: false, auto: false, description: 'Guests in public teams can see all public team content across the organization.' },
    { id: 'pol-review-cadence', name: 'Quarterly access reviews on Confidential sites', category: 'Access reviews', enabled: true, auto: false, description: 'Every site labeled Confidential must have a completed access review in the last 90 days.' },
  ];

  const reviews = [
    {
      id: 'rev-1',
      name: 'Q3 guest access review — Finance sites',
      scope: 'Guests on Finance department sites',
      status: 'in-progress',
      createdAt: daysAgo(rng, 12, 12),
      dueDate: daysAgo(rng, -14, -14),
      reviewerId: members[0].id,
      items: [],
    },
  ];
  // Populate review items from actual guest permissions on Finance sites
  const finSites = sites.filter(s => s.department === 'Finance');
  for (const p of permissions) {
    if (p.source === 'Guest access' && finSites.some(s => s.id === p.siteId)) {
      reviews[0].items.push({
        id: `ri-${reviews[0].items.length}`,
        principalId: p.principalId,
        siteId: p.siteId,
        role: p.role,
        decision: null, // null | approved | revoked
        decidedAt: null,
      });
    }
  }
  if (reviews[0].items.length === 0) {
    // Guarantee the demo review has content
    const anyGuestPerm = permissions.filter(p => p.source === 'Guest access').slice(0, 4);
    anyGuestPerm.forEach((p, idx) => reviews[0].items.push({
      id: `ri-${idx}`, principalId: p.principalId, siteId: p.siteId, role: p.role, decision: null, decidedAt: null,
    }));
  }

  return {
    settings: {
      tenantName: 'Fabrikam (demo tenant)',
      demoMode: true,
      graph: { tenantId: '', clientId: '', clientSecret: '', connected: false, lastSync: null },
      thresholds: { staleGuestDays: 90, inactiveSiteDays: 180 },
    },
    users,
    groups,
    sites,
    links,
    permissions,
    reviews,
    policies,
    activity: [
      { id: 'act-seed', at: new Date().toISOString(), actor: 'System', action: 'Demo tenant generated', detail: `${sites.length} sites, ${groups.length} teams, ${users.length} users, ${links.length} sharing links` },
    ],
  };
}
