/**
 * F&B PT Onboarding Portal
 * Shows each PIC only the onboarding status rows for their own outlet(s).
 * ClickUp is polled in the background every 5 minutes by a time-driven trigger
 * (refreshClickUpCache_, installed once via ensureRefreshTrigger_) that always runs
 * as the script owner, and the result is cached (CacheService). Viewers only ever
 * read that cache - they never call ClickUp themselves. This is deliberate: a web
 * app deployed to "Execute as: User accessing the web app" requires every viewer's
 * own Google account to individually authorize UrlFetchApp's external-request scope,
 * and some partner companies' Workspace domains block that consent for unverified
 * internal apps with no self-serve way around it. Caching removes the need for that
 * scope entirely, so any signed-in Google user works immediately, no authorization
 * step required.
 * The dashboard (stat cards, by-outlet, by-status, table) re-renders entirely
 * client-side when the outlet filter changes - no page reload.
 *
 * SETUP:
 * 1. Script Properties (Project Settings > Script Properties):
 *    CLICKUP_TOKEN = your ClickUp personal API token.
 *    (ADMINS, VIEWERS, PIC_MAPPINGS and OUTLET_CATEGORIES are all created/managed
 *    automatically by the in-portal "Manage Access" panel below - no manual setup.)
 * 2. Run ensureRefreshTrigger_() once from this editor (as the owner) to start the
 *    5-minute background refresh, then run refreshClickUpCache_() once immediately
 *    after so the cache isn't empty before the first trigger fires.
 * 3. Deploy > New deployment > Web app.
 *    - Execute as: User accessing the web app
 *    - Who has access: Anyone with a Google account
 * 4. Share the deployment URL. Add each PIC/Viewer/Admin via the in-portal "Manage Access"
 *    panel (Admins only). There is deliberately no Google Sheet involved anywhere in
 *    this project: who-has-access-to-what is sensitive (it shows every PIC's outlet
 *    assignment), and a Sheet is a Drive file - shareable, findable, exportable. It's
 *    stored instead in this script's own Properties Service, which isn't a Drive object
 *    at all, so there's nothing for a PIC to ever find in their Drive, regardless of any
 *    sharing setting. No PIC needs, or gets, any Drive/Sheet permission at any point.
 *
 * ROLES:
 *    Admin  - sees every outlet in every country, manages Admins/Viewers/PICs.
 *    Viewer - read-only, no Manage Access button. Scope 'all' sees everything Admin
 *             sees; 'fnb'/'salon'/'others'/'group_management' sees only outlets tagged
 *             with that category in OUTLET_CATEGORIES. A country with none of its
 *             outlets tagged for that scope simply doesn't show up for that Viewer,
 *             rather than showing it unfiltered.
 *    PIC    - sees only their explicitly assigned outlet(s), as before.
 */

// Each country's Outlet/Position/Full Name come from its own ClickUp custom fields -
// SG's are named "Outlet"/"Role"/"Full Name", MY's are named "Assigned Outlet"/
// "Official Part-time Position"/"Full Name (as per NRIC/ID)".
var COUNTRIES = [
  {
    code: 'SG', label: 'Singapore', listId: '901819849781',
    fullNameField: 'Full Name', outletField: 'Outlet', roleField: 'Role'
  },
  {
    code: 'MY', label: 'Malaysia', listId: '901819757280',
    fullNameField: 'Full Name (as per NRIC/ID)', outletField: 'Assigned Outlet', roleField: 'Official Part-time Position'
  }
];

// Viewer scopes: a Viewer sees outlets tagged with their scope's category, read-only.
// 'all' bypasses categorization entirely (same outlets as Admin). The rest depend on
// OUTLET_CATEGORIES being set per outlet - see getOutletCategories_/saveOutletCategories_.
var VALID_SCOPES = ['all', 'fnb', 'salon', 'others', 'group_management'];
var CATEGORY_LABELS = { all: 'All outlets', fnb: 'F&B', salon: 'Salon', others: 'Others', group_management: 'Group Management' };

// Each country has its own outlet namespace - an outlet named e.g. "Modu K" in
// Singapore is a completely different outlet from one with the same name in
// Malaysia. So a PIC's access is always resolved within a single country's own
// stored mappings and own ClickUp list - never matched against another country's
// outlets or tasks.
function doGet(e) {
  var email = Session.getActiveUser().getEmail();
  if (!email) {
    return HtmlOutput_('Sign-in required', '<p>Please sign in with your Google account to view this page.</p>');
  }

  try {
    return doGetInner_(email);
  } catch (err) {
    if (err && err.isClickUpError) {
      Logger.log('ClickUp fetch failed for ' + email + ': ' + err.message + (err.detail ? ' | ' + err.detail : ''));
      return HtmlOutput_('ClickUp unavailable',
        '<p>' + escapeHtml_(err.message) + '</p>' +
        (err.detail ? '<p class="muted">' + escapeHtml_(err.detail) + '</p>' : '') +
        '<p>Please try again shortly.</p>');
    }
    throw err;
  }
}

function doGetInner_(email) {
  var isAdmin = isAdmin_(email);
  var viewerScope = isAdmin ? null : getViewerScope_(email);
  var roleLabel = isAdmin ? 'Admin' : (viewerScope ? 'Viewer · ' + (CATEGORY_LABELS[viewerScope] || viewerScope) : 'PIC');
  var countries;

  if (isAdmin || viewerScope === 'all') {
    countries = COUNTRIES.map(function (c) {
      var rows = getClickUpTasks_(c);
      return {
        code: c.code,
        label: c.label,
        outletsLabel: c.label + (isAdmin ? ' (admin view)' : ' (all outlets)'),
        rows: rows,
        outlets: getOutletOptionsForCountry_(c)
      };
    });
  } else if (viewerScope) {
    // Scoped Viewer (F&B / Salon / Others / Group Management): filter every country's
    // rows to outlets tagged with this scope's category. A country with no categorized
    // outlets in this scope simply contributes nothing - never shown unfiltered, since
    // that would over-expose it.
    var categories = getOutletCategories_();
    countries = [];
    COUNTRIES.forEach(function (c) {
      var rows = getClickUpTasks_(c).filter(function (t) {
        return getOutletCategoryFor_(categories, c.code, t.outlet) === viewerScope;
      });
      if (rows.length === 0) return;
      countries.push({
        code: c.code,
        label: c.label,
        outletsLabel: c.label + ' (' + (CATEGORY_LABELS[viewerScope] || viewerScope) + ')',
        rows: rows,
        outlets: uniqueOutlets_(rows)
      });
    });
    if (countries.length === 0) {
      return HtmlOutput_('No access configured',
        '<p>No ' + escapeHtml_(CATEGORY_LABELS[viewerScope] || viewerScope) + ' outlets found for <b>' + escapeHtml_(email) + '</b> right now.</p>' +
        '<p>Contact HR if this looks wrong.</p>');
    }
  } else {
    countries = [];
    COUNTRIES.forEach(function (c) {
      var outletOptions = getOutletsForEmail_(email, c.code);
      if (outletOptions.length === 0) return;
      var wanted = {};
      outletOptions.forEach(function (o) { wanted[o.toLowerCase()] = true; });
      var rows = getClickUpTasks_(c).filter(function (t) { return wanted[t.outlet.toLowerCase()]; });
      countries.push({ code: c.code, label: c.label, outletsLabel: outletOptions.join(', '), rows: rows, outlets: outletOptions });
    });
    if (countries.length === 0) {
      return HtmlOutput_('No access configured',
        '<p>No outlet is set up for <b>' + escapeHtml_(email) + '</b>.</p>' +
        '<p>Contact HR to be added to the onboarding portal.</p>');
    }
  }

  return HtmlOutput_('Onboarding Status', renderShell_(countries, email, isAdmin, roleLabel));
}

// Wraps a ClickUp UrlFetchApp call so an expired token, rate limit or outage surfaces
// as a ClickUpError with a friendly message instead of a raw stack trace reaching the user.
function fetchClickUp_(url, token) {
  var resp;
  try {
    resp = UrlFetchApp.fetch(url, { headers: { Authorization: token }, muteHttpExceptions: true });
  } catch (e) {
    throw new ClickUpError_('Could not reach ClickUp. Please try again in a moment.', e.toString());
  }
  var code = resp.getResponseCode();
  if (code >= 400) {
    var message = code === 401 ? 'The ClickUp API token has expired or is invalid.' :
      code === 429 ? 'ClickUp is rate-limiting requests right now. Please try again shortly.' :
      'ClickUp returned an error (HTTP ' + code + ').';
    throw new ClickUpError_(message, 'HTTP ' + code + ': ' + resp.getContentText().slice(0, 300));
  }
  return JSON.parse(resp.getContentText());
}

function ClickUpError_(message, detail) {
  this.message = message;
  this.detail = detail || '';
  this.isClickUpError = true;
}
ClickUpError_.prototype = Object.create(Error.prototype);

// Live ClickUp fetch - only ever called from refreshClickUpCache_ (the trigger), which
// always runs as the script owner. Never call this from the doGet request path: that
// path runs as whichever Google account is viewing the page, and would require every
// such viewer to individually authorize UrlFetchApp - see the file header comment.
function fetchClickUpTasksLive_(country) {
  var token = PropertiesService.getScriptProperties().getProperty('CLICKUP_TOKEN');
  var tasks = [];
  var page = 0;
  while (true) {
    var url = 'https://api.clickup.com/api/v2/list/' + country.listId + '/task' +
      '?include_closed=true&subtasks=true&page=' + page;
    var data = fetchClickUp_(url, token);
    var batch = data.tasks || [];
    tasks = tasks.concat(batch);
    if (batch.length < 100 || data.last_page) break;
    page++;
  }

  return tasks.map(function (t) {
    var statusRaw = t.status && t.status.status ? t.status.status : '';
    return {
      outlet: getCustomFieldValue_(t, country.outletField),
      name: getCustomFieldValue_(t, country.fullNameField) || t.name || '',
      position: getCustomFieldValue_(t, country.roleField),
      status: statusRaw.toUpperCase(),
      dueDate: t.due_date ? new Date(Number(t.due_date)).toISOString() : null,
      lastUpdated: t.date_updated ? new Date(Number(t.date_updated)).toISOString() : null
    };
  });
}

// Request-path read: the dashboard's onboarding rows, from the cache the trigger keeps
// warm - never a live ClickUp call. See file header comment for why.
function getClickUpTasks_(country) {
  var raw = CacheService.getScriptCache().get('clickup_tasks_' + country.code);
  if (!raw) {
    throw new ClickUpError_('Onboarding data is still loading. Please try again in a few minutes.',
      'Cache empty for ' + country.code + ' - the background refresh (refreshClickUpCache_) may not have run yet.');
  }
  return JSON.parse(raw).map(function (t) {
    return {
      outlet: t.outlet,
      name: t.name,
      position: t.position,
      status: t.status,
      dueDate: t.dueDate ? new Date(t.dueDate) : '',
      lastUpdated: t.lastUpdated ? new Date(t.lastUpdated) : ''
    };
  });
}

// Each country's Outlet dropdown options come from its own ClickUp field definition
// itself (auto-syncs as outlets are added/removed in ClickUp, no code change needed).
// Request-path read: from cache, never a live ClickUp call - see file header comment.
function getOutletOptionsForCountry_(country) {
  var raw = CacheService.getScriptCache().get('clickup_outlets_' + country.code);
  return raw ? JSON.parse(raw) : [];
}

// The distinct outlets actually present in a set of rows, sorted. Used for a scoped
// Viewer's outlet list (only the outlets their category-filtered rows actually touch,
// not every live outlet).
function uniqueOutlets_(rows) {
  var seen = {};
  var outlets = [];
  rows.forEach(function (r) {
    if (r.outlet && !seen[r.outlet.toLowerCase()]) {
      seen[r.outlet.toLowerCase()] = true;
      outlets.push(r.outlet);
    }
  });
  outlets.sort();
  return outlets;
}

function getCustomFieldValue_(task, fieldName) {
  var field = (task.custom_fields || []).filter(function (f) { return f.name === fieldName; })[0];
  if (!field || field.value === undefined || field.value === null || field.value === '') return '';
  if (field.type === 'drop_down' && field.type_config && field.type_config.options) {
    var opt = field.type_config.options[field.value];
    return opt ? opt.name : '';
  }
  return String(field.value);
}

// Live ClickUp fetch - only ever called from refreshClickUpCache_. See fetchClickUpTasksLive_
// above for why the request path must never call this directly.
function fetchOutletFieldOptionsLive_(listId, fieldName) {
  var token = PropertiesService.getScriptProperties().getProperty('CLICKUP_TOKEN');
  var url = 'https://api.clickup.com/api/v2/list/' + listId + '/field';
  var data = fetchClickUp_(url, token);
  var field = (data.fields || []).filter(function (f) { return f.name === fieldName; })[0];
  if (!field || !field.type_config || !field.type_config.options) return [];
  return field.type_config.options
    .slice()
    .sort(function (a, b) { return a.orderindex - b.orderindex; })
    .map(function (o) { return o.name; })
    .filter(function (n) { return n; });
}

// Refreshes the ClickUp cache for both countries. Called only by the time-driven trigger
// installed by ensureRefreshTrigger_, which always runs as the script owner - so this is
// the one and only place UrlFetchApp is ever called under a real, already-authorized
// identity. CacheService entries are set to the max 6h TTL; actual freshness is governed
// by how often the trigger fires (every 5 minutes), not by this TTL.
function refreshClickUpCache_() {
  var cache = CacheService.getScriptCache();
  COUNTRIES.forEach(function (c) {
    var tasks = fetchClickUpTasksLive_(c);
    var outlets = fetchOutletFieldOptionsLive_(c.listId, c.outletField);
    cache.put('clickup_tasks_' + c.code, JSON.stringify(tasks), 21600);
    cache.put('clickup_outlets_' + c.code, JSON.stringify(outlets), 21600);
  });
}

// One-time setup: run this once from the editor (as the owner) to install the 5-minute
// background refresh trigger. Idempotent - safe to run again without creating duplicates.
function ensureRefreshTrigger_() {
  var already = ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === 'refreshClickUpCache_';
  });
  if (already) {
    Logger.log('Trigger already exists - no action taken.');
    return;
  }
  ScriptApp.newTrigger('refreshClickUpCache_').timeBased().everyMinutes(5).create();
  Logger.log('Created refreshClickUpCache_ trigger, every 5 minutes.');
}

// ---- Access-control storage: Properties Service, deliberately not a Sheet ----
// ADMINS is a JSON array of email strings. VIEWERS is a JSON array of {email, scope}
// objects, scope being one of VALID_SCOPES. PIC_MAPPINGS is a JSON array of
// {country, email, outlet} objects. OUTLET_CATEGORIES is a JSON array of
// {country, outlet, category} objects (category being one of VALID_SCOPES except 'all') -
// this is what a scoped Viewer's outlet list is filtered against, looked up per-country via
// getOutletCategoryFor_ so an outlet name collision between countries can never cross-tag.
// Properties Service is scoped to this script project itself - it isn't a Drive file, has
// no "share" concept, and is read the same way regardless of who is viewing the web app, so
// none of this can ever be found in anyone's Drive no matter what.

function getAdmins_() {
  var raw = PropertiesService.getScriptProperties().getProperty('ADMINS');
  return raw ? JSON.parse(raw) : [];
}

function saveAdmins_(admins) {
  PropertiesService.getScriptProperties().setProperty('ADMINS', JSON.stringify(admins));
}

function getViewers_() {
  var raw = PropertiesService.getScriptProperties().getProperty('VIEWERS');
  return raw ? JSON.parse(raw) : [];
}

function saveViewers_(viewers) {
  PropertiesService.getScriptProperties().setProperty('VIEWERS', JSON.stringify(viewers));
}

function getMappings_() {
  var raw = PropertiesService.getScriptProperties().getProperty('PIC_MAPPINGS');
  return raw ? JSON.parse(raw) : [];
}

function saveMappings_(mappings) {
  PropertiesService.getScriptProperties().setProperty('PIC_MAPPINGS', JSON.stringify(mappings));
}

function getOutletCategories_() {
  var raw = PropertiesService.getScriptProperties().getProperty('OUTLET_CATEGORIES');
  return raw ? JSON.parse(raw) : [];
}

function saveOutletCategories_(categories) {
  PropertiesService.getScriptProperties().setProperty('OUTLET_CATEGORIES', JSON.stringify(categories));
}

// Looks up an outlet's category within a single country's own namespace - the same
// outlet name in a different country is never matched.
function getOutletCategoryFor_(categories, countryCode, outlet) {
  var outletLower = String(outlet || '').trim().toLowerCase();
  var match = categories.filter(function (c) {
    return c.country === countryCode && String(c.outlet || '').trim().toLowerCase() === outletLower;
  })[0];
  return match ? match.category : null;
}

function isAdmin_(email) {
  var target = String(email || '').trim().toLowerCase();
  return getAdmins_().some(function (a) { return String(a || '').trim().toLowerCase() === target; });
}

function getViewerScope_(email) {
  var target = String(email || '').trim().toLowerCase();
  var match = getViewers_().filter(function (v) { return String(v.email || '').trim().toLowerCase() === target; })[0];
  return match ? match.scope : null;
}

function getOutletsForEmail_(email, countryCode) {
  var target = String(email || '').trim().toLowerCase();
  return getMappings_()
    .filter(function (m) { return m.country === countryCode && String(m.email || '').trim().toLowerCase() === target; })
    .map(function (m) { return m.outlet; });
}

// ---- Admin: manage access (Admins + PIC_MAPPINGS), called from the client ----
// Every function here re-checks the caller against the Admins list itself - the "Manage
// Access" button is only ever rendered for admins, but google.script.run functions are
// callable directly from a browser console by anyone signed in, so the server-side check
// is the real boundary.

function requireAdmin_() {
  var email = Session.getActiveUser().getEmail();
  if (!email || !isAdmin_(email)) throw new Error('Not authorized.');
  return email;
}

function isValidEmail_(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim());
}

function listAccess() {
  requireAdmin_();
  return { admins: getAdmins_(), viewers: getViewers_(), mappings: getMappings_(), categories: getOutletCategories_() };
}

function addAdmin(email) {
  requireAdmin_();
  email = String(email || '').trim();
  if (!isValidEmail_(email)) throw new Error('Enter a valid email address.');
  var admins = getAdmins_();
  var target = email.toLowerCase();
  if (admins.some(function (a) { return a.toLowerCase() === target; })) {
    throw new Error(email + ' is already an admin.');
  }
  admins.push(email);
  saveAdmins_(admins);
  return listAccess();
}

function removeAdmin(email) {
  requireAdmin_();
  var target = String(email || '').trim().toLowerCase();
  var admins = getAdmins_();
  var remaining = admins.filter(function (a) { return a.toLowerCase() !== target; });
  if (remaining.length === admins.length) return listAccess();
  if (remaining.length === 0) throw new Error('Cannot remove the last admin.');
  saveAdmins_(remaining);
  return listAccess();
}

function addViewer(email, scope) {
  requireAdmin_();
  email = String(email || '').trim();
  if (!isValidEmail_(email)) throw new Error('Enter a valid email address.');
  if (VALID_SCOPES.indexOf(scope) === -1) throw new Error('Unknown scope.');
  var emailLower = email.toLowerCase();
  // Upsert: re-adding an existing Viewer just changes their scope, rather than erroring -
  // unlike Admins/PICs, "already exists" isn't a mistake worth blocking here.
  var viewers = getViewers_().filter(function (v) { return v.email.toLowerCase() !== emailLower; });
  viewers.push({ email: email, scope: scope });
  saveViewers_(viewers);
  return listAccess();
}

function removeViewer(email) {
  requireAdmin_();
  var emailLower = String(email || '').trim().toLowerCase();
  var viewers = getViewers_().filter(function (v) { return v.email.toLowerCase() !== emailLower; });
  saveViewers_(viewers);
  return listAccess();
}

function addPicMapping(countryCode, email, outlet) {
  requireAdmin_();
  var country = COUNTRIES.filter(function (c) { return c.code === countryCode; })[0];
  if (!country) throw new Error('Unknown country.');
  email = String(email || '').trim();
  outlet = String(outlet || '').trim();
  if (!isValidEmail_(email)) throw new Error('Enter a valid email address.');
  if (!outlet) throw new Error('Choose an outlet.');
  var mappings = getMappings_();
  var emailLower = email.toLowerCase();
  var outletLower = outlet.toLowerCase();
  var exists = mappings.some(function (m) {
    return m.country === countryCode && m.email.toLowerCase() === emailLower && m.outlet.toLowerCase() === outletLower;
  });
  if (exists) throw new Error(email + ' already has access to ' + outlet + '.');
  mappings.push({ country: countryCode, email: email, outlet: outlet });
  saveMappings_(mappings);
  return listAccess();
}

function removePicMapping(countryCode, email, outlet) {
  requireAdmin_();
  var emailLower = String(email || '').trim().toLowerCase();
  var outletLower = String(outlet || '').trim().toLowerCase();
  var mappings = getMappings_().filter(function (m) {
    return !(m.country === countryCode && m.email.toLowerCase() === emailLower && m.outlet.toLowerCase() === outletLower);
  });
  saveMappings_(mappings);
  return listAccess();
}

// Categories an outlet can be tagged with. Excludes 'all' - that's a valid Viewer
// scope (see everything unfiltered) but not a category an outlet can be tagged with.
var VALID_CATEGORIES = VALID_SCOPES.filter(function (s) { return s !== 'all'; });

function addOutletCategory(countryCode, outlet, category) {
  requireAdmin_();
  var country = COUNTRIES.filter(function (c) { return c.code === countryCode; })[0];
  if (!country) throw new Error('Unknown country.');
  outlet = String(outlet || '').trim();
  if (!outlet) throw new Error('Choose an outlet.');
  if (VALID_CATEGORIES.indexOf(category) === -1) throw new Error('Unknown category.');
  var outletLower = outlet.toLowerCase();
  // Upsert: re-tagging an outlet just changes its category, rather than erroring -
  // like Viewer scope, this is a normal correction, not a duplicate mistake.
  var categories = getOutletCategories_().filter(function (c) {
    return !(c.country === countryCode && String(c.outlet || '').trim().toLowerCase() === outletLower);
  });
  categories.push({ country: countryCode, outlet: outlet, category: category });
  saveOutletCategories_(categories);
  return listAccess();
}

function removeOutletCategory(countryCode, outlet) {
  requireAdmin_();
  var outletLower = String(outlet || '').trim().toLowerCase();
  var categories = getOutletCategories_().filter(function (c) {
    return !(c.country === countryCode && String(c.outlet || '').trim().toLowerCase() === outletLower);
  });
  saveOutletCategories_(categories);
  return listAccess();
}

// ---- Page shell: header + country toggle + filter select + empty client-rendered dashboard ----

function renderShell_(countries, email, isAdmin, roleLabel) {
  var clientCountries = countries.map(function (c) {
    var clientRows = c.rows.map(function (r) {
      return {
        outlet: r.outlet,
        name: r.name,
        position: r.position,
        status: r.status,
        dueDate: r.dueDate instanceof Date ? r.dueDate.toISOString() : null,
        lastUpdated: r.lastUpdated instanceof Date ? r.lastUpdated.toISOString() : null
      };
    });
    return { code: c.code, label: c.label, outletsLabel: c.outletsLabel, rows: clientRows, outlets: c.outlets };
  });
  var countriesJson = JSON.stringify(clientCountries).replace(/</g, '\\u003c');

  return '' +
    '<div class="header">' +
      '<div>' +
        '<h1>Onboarding Status</h1>' +
        '<div class="muted" id="headerLabel">' + escapeHtml_(countries[0].outletsLabel) + '</div>' +
      '</div>' +
      '<div style="display:flex;align-items:center;gap:12px;">' +
        (isAdmin ? '<button class="manage-btn" onclick="openAccessPanel()">Manage Access</button>' : '') +
        '<div class="muted">' + escapeHtml_(email) + (roleLabel ? ' · ' + escapeHtml_(roleLabel) : '') + '</div>' +
      '</div>' +
    '</div>' +
    '<div id="filter-bar"></div>' +
    '<div id="dashboard-body"></div>' +
    '<div id="accessModal" class="modal-overlay" style="display:none;"><div class="modal" id="accessModalContent"></div></div>' +
    '<script>' + clientEngine_() +
      '\nvar COUNTRIES=' + countriesJson + ';' +
      '\nvar CURRENT=COUNTRIES[0].code;' +
      '\ninitFilterBar();\nrender("");\n<\/script>';
}

// All dashboard HTML (stat cards, by-outlet, by-status, grouped table) is built
// here, client-side, so the outlet filter re-renders instantly without a reload.
function clientEngine_() {
  return '' +
    'var STATUS_ORDER=["PENDING HR REVIEW","TO GENERATE LOA","LOA PENDING SIGNATURE","TO CREATE STAFFANY ACCOUNT","ONBOARDING COMPLETE","COMPLETE","TO DO","APPROVED FOR LOA"];' +
    'var STATUS_COLORS={"PENDING HR REVIEW":"#8b8f97","TO GENERATE LOA":"#7b68ee","LOA PENDING SIGNATURE":"#4a90d9","TO CREATE STAFFANY ACCOUNT":"#2bb673","ONBOARDING COMPLETE":"#1f9254","COMPLETE":"#1c1c1c","TO DO":"#8b8f97","APPROVED FOR LOA":"#e8a33d"};' +
    'var DEFAULT_COLOR="#8b8f97";' +
    'function esc(v){return String(v==null?"":v).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");}' +
    'function fmtDate(iso){if(!iso)return "";var d=new Date(iso);return d.toLocaleDateString("en-GB",{day:"2-digit",month:"short",year:"numeric"});}' +
    'function mondayOf(d){var date=new Date(d);var day=date.getDay();date.setDate(date.getDate()+(day===0?-6:1-day));date.setHours(0,0,0,0);return date;}' +
    'function statCard(value,label){return "<div class=\\"stat-card\\"><div class=\\"stat-value\\">"+value+"</div><div class=\\"stat-label\\">"+esc(label)+"</div></div>";}' +
    'function buildStatCards(rows){' +
      'var now=new Date();var mThis=mondayOf(now);var mNext=new Date(mThis);mNext.setDate(mThis.getDate()+7);var mAfter=new Date(mThis);mAfter.setDate(mThis.getDate()+14);' +
      'var thisWeek=0,nextWeek=0;' +
      'rows.forEach(function(r){if(!r.dueDate)return;var d=new Date(r.dueDate);if(d>=mThis&&d<mNext)thisWeek++;else if(d>=mNext&&d<mAfter)nextWeek++;});' +
      'return "<div class=\\"stat-row\\">"+statCard(rows.length,"Total onboarding")+statCard(thisWeek,"Joining this week")+statCard(nextWeek,"Joining next week")+"</div>";' +
    '}' +
    'function buildOutletBreakdown(rows,selected){' +
      'if(selected)return "";' +
      'var counts={};var order=[];' +
      'rows.forEach(function(r){if(!r.outlet)return;if(!counts[r.outlet]){counts[r.outlet]=0;order.push(r.outlet);}counts[r.outlet]++;});' +
      'if(order.length<2)return "";' +
      'var chips=order.map(function(o){return "<div class=\\"outlet-chip\\"><span class=\\"outlet-chip-name\\">"+esc(o)+"</span><span class=\\"outlet-chip-count\\">"+counts[o]+"</span></div>";}).join("");' +
      'return "<div class=\\"section\\"><div class=\\"section-title\\">By outlet</div><div class=\\"outlet-chips\\">"+chips+"</div></div>";' +
    '}' +
    'function buildStatusBar(rows){' +
      'var counts={};var total=rows.length;' +
      'STATUS_ORDER.forEach(function(s){counts[s]=0;});' +
      'rows.forEach(function(r){if(counts[r.status]===undefined)counts[r.status]=0;counts[r.status]++;});' +
      'var statuses=STATUS_ORDER.concat(Object.keys(counts).filter(function(s){return STATUS_ORDER.indexOf(s)===-1;}));' +
      'if(total===0)return "";' +
      'var segments=statuses.map(function(s){var n=counts[s]||0;if(n===0)return "";var color=STATUS_COLORS[s]||DEFAULT_COLOR;var pct=(n/total*100).toFixed(2);return "<div class=\\"bar-segment\\" style=\\"width:"+pct+"%;background:"+color+"\\" title=\\""+esc(s)+": "+n+"\\"></div>";}).join("");' +
      'var legend=statuses.map(function(s){var n=counts[s]||0;if(n===0)return "";var color=STATUS_COLORS[s]||DEFAULT_COLOR;return "<div class=\\"legend-item\\"><span class=\\"legend-dot\\" style=\\"background:"+color+"\\"></span>"+esc(s)+" <span class=\\"legend-count\\">"+n+"</span></div>";}).join("");' +
      'return "<div class=\\"section\\"><div class=\\"section-title\\">By status</div><div class=\\"bar\\">"+segments+"</div><div class=\\"legend\\">"+legend+"</div></div>";' +
    '}' +
    'function buildGroupedTable(rows){' +
      'var groups={};var order=[];' +
      'rows.forEach(function(r){if(!groups[r.status]){groups[r.status]=[];order.push(r.status);}groups[r.status].push(r);});' +
      'var statusOrder=STATUS_ORDER.concat(order.filter(function(s){return STATUS_ORDER.indexOf(s)===-1;}));' +
      'var body="";' +
      'statusOrder.forEach(function(status){' +
        'var members=groups[status];if(!members||members.length===0)return;' +
        'var color=STATUS_COLORS[status]||DEFAULT_COLOR;' +
        'body+="<tr class=\\"group-header\\"><td colspan=\\"5\\"><span class=\\"badge\\" style=\\"background:"+color+"\\">"+esc(status)+"</span> <span class=\\"muted\\">"+members.length+"</span></td></tr>";' +
        'members.forEach(function(r){' +
          'body+="<tr><td>"+esc(r.outlet)+"</td><td>"+esc(r.name)+"</td><td>"+esc(r.position)+"</td><td>"+esc(fmtDate(r.dueDate))+"</td><td class=\\"muted\\">"+esc(fmtDate(r.lastUpdated))+"</td></tr>";' +
        '});' +
      '});' +
      'return "<div class=\\"table-wrap\\"><table><thead><tr><th>Outlet</th><th>Employee</th><th>Position</th><th>Expected Join Date</th><th>Last Updated</th></tr></thead><tbody>"+body+"</tbody></table></div>";' +
    '}' +
    'function emptyState(selected){' +
      'var who=selected?("<b>"+esc(selected)+"</b>"):"any outlet";' +
      'return "<div class=\\"section\\" style=\\"text-align:center;padding:32px 18px;\\"><div style=\\"font-size:15px;margin-bottom:4px;\\">Nothing\\u2019s cooking at "+who+" right now.</div><div class=\\"muted\\">No one\\u2019s onboarding there at the moment \\u2014 check back soon.</div></div>";' +
    '}' +
    'function findCountry(code){for(var i=0;i<COUNTRIES.length;i++){if(COUNTRIES[i].code===code)return COUNTRIES[i];}return COUNTRIES[0];}' +
    'function initFilterBar(){renderFilterBar();}' +
    'function renderFilterBar(){' +
      'var c=findCountry(CURRENT);var html="";' +
      'if(COUNTRIES.length>1){' +
        'html+="<div class=\\"country-toggle\\">"+COUNTRIES.map(function(cc){return "<button class=\\"country-btn"+(cc.code===CURRENT?" active":"")+"\\" onclick=\\"selectCountry(\'"+cc.code+"\')\\">"+esc(cc.label)+"</button>";}).join("")+"</div>";' +
      '}' +
      'if(c.outlets.length>1){' +
        'var opts=c.outlets.map(function(o){return "<option value=\\""+esc(o)+"\\">"+esc(o)+"</option>";}).join("");' +
        'html+="<div class=\\"filter-row\\"><label for=\\"outletFilter\\" class=\\"muted\\">Filter by outlet</label><select id=\\"outletFilter\\" onchange=\\"render(this.value)\\"><option value=\\"\\">All outlets</option>"+opts+"</select></div>";' +
      '}' +
      'document.getElementById("filter-bar").innerHTML=html;' +
    '}' +
    'function selectCountry(code){' +
      'CURRENT=code;' +
      'var c=findCountry(CURRENT);' +
      'var lbl=document.getElementById("headerLabel");' +
      'if(lbl)lbl.textContent=c.outletsLabel;' +
      'renderFilterBar();' +
      'render("");' +
    '}' +
    'function render(selected){' +
      'var c=findCountry(CURRENT);' +
      'var rows=selected?c.rows.filter(function(r){return r.outlet===selected;}):c.rows;' +
      'var el=document.getElementById("dashboard-body");' +
      'if(rows.length===0){el.innerHTML=emptyState(selected);return;}' +
      'el.innerHTML=buildStatCards(rows)+buildOutletBreakdown(rows,selected)+buildStatusBar(rows)+buildGroupedTable(rows);' +
    '}' +
    'var LAST_ACCESS_DATA=null;' +
    'var SCOPE_LABELS={all:"All outlets",fnb:"F&B only",salon:"Salon only",others:"Others only",group_management:"Group Management only"};' +
    'var SCOPE_OPTIONS=Object.keys(SCOPE_LABELS).map(function(k){return "<option value=\\""+k+"\\">"+esc(SCOPE_LABELS[k])+"</option>";}).join("");' +
    'var CATEGORY_LABELS={fnb:"F&B",salon:"Salon",others:"Others",group_management:"Group Management"};' +
    'var CATEGORY_OPTIONS=Object.keys(CATEGORY_LABELS).map(function(k){return "<option value=\\""+k+"\\">"+esc(CATEGORY_LABELS[k])+"</option>";}).join("");' +
    'function openAccessPanel(){' +
      'document.getElementById("accessModal").style.display="flex";' +
      'document.getElementById("accessModalContent").innerHTML="<p class=\\"muted\\">Loading\\u2026</p>";' +
      'google.script.run.withSuccessHandler(renderAccessPanel).withFailureHandler(accessPanelError).listAccess();' +
    '}' +
    'function closeAccessPanel(){document.getElementById("accessModal").style.display="none";}' +
    'function accessPanelError(err){' +
      'var msg=err&&err.message?err.message:String(err);' +
      'var box=document.getElementById("accessModalContent");' +
      'if(box)box.innerHTML="<button class=\\"modal-close\\" onclick=\\"closeAccessPanel()\\">&times;</button><h2>Manage Access</h2><div class=\\"access-error\\">"+esc(msg)+"</div>";' +
    '}' +
    'function armConfirm(btn,onConfirm){' +
      'btn.textContent="Click again to confirm";' +
      'btn.className="remove-btn confirming";' +
      'btn.onclick=onConfirm;' +
    '}' +
    'function renderAccessPanel(data){' +
      'LAST_ACCESS_DATA=data;' +
      'var html="<button class=\\"modal-close\\" onclick=\\"closeAccessPanel()\\">&times;</button>";' +
      'html+="<h2>Manage Access</h2><div class=\\"muted\\" style=\\"margin-bottom:8px;\\">Changes apply immediately.</div>";' +
      'html+="<div class=\\"access-error\\" id=\\"topAccessError\\"></div>";' +
      'html+="<div class=\\"access-section\\"><div class=\\"section-title\\">Admins (see every outlet)</div>";' +
      'data.admins.forEach(function(a,i){' +
        'html+="<div class=\\"access-row\\"><span>"+esc(a)+"</span><button class=\\"remove-btn\\" onclick=\\"armConfirm(this,function(){doRemoveAdmin("+i+")})\\">Remove</button></div>";' +
      '});' +
      'html+="<div class=\\"add-form\\"><input type=\\"email\\" id=\\"newAdminEmail\\" placeholder=\\"name@company.com\\"/><button class=\\"add-btn\\" onclick=\\"doAddAdmin()\\">Add admin</button></div>";' +
      'html+="<div class=\\"access-error\\" id=\\"adminError\\"></div>";' +
      'html+="</div>";' +
      'html+="<div class=\\"access-section\\"><div class=\\"section-title\\">Viewers (read-only)</div>";' +
      'data.viewers.forEach(function(v,i){' +
        'html+="<div class=\\"access-row\\"><span>"+esc(v.email)+"</span><span style=\\"display:flex;align-items:center;gap:8px;\\"><span class=\\"muted\\">"+esc(SCOPE_LABELS[v.scope]||v.scope)+"</span><button class=\\"remove-btn\\" onclick=\\"armConfirm(this,function(){doRemoveViewer("+i+")})\\">Remove</button></span></div>";' +
      '});' +
      'if(data.viewers.length===0)html+="<div class=\\"muted\\" style=\\"padding:6px 0;\\">No viewers yet.</div>";' +
      'html+="<div class=\\"add-form\\"><input type=\\"email\\" id=\\"newViewerEmail\\" placeholder=\\"name@company.com\\"/>"+' +
        '"<select id=\\"newViewerScope\\">"+SCOPE_OPTIONS+"</select>"+' +
        '"<button class=\\"add-btn\\" onclick=\\"doAddViewer()\\">Add viewer</button></div>";' +
      'html+="<div class=\\"access-error\\" id=\\"viewerError\\"></div>";' +
      'html+="</div>";' +
      'COUNTRIES.forEach(function(c){' +
        'html+="<div class=\\"access-section\\"><div class=\\"section-title\\">"+esc(c.label)+" PICs</div>";' +
        'var any=false;' +
        'data.mappings.forEach(function(m,idx){' +
          'if(m.country!==c.code)return;' +
          'any=true;' +
          'html+="<div class=\\"access-row\\"><span>"+esc(m.email)+" \\u2192 "+esc(m.outlet)+"</span><button class=\\"remove-btn\\" onclick=\\"armConfirm(this,function(){doRemoveMapping("+idx+")})\\">Remove</button></div>";' +
        '});' +
        'if(!any)html+="<div class=\\"muted\\" style=\\"padding:6px 0;\\">No PICs assigned yet.</div>";' +
        'var opts=(c.outlets||[]).map(function(o){return "<option value=\\""+esc(o)+"\\">"+esc(o)+"</option>";}).join("");' +
        'html+="<div class=\\"add-form\\">"+' +
          '"<input type=\\"email\\" id=\\"newPicEmail_"+c.code+"\\" placeholder=\\"name@company.com\\"/>"+' +
          '"<select id=\\"newPicOutlet_"+c.code+"\\"><option value=\\"\\">Select outlet</option>"+opts+"</select>"+' +
          '"<button class=\\"add-btn\\" onclick=\\"doAddMapping(\'"+c.code+"\')\\">Add PIC</button></div>";' +
        'html+="<div class=\\"access-error\\" id=\\"mappingError_"+c.code+"\\"></div>";' +
        'html+="</div>";' +
      '});' +
      'COUNTRIES.forEach(function(c){' +
        'html+="<div class=\\"access-section\\"><div class=\\"section-title\\">"+esc(c.label)+" outlet categories (for scoped Viewers)</div>";' +
        'var any=false;' +
        'data.categories.forEach(function(cat,idx){' +
          'if(cat.country!==c.code)return;' +
          'any=true;' +
          'html+="<div class=\\"access-row\\"><span>"+esc(cat.outlet)+" \\u2192 "+esc(CATEGORY_LABELS[cat.category]||cat.category)+"</span><button class=\\"remove-btn\\" onclick=\\"armConfirm(this,function(){doRemoveCategory("+idx+")})\\">Remove</button></div>";' +
        '});' +
        'if(!any)html+="<div class=\\"muted\\" style=\\"padding:6px 0;\\">No outlets tagged yet.</div>";' +
        'var catOutletOpts=(c.outlets||[]).map(function(o){return "<option value=\\""+esc(o)+"\\">"+esc(o)+"</option>";}).join("");' +
        'html+="<div class=\\"add-form\\">"+' +
          '"<select id=\\"newCatOutlet_"+c.code+"\\"><option value=\\"\\">Select outlet</option>"+catOutletOpts+"</select>"+' +
          '"<select id=\\"newCatCategory_"+c.code+"\\">"+CATEGORY_OPTIONS+"</select>"+' +
          '"<button class=\\"add-btn\\" onclick=\\"doAddCategory(\'"+c.code+"\')\\">Tag outlet</button></div>";' +
        'html+="<div class=\\"access-error\\" id=\\"categoryError_"+c.code+"\\"></div>";' +
        'html+="</div>";' +
      '});' +
      'document.getElementById("accessModalContent").innerHTML=html;' +
    '}' +
    'function doAddAdmin(){' +
      'var el=document.getElementById("newAdminEmail");' +
      'var email=el.value.trim();' +
      'var errBox=document.getElementById("adminError");' +
      'if(errBox)errBox.textContent="";' +
      'google.script.run.withSuccessHandler(function(data){el.value="";renderAccessPanel(data);}).withFailureHandler(function(err){if(errBox)errBox.textContent=err&&err.message?err.message:String(err);}).addAdmin(email);' +
    '}' +
    'function doRemoveAdmin(i){' +
      'if(!LAST_ACCESS_DATA||!LAST_ACCESS_DATA.admins[i])return;' +
      'var email=LAST_ACCESS_DATA.admins[i];' +
      'var errBox=document.getElementById("topAccessError");' +
      'if(errBox)errBox.textContent="";' +
      'google.script.run.withSuccessHandler(renderAccessPanel).withFailureHandler(function(err){if(errBox)errBox.textContent=err&&err.message?err.message:String(err);}).removeAdmin(email);' +
    '}' +
    'function doAddViewer(){' +
      'var emailEl=document.getElementById("newViewerEmail");' +
      'var scopeEl=document.getElementById("newViewerScope");' +
      'var email=emailEl.value.trim();' +
      'var scope=scopeEl.value;' +
      'var errBox=document.getElementById("viewerError");' +
      'if(errBox)errBox.textContent="";' +
      'google.script.run.withSuccessHandler(function(data){emailEl.value="";renderAccessPanel(data);}).withFailureHandler(function(err){if(errBox)errBox.textContent=err&&err.message?err.message:String(err);}).addViewer(email,scope);' +
    '}' +
    'function doRemoveViewer(i){' +
      'if(!LAST_ACCESS_DATA||!LAST_ACCESS_DATA.viewers[i])return;' +
      'var email=LAST_ACCESS_DATA.viewers[i].email;' +
      'var errBox=document.getElementById("topAccessError");' +
      'if(errBox)errBox.textContent="";' +
      'google.script.run.withSuccessHandler(renderAccessPanel).withFailureHandler(function(err){if(errBox)errBox.textContent=err&&err.message?err.message:String(err);}).removeViewer(email);' +
    '}' +
    'function doAddMapping(countryCode){' +
      'var emailEl=document.getElementById("newPicEmail_"+countryCode);' +
      'var outletEl=document.getElementById("newPicOutlet_"+countryCode);' +
      'var email=emailEl.value.trim();' +
      'var outlet=outletEl.value;' +
      'var errBox=document.getElementById("mappingError_"+countryCode);' +
      'if(errBox)errBox.textContent="";' +
      'if(!outlet){if(errBox)errBox.textContent="Choose an outlet.";return;}' +
      'google.script.run.withSuccessHandler(function(data){emailEl.value="";outletEl.value="";renderAccessPanel(data);}).withFailureHandler(function(err){if(errBox)errBox.textContent=err&&err.message?err.message:String(err);}).addPicMapping(countryCode,email,outlet);' +
    '}' +
    'function doRemoveMapping(idx){' +
      'if(!LAST_ACCESS_DATA||!LAST_ACCESS_DATA.mappings[idx])return;' +
      'var m=LAST_ACCESS_DATA.mappings[idx];' +
      'var errBox=document.getElementById("topAccessError");' +
      'if(errBox)errBox.textContent="";' +
      'google.script.run.withSuccessHandler(renderAccessPanel).withFailureHandler(function(err){if(errBox)errBox.textContent=err&&err.message?err.message:String(err);}).removePicMapping(m.country,m.email,m.outlet);' +
    '}' +
    'function doAddCategory(countryCode){' +
      'var outletEl=document.getElementById("newCatOutlet_"+countryCode);' +
      'var categoryEl=document.getElementById("newCatCategory_"+countryCode);' +
      'var outlet=outletEl.value;' +
      'var category=categoryEl.value;' +
      'var errBox=document.getElementById("categoryError_"+countryCode);' +
      'if(errBox)errBox.textContent="";' +
      'if(!outlet){if(errBox)errBox.textContent="Choose an outlet.";return;}' +
      'google.script.run.withSuccessHandler(function(data){outletEl.value="";renderAccessPanel(data);}).withFailureHandler(function(err){if(errBox)errBox.textContent=err&&err.message?err.message:String(err);}).addOutletCategory(countryCode,outlet,category);' +
    '}' +
    'function doRemoveCategory(idx){' +
      'if(!LAST_ACCESS_DATA||!LAST_ACCESS_DATA.categories[idx])return;' +
      'var cat=LAST_ACCESS_DATA.categories[idx];' +
      'var errBox=document.getElementById("topAccessError");' +
      'if(errBox)errBox.textContent="";' +
      'google.script.run.withSuccessHandler(renderAccessPanel).withFailureHandler(function(err){if(errBox)errBox.textContent=err&&err.message?err.message:String(err);}).removeOutletCategory(cat.country,cat.outlet);' +
    '}';
}

function escapeHtml_(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function HtmlOutput_(title, bodyHtml) {
  var html = '' +
    '<!DOCTYPE html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>' + escapeHtml_(title) + '</title>' +
    '<style>' +
      '*{box-sizing:border-box;}' +
      'body{font-family:Arial,Helvetica,sans-serif;margin:0;padding:24px;background:#f5f6f8;color:#1c1c1c;}' +
      '.header{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:20px;flex-wrap:wrap;gap:8px;}' +
      'h1{font-size:22px;margin:0 0 4px 0;}' +
      '.muted{color:#6b6f76;font-size:13px;}' +

      '.stat-row{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:20px;}' +
      '.stat-card{flex:1;min-width:140px;background:#fff;border-radius:10px;padding:16px 18px;box-shadow:0 1px 3px rgba(0,0,0,0.06);border-top:3px solid #7b68ee;}' +
      '.stat-value{font-size:28px;font-weight:700;line-height:1.1;}' +
      '.stat-label{color:#6b6f76;font-size:12px;margin-top:4px;}' +

      '.section{background:#fff;border-radius:10px;padding:16px 18px;box-shadow:0 1px 3px rgba(0,0,0,0.06);margin-bottom:16px;}' +
      '.section-title{font-size:12px;font-weight:600;color:#6b6f76;text-transform:uppercase;letter-spacing:0.03em;margin-bottom:10px;}' +

      '.outlet-chips{display:flex;flex-wrap:wrap;gap:8px;}' +
      '.outlet-chip{display:flex;align-items:center;gap:6px;background:#f5f6f8;border-radius:8px;padding:6px 10px;font-size:13px;}' +
      '.outlet-chip-count{background:#1c1c1c;color:#fff;border-radius:10px;padding:1px 7px;font-size:11px;font-weight:600;}' +

      '.bar{display:flex;height:12px;border-radius:6px;overflow:hidden;background:#f0f0f2;margin-bottom:12px;}' +
      '.bar-segment{height:100%;}' +
      '.legend{display:flex;flex-wrap:wrap;gap:14px;font-size:12px;color:#444;}' +
      '.legend-item{display:flex;align-items:center;gap:6px;}' +
      '.legend-dot{width:8px;height:8px;border-radius:50%;display:inline-block;}' +
      '.legend-count{color:#6b6f76;}' +

      '.filter-row{display:flex;align-items:center;gap:10px;margin-bottom:16px;}' +
      '#outletFilter{font-size:13px;padding:5px 8px;border-radius:6px;border:1px solid #ddd;background:#fff;color:#1c1c1c;}' +

      '.country-toggle{display:flex;gap:8px;margin-bottom:12px;}' +
      '.country-btn{font-size:13px;padding:6px 16px;border-radius:20px;border:1px solid #ddd;background:#fff;color:#1c1c1c;cursor:pointer;}' +
      '.country-btn.active{background:#1c1c1c;color:#fff;border-color:#1c1c1c;}' +

      '.table-wrap{overflow-x:auto;background:#fff;border-radius:10px;box-shadow:0 1px 3px rgba(0,0,0,0.06);}' +
      'table{width:100%;border-collapse:collapse;}' +
      'th,td{text-align:left;padding:10px 12px;border-bottom:1px solid #eee;font-size:13px;white-space:nowrap;}' +
      'th{background:#fafafa;font-weight:600;color:#444;}' +
      'tr.group-header td{background:#fafbfc;padding:8px 12px;border-bottom:1px solid #eee;}' +
      '.badge{display:inline-block;color:#fff;padding:3px 10px;border-radius:12px;font-size:12px;white-space:nowrap;}' +

      '.manage-btn{font-size:13px;padding:6px 16px;border-radius:20px;border:1px solid #1c1c1c;background:#fff;color:#1c1c1c;cursor:pointer;}' +
      '.modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,0.4);align-items:center;justify-content:center;z-index:1000;}' +
      '.modal{background:#fff;border-radius:12px;padding:24px;max-width:640px;width:92%;max-height:85vh;overflow-y:auto;box-shadow:0 10px 40px rgba(0,0,0,0.2);position:relative;}' +
      '.modal h2{margin:0 0 4px 0;font-size:18px;}' +
      '.modal-close{position:absolute;top:16px;right:16px;cursor:pointer;font-size:20px;line-height:1;color:#6b6f76;background:none;border:none;}' +
      '.access-section{margin-bottom:20px;}' +
      '.access-row{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 0;border-bottom:1px solid #f0f0f2;font-size:13px;}' +
      '.access-row:last-child{border-bottom:none;}' +
      '.remove-btn{color:#c0392b;background:none;border:1px solid #f0d5d0;border-radius:6px;padding:3px 9px;font-size:12px;cursor:pointer;flex-shrink:0;}' +
      '.remove-btn.confirming{background:#c0392b;color:#fff;border-color:#c0392b;}' +
      '.add-form{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;}' +
      '.add-form input,.add-form select{font-size:13px;padding:6px 8px;border-radius:6px;border:1px solid #ddd;}' +
      '.add-form input[type=email]{flex:1;min-width:180px;}' +
      '.add-btn{background:#1c1c1c;color:#fff;border:none;border-radius:6px;padding:6px 14px;font-size:13px;cursor:pointer;flex-shrink:0;}' +
      '.access-error{color:#c0392b;font-size:12px;margin-top:6px;min-height:14px;}' +
    '</style></head><body>' + bodyHtml + '</body></html>';
  return HtmlService.createHtmlOutput(html)
    .setTitle(title)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}
