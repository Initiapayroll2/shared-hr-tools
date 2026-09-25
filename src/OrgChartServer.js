/**
 * Org Chart web app -- server side.
 *
 * v2 (2026-09-16): rebuilt around Chris's explicit spec -- outlet-by-outlet
 * navigation (never one combined view), each outlet a traditional 3-layer
 * chart (Layer 1 Area Manager/GM, Layer 2 Outlet in-charge, Layer 3 ground
 * staff split FOH/BOH/Other), and people addable on ANY layer whether or
 * not they exist in the Mastersheet -- some top management is tracked in a
 * different Mastersheet Chris doesn't have access to, so this tool must be
 * able to hold a person entirely on its own.
 *
 * Two small persisted sheets (auto-created in the same Mastersheet
 * spreadsheet, same convention as v1's "Org Chart Data"):
 *  - CONFIG.ORG_CHART_PEOPLE_SHEET_NAME: one row per PERSON (their own
 *    profile bits the Mastersheet can't supply, or -- for a manually added
 *    person -- their entire profile). Never duplicates a Mastersheet fact
 *    that already exists live there.
 *  - CONFIG.ORG_CHART_PLACEMENTS_SHEET_NAME: one row per (person, outlet)
 *    -- which layer they sit at on that outlet's page. A person CAN sit on
 *    more than one outlet's page (e.g. one Area Manager over several
 *    outlets) -- that's several placement rows for the one person.
 *
 * The Mastersheet itself is still never written to -- it stays the one
 * source of truth for every fact it already holds (name, position, status,
 * entity, location, dates) for anyone who has a row there.
 *
 * v1's "Org Chart Data" sheet (reportsTo + photoFileId, flat multi-outlet
 * view) is superseded by this. That sheet still exists but is no longer
 * read by anything here (removed 2026-09-21, per Chris -- it was the
 * confirmed source of at least one stale wrong-photo bug, and by now
 * everyone's photo has long since been carried over into the People sheet).
 */

var ORG_CHART_PEOPLE_HEADERS = ['Employee ID', 'Source', 'Name', 'Nickname', 'Position', 'Photo File ID', 'Role Tag', 'Company Phone', 'Company Email', 'Updated At', 'Updated By'];
var ORG_CHART_PLACEMENTS_HEADERS = ['Employee ID', 'Outlet', 'Layer', 'Source', 'Updated At', 'Updated By'];
var PLACEMENT_SOURCE_AUTO = 'auto', PLACEMENT_SOURCE_MANUAL = 'manual';
var ORG_CHART_MANUAL_PHOTOS_FOLDER_NAME = 'Org Chart - Manually Added Profiles';
var ROLE_TAG_FOH = 'FOH', ROLE_TAG_BOH = 'BOH';

/**
 * The Mastersheet's LOCATION column is free-typed, so the same real outlet
 * shows up with inconsistent casing across rows (e.g. "INITIA INTERNATIONAL"
 * vs "Initia International", "TOFU G AMY" vs "Tofu G AMY") -- exact string
 * equality on the raw text split these into duplicate outlets. Every place
 * that groups or matches by outlet name must compare via this normalized key
 * instead of the raw string.
 */
function outletKey_(name) {
  return String(name || '').trim().toUpperCase();
}

// Mastersheet EMPLOYEE STATUS values that mean "not real current headcount
// at any outlet" -- Chris asked for all of these to be invisible to the org
// chart (readMastersheetEmployees_ skips them entirely, so they can't be
// seeded, searched, or added anywhere).
var ORG_CHART_EXCLUDED_STATUSES = {
  'PT SUB': true,
  'P/T SUB': true, // confirmed live 2026-09-19: the Mastersheet actually spells this WITH the slash (24 people) -- 'PT SUB' alone never matched, so all 24 were slipping through unexcluded
  'CONVERTED TO PT': true,
  'CONVERTED TO FT': true,
  'TRANSFERRED ENTITY': true,
  'INACTIVE': true,
  'WITHDRAW': true, // withdrew before/during onboarding -- never real current headcount, per Chris 2026-09-19
  'INTERNSHIP ENDED': true, // an old, superseded record, same spirit as Converted to PT/FT -- per Chris 2026-09-19
};

function doGet(e) {
  // Gated at the door, not just at each edit action -- added 2026-09-25 per
  // Chris (PDPA: this holds employee photos and names, so it can no longer
  // be open to "anyone with the link" the way access:"ANYONE" in
  // appsscript.json otherwise allows). Being a Super Admin already implies
  // Viewer-or-better, so isAuthorizedVisitor_ checks both lists.
  if (!isAuthorizedVisitor_()) {
    var tmpl = HtmlService.createTemplateFromFile('AccessRestricted');
    tmpl.email = currentUserEmail_() || '(no email detected)';
    return tmpl.evaluate()
      .setTitle('Access restricted')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1');
  }
  return HtmlService.createHtmlOutputFromFile('OrgChart')
    .setTitle('Org Chart -- Initia Group')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function currentUserEmail_() {
  return String(Session.getActiveUser().getEmail() || '').trim().toLowerCase();
}

/**
 * Access control -- added 2026-09-23. The web app is shared with "Anyone"
 * (not restricted to one Workspace domain, since staff use several email
 * domains) and executes as whoever deployed it for EVERY visitor, so
 * without this check anyone with the link could edit, not just view.
 * Viewing (browsing outlets, seeing photos) stays open to everyone
 * regardless -- this only gates functions that write something.
 */
function isCurrentUserAdmin_() {
  var email = String(currentUserEmail_() || '').trim().toLowerCase();
  if (!email) return false;
  if (CONFIG.ORG_CHART_ADMIN_EMAILS.some(function (a) { return String(a).trim().toLowerCase() === email; })) return true;
  return readManagedAdminEmails_().indexOf(email) !== -1;
}
function requireAdmin_() {
  if (isCurrentUserAdmin_()) return;
  var detected = currentUserEmail_();
  throw new Error('Only admins can make changes to the org chart. Google identified this browser as ' +
    (detected ? detected : 'an account whose email is hidden') +
    '. Sign in with the exact email listed under Manage Access, or ask an admin to add this detected primary email.');
}
/** Read-only -- lets the client know whether to show admin-only controls (Outlet Settings, the temporary cleanup tools, etc.) at all. */
function apiIsCurrentUserAdmin() {
  return isCurrentUserAdmin_();
}

/** Safe account diagnostic for the current visitor; never exposes the admin list. */
function apiGetCurrentAccessStatus() {
  var email = currentUserEmail_();
  return { email: email, emailVisible: !!email, isAdmin: isCurrentUserAdmin_() };
}

// ---------------------------------------------------------------------
// Manage Access -- in-app admin allowlist (2026-09-24, per Chris). The
// PERMANENT list (CONFIG.ORG_CHART_ADMIN_EMAILS) stays hardcoded/deploy-only
// on purpose -- a lockout safety net that can never be emptied from inside
// the app. This sheet is the day-to-day layer on top of it: any existing
// admin (from either list) can add or remove someone here.
// ---------------------------------------------------------------------

function getAdminsSheet_() {
  var ss = SpreadsheetApp.openById(CONFIG.MASTERSHEET_ID);
  var sheet = ss.getSheetByName(CONFIG.ORG_CHART_ADMINS_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.ORG_CHART_ADMINS_SHEET_NAME);
    sheet.getRange(1, 1, 1, 3).setValues([['Email', 'Added At', 'Added By']]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

var ORG_CHART_ADMINS_CACHE_KEY = 'oc_admin_emails';
var ORG_CHART_ADMINS_CACHE_TTL_SECONDS = 300;
var _managedAdminEmails = null;
/** Lowercased, trimmed emails only -- every check/compare elsewhere already normalizes the same way. */
function readManagedAdminEmails_() {
  if (_managedAdminEmails) return _managedAdminEmails;
  var cache = CacheService.getScriptCache();
  var raw = cache.get(ORG_CHART_ADMINS_CACHE_KEY);
  if (raw) {
    try { _managedAdminEmails = JSON.parse(raw); return _managedAdminEmails; } catch (e) { /* fall through to a live read */ }
  }
  var sheet = getAdminsSheet_();
  var lastRow = sheet.getLastRow();
  var emails = [];
  if (lastRow >= 2) {
    sheet.getRange(2, 1, lastRow - 1, 1).getDisplayValues().forEach(function (row) {
      var email = String(row[0] || '').trim().toLowerCase();
      if (email) emails.push(email);
    });
  }
  _managedAdminEmails = emails;
  try { cache.put(ORG_CHART_ADMINS_CACHE_KEY, JSON.stringify(emails), ORG_CHART_ADMINS_CACHE_TTL_SECONDS); } catch (e) { /* fine to skip caching this round */ }
  return emails;
}
function invalidateAdminsCache_() {
  _managedAdminEmails = null;
  try { CacheService.getScriptCache().remove(ORG_CHART_ADMINS_CACHE_KEY); } catch (e) { /* fine, it'll expire on its own TTL */ }
}

/** Admin-only. Returns the permanent (deploy-only) list and the in-app-managed list separately, so the client can show which is which. */
function apiGetAdminList() {
  requireAdmin_();
  return {
    permanent: CONFIG.ORG_CHART_ADMIN_EMAILS.map(function (e) { return String(e).trim().toLowerCase(); }),
    managed: readManagedAdminEmails_(),
    viewers: readViewerEmails_(),
  };
}

function apiAddAdminEmail(email) {
  requireAdmin_();
  var clean = String(email || '').trim().toLowerCase();
  if (!clean || clean.indexOf('@') === -1) throw new Error('That doesn\'t look like a valid email address.');
  var permanent = CONFIG.ORG_CHART_ADMIN_EMAILS.map(function (e) { return String(e).trim().toLowerCase(); });
  if (permanent.indexOf(clean) !== -1) throw new Error('That email already has permanent admin access.');
  var existing = readManagedAdminEmails_();
  if (existing.indexOf(clean) !== -1) throw new Error('That email is already an admin.');
  var sheet = getAdminsSheet_();
  sheet.getRange(sheet.getLastRow() + 1, 1, 1, 3).setValues([[clean, new Date(), currentUserEmail_()]]);
  invalidateAdminsCache_();
  return readManagedAdminEmails_();
}

function apiRemoveAdminEmail(email) {
  requireAdmin_();
  var clean = String(email || '').trim().toLowerCase();
  var sheet = getAdminsSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow >= 2) {
    var values = sheet.getRange(2, 1, lastRow - 1, 1).getDisplayValues();
    for (var i = 0; i < values.length; i++) {
      if (String(values[i][0] || '').trim().toLowerCase() === clean) {
        sheet.deleteRow(i + 2);
        break;
      }
    }
  }
  invalidateAdminsCache_();
  return readManagedAdminEmails_();
}

// ---------------------------------------------------------------------
// Viewer allowlist -- view-only access, added 2026-09-25 per Chris (PDPA:
// employee photos/names are sensitive, so the app can no longer be open to
// anyone with the link). Exact same shape/pattern as the admin allowlist
// above, deliberately a SEPARATE sheet/cache/CRUD set rather than folding
// into it, since being a Viewer and being a Super Admin are different
// permissions checked independently (see isAuthorizedVisitor_ below).
// ---------------------------------------------------------------------

function getViewersSheet_() {
  var ss = SpreadsheetApp.openById(CONFIG.MASTERSHEET_ID);
  var sheet = ss.getSheetByName(CONFIG.ORG_CHART_VIEWERS_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.ORG_CHART_VIEWERS_SHEET_NAME);
    sheet.getRange(1, 1, 1, 3).setValues([['Email', 'Added At', 'Added By']]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

var ORG_CHART_VIEWERS_CACHE_KEY = 'oc_viewer_emails';
var ORG_CHART_VIEWERS_CACHE_TTL_SECONDS = 300;
var _viewerEmails = null;
function readViewerEmails_() {
  if (_viewerEmails) return _viewerEmails;
  var cache = CacheService.getScriptCache();
  var raw = cache.get(ORG_CHART_VIEWERS_CACHE_KEY);
  if (raw) {
    try { _viewerEmails = JSON.parse(raw); return _viewerEmails; } catch (e) { /* fall through to a live read */ }
  }
  var sheet = getViewersSheet_();
  var lastRow = sheet.getLastRow();
  var emails = [];
  if (lastRow >= 2) {
    sheet.getRange(2, 1, lastRow - 1, 1).getDisplayValues().forEach(function (row) {
      var email = String(row[0] || '').trim().toLowerCase();
      if (email) emails.push(email);
    });
  }
  _viewerEmails = emails;
  try { cache.put(ORG_CHART_VIEWERS_CACHE_KEY, JSON.stringify(emails), ORG_CHART_VIEWERS_CACHE_TTL_SECONDS); } catch (e) { /* fine to skip caching this round */ }
  return emails;
}
function invalidateViewersCache_() {
  _viewerEmails = null;
  try { CacheService.getScriptCache().remove(ORG_CHART_VIEWERS_CACHE_KEY); } catch (e) { /* fine, it'll expire on its own TTL */ }
}
function isCurrentUserViewer_() {
  var email = String(currentUserEmail_() || '').trim().toLowerCase();
  if (!email) return false;
  return readViewerEmails_().indexOf(email) !== -1;
}
/** Admin OR Viewer -- gates doGet itself (see doGet below). Being neither means "Access restricted", not just "can't edit". */
function isAuthorizedVisitor_() {
  return isCurrentUserAdmin_() || isCurrentUserViewer_();
}

function apiAddViewerEmail(email) {
  requireAdmin_();
  var clean = String(email || '').trim().toLowerCase();
  if (!clean || clean.indexOf('@') === -1) throw new Error('That doesn\'t look like a valid email address.');
  var existing = readViewerEmails_();
  if (existing.indexOf(clean) !== -1) throw new Error('That email is already a Viewer.');
  var sheet = getViewersSheet_();
  sheet.getRange(sheet.getLastRow() + 1, 1, 1, 3).setValues([[clean, new Date(), currentUserEmail_()]]);
  invalidateViewersCache_();
  return readViewerEmails_();
}

function apiRemoveViewerEmail(email) {
  requireAdmin_();
  var clean = String(email || '').trim().toLowerCase();
  var sheet = getViewersSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow >= 2) {
    var values = sheet.getRange(2, 1, lastRow - 1, 1).getDisplayValues();
    for (var i = 0; i < values.length; i++) {
      if (String(values[i][0] || '').trim().toLowerCase() === clean) {
        sheet.deleteRow(i + 2);
        break;
      }
    }
  }
  invalidateViewersCache_();
  return readViewerEmails_();
}

function newManualId_() {
  return 'MANUAL-' + Utilities.getUuid().slice(0, 8).toUpperCase();
}

// ---------------------------------------------------------------------
// Mastersheet snapshot (cached per-execution -- a full getDisplayValues()
// over ~1600 rows x ~80 columns is slow; reading it twice in one request
// was the whole reason photo actions used to take ~20s in v1).
//
// v2 fix: the org chart only ever needs ~9 of those ~80 columns for the
// roster (name/status/entity/location/department/position/pfile link) --
// reading the full width was pure waste. This reads a small probe window
// (a handful of rows, full width) just to find the header row and every
// needed column's index, then reads the REST of the sheet's data rows only
// out to the rightmost needed column. `headers` itself stays full-width
// (from the probe), so anything that looks up a column index off `headers`
// (e.g. resolvePfileFolderId_, which then does its own live single-cell
// read) is unaffected.
// ---------------------------------------------------------------------

// Columns B, C, D, K, L, M, N, I -- name/status/nickname/entity/location/
// department/position/last-working-day. MASTERSHEET_PFILE_LINK used to be
// in this list too (for an hasPfileLink early-exit before resolving a
// photo folder) but it lives much further right (~column S) and was the
// single biggest thing pushing this read wider than it needed to be --
// dropped in favor of just letting resolvePfileFolderId_'s own live
// single-row check be authoritative (it already safely returns null when
// there's no link, so the pre-check was redundant, not just slow).
var ORG_CHART_NEEDED_MASTERSHEET_HEADERS = [
  MASTERSHEET_EMPLOYEE_ID, MASTERSHEET_EMPLOYEE_STATUS, MASTERSHEET_FULL_NAME, MASTERSHEET_NICK_NAME,
  MASTERSHEET_OFFICIAL_COMPANY, MASTERSHEET_LOCATION, MASTERSHEET_DEPARTMENT, MASTERSHEET_POSITION,
  MASTERSHEET_LAST_WORKING_DAY,
];

// Column I -- confirmed live to read like "23 Sep 2015" (day, 3-letter
// month, year), same convention as the rest of this project (see
// MastersheetMapping.js's formatDateOfBirth_ for the same format elsewhere).
var MASTERSHEET_DATE_MONTHS_ = { JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11 };
function parseMastersheetDisplayDate_(str) {
  var s = String(str || '').trim();
  if (!s || s === '-') return null;
  var m = /^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})$/.exec(s);
  if (!m) return null;
  var month = MASTERSHEET_DATE_MONTHS_[m[2].toUpperCase()];
  if (month === undefined) return null;
  return new Date(Number(m[3]), month, Number(m[1]));
}
/** Whole days between two dates (positive: `to` is after `from`), ignoring time-of-day. */
function daysBetween_(from, to) {
  var msPerDay = 24 * 60 * 60 * 1000;
  var a = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  var b = new Date(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.round((b - a) / msPerDay);
}
// Chris: flag anyone with a last working day within 60 days of today (past
// or future) so their in-charge/HR knows to arrange a replacement; anyone
// whose last working day is MORE than 60 days away either direction is
// either not urgent yet (far future) or long since resolved (far past) --
// drop those from the chart entirely rather than leave stale entries
// lingering (Chris can still remove someone earlier by hand regardless,
// via each card's "Remove from this outlet" action).
var ORG_CHART_LWD_WINDOW_DAYS = 60;

var _mastersheetSnapshot = null;
function getMastersheetSnapshot_() {
  if (_mastersheetSnapshot) return _mastersheetSnapshot;
  var sheet = SpreadsheetApp.openById(CONFIG.MASTERSHEET_ID).getSheetByName(CONFIG.MASTERSHEET_TAB_NAME);
  if (!sheet) throw new Error('Mastersheet tab "' + CONFIG.MASTERSHEET_TAB_NAME + '" was not found.');
  var lastRow = sheet.getLastRow(), lastCol = sheet.getLastColumn();

  // The header row is confirmed live to be within the first few rows (a
  // couple of banner rows above it) -- 10 is a comfortable margin, and this
  // probe is full-width so `headers` always has every real column's index.
  var probeRowCount = Math.min(10, lastRow);
  var probeValues = sheet.getRange(1, 1, probeRowCount, lastCol).getDisplayValues();
  var headerRowNumber = findHeaderRow_(probeValues, MASTERSHEET_HEADER_MARKER);
  var headers = probeValues[headerRowNumber - 1];

  var maxNeededCol = 1;
  ORG_CHART_NEEDED_MASTERSHEET_HEADERS.forEach(function (h) {
    var idx = headers.indexOf(h);
    if (idx !== -1 && idx + 1 > maxNeededCol) maxNeededCol = idx + 1;
  });

  var allValues = probeValues.slice(0, headerRowNumber); // keep the header/banner rows as read (full width)
  var remainingRows = lastRow - headerRowNumber;
  if (remainingRows > 0) {
    var body = sheet.getRange(headerRowNumber + 1, 1, remainingRows, maxNeededCol).getDisplayValues();
    allValues = allValues.concat(body); // narrower from here on -- fine, cell_() only ever asks for columns within maxNeededCol below the header
  }

  _mastersheetSnapshot = { allValues: allValues, headerRowNumber: headerRowNumber, headers: headers };
  return _mastersheetSnapshot;
}

// ---------------------------------------------------------------------
// Cross-request cache for the parsed employee roster (CacheService, shared
// by every viewer, not just this execution). The Mastersheet read is the
// one genuinely slow thing left after the column-narrowing above -- Apps
// Script itself has a real floor on how fast ~1600 rows can be read, no
// matter how narrow. Caching the ALREADY-PARSED employee list (not the raw
// sheet values) sidesteps that for every load within the TTL: a hit skips
// the Sheets read entirely. A single CacheService value is capped at
// 100KB, and the roster easily exceeds that once serialized, so it's
// spread across several chunks plus a small manifest recording how many.
// Short TTL (3 min) so a direct Mastersheet edit (new joiner, a status
// change) shows up on its own soon after, without needing an explicit
// refresh -- "Refresh" in the page also clears this outright for an
// immediate bypass.
// ---------------------------------------------------------------------

var ORG_CHART_EMPLOYEES_CACHE_PREFIX = 'oc_emp_';
var ORG_CHART_EMPLOYEES_CACHE_CHUNK_SIZE = 90000; // stay safely under CacheService's 100KB/value cap
var ORG_CHART_EMPLOYEES_CACHE_TTL_SECONDS = 600; // widened from 180s 2026-09-21 -- most page views are just browsing, not right after an edit, and Refresh already exists to bypass this instantly whenever Chris knows something just changed

function getCachedEmployees_() {
  var cache = CacheService.getScriptCache();
  var manifestRaw = cache.get(ORG_CHART_EMPLOYEES_CACHE_PREFIX + 'manifest');
  if (!manifestRaw) return null;
  var manifest;
  try { manifest = JSON.parse(manifestRaw); } catch (e) { return null; }

  var keys = [];
  for (var i = 0; i < manifest.chunks; i++) keys.push(ORG_CHART_EMPLOYEES_CACHE_PREFIX + i);
  var chunkMap = cache.getAll(keys);
  var parts = [];
  for (var j = 0; j < manifest.chunks; j++) {
    var part = chunkMap[ORG_CHART_EMPLOYEES_CACHE_PREFIX + j];
    if (part === undefined) return null; // a chunk expired/evicted independently -- treat the whole thing as a miss
    parts.push(part);
  }
  try {
    return JSON.parse(parts.join(''));
  } catch (e) {
    return null;
  }
}

function setCachedEmployees_(employees) {
  var json = JSON.stringify(employees);
  var chunks = [];
  for (var i = 0; i < json.length; i += ORG_CHART_EMPLOYEES_CACHE_CHUNK_SIZE) {
    chunks.push(json.slice(i, i + ORG_CHART_EMPLOYEES_CACHE_CHUNK_SIZE));
  }
  var payload = {};
  chunks.forEach(function (chunk, idx) { payload[ORG_CHART_EMPLOYEES_CACHE_PREFIX + idx] = chunk; });
  payload[ORG_CHART_EMPLOYEES_CACHE_PREFIX + 'manifest'] = JSON.stringify({ chunks: chunks.length });
  try {
    CacheService.getScriptCache().putAll(payload, ORG_CHART_EMPLOYEES_CACHE_TTL_SECONDS);
  } catch (e) {
    // Roster too large for the cache this round, or a transient CacheService
    // issue -- not worth failing the request over; just skip caching it.
  }
}

/** Clears the cache outright -- used by the page's "Refresh" action for an immediate bypass instead of waiting out the TTL. */
function clearEmployeesCache_() {
  var cache = CacheService.getScriptCache();
  var manifestRaw = cache.get(ORG_CHART_EMPLOYEES_CACHE_PREFIX + 'manifest');
  var keys = [ORG_CHART_EMPLOYEES_CACHE_PREFIX + 'manifest'];
  if (manifestRaw) {
    try {
      var manifest = JSON.parse(manifestRaw);
      for (var i = 0; i < manifest.chunks; i++) keys.push(ORG_CHART_EMPLOYEES_CACHE_PREFIX + i);
    } catch (e) { /* ignore, still clear the manifest key itself */ }
  }
  cache.removeAll(keys);
}

function apiRefreshData() {
  clearEmployeesCache_();
  _mastersheetEmployeesCache = null;
  _mastersheetSnapshot = null;
  try { CacheService.getScriptCache().remove(ORG_CHART_PHOTO_ROWS_CACHE_KEY); } catch (e) { /* fine if this fails -- it'll just expire on its own TTL */ }
  _mastersheetPhotoRows = null;
  try { CacheService.getScriptCache().remove(ORG_CHART_PFILE_FOLDER_MAP_CACHE_KEY); } catch (e) { /* fine if this fails -- it'll just expire on its own TTL */ }
  _pfileFolderIdMap = null;
  invalidatePlacementsCache_(); // ordinary writes already do this, but Refresh should never leave anything stale either
  invalidatePeopleMapCache_();
  invalidateOutletSettingsCache_();
  invalidateAdminsCache_();
  invalidateViewersCache_();
  return true;
}

/** Every Mastersheet employee row shaped for the org chart. Cached per-execution in memory, and across requests/viewers in CacheService (see above). */
var _mastersheetEmployeesCache = null;
function readMastersheetEmployees_() {
  if (_mastersheetEmployeesCache) return _mastersheetEmployeesCache;

  var cached = getCachedEmployees_();
  if (cached) {
    _mastersheetEmployeesCache = cached;
    return cached;
  }

  var snap = getMastersheetSnapshot_();
  var allValues = snap.allValues, headerRowNumber = snap.headerRowNumber, headers = snap.headers;

  var employees = [];
  for (var i = headerRowNumber; i < allValues.length; i++) {
    var values = allValues[i];
    var row = { headers: headers, values: values };
    var employeeId = cell_(row, MASTERSHEET_EMPLOYEE_ID, 0);
    var fullName = cell_(row, MASTERSHEET_FULL_NAME, 0);
    var statusRaw = cell_(row, MASTERSHEET_EMPLOYEE_STATUS, 0);
    if (!employeeId || !fullName || !statusRaw) continue;
    // Statuses that mean "not a real current headcount at any one outlet"
    // (a reserve/substitute, a stale duplicate row, or a since-changed
    // record kept only for history) -- Chris asked these never appear in
    // the org chart. "(Old)" in the name catches legacy duplicate rows the
    // same way, independent of whatever status they carry.
    if (ORG_CHART_EXCLUDED_STATUSES[statusRaw.trim().toUpperCase()]) continue;
    if (fullName.toUpperCase().indexOf('(OLD)') !== -1) continue;

    var lastWorkingDayRaw = cell_(row, MASTERSHEET_LAST_WORKING_DAY, 0);
    var lwdDate = parseMastersheetDisplayDate_(lastWorkingDayRaw);
    var resigningSoon = false;
    if (lwdDate) {
      var daysAway = Math.abs(daysBetween_(new Date(), lwdDate));
      if (daysAway > ORG_CHART_LWD_WINDOW_DAYS) continue; // long past or far in the future -- not actionable right now
      resigningSoon = true;
    }

    employees.push({
      id: employeeId,
      source: 'mastersheet',
      name: fullName,
      nickname: cell_(row, MASTERSHEET_NICK_NAME, 0),
      entity: cell_(row, MASTERSHEET_OFFICIAL_COMPANY, 0),
      location: cell_(row, MASTERSHEET_LOCATION, 0),
      department: cell_(row, MASTERSHEET_DEPARTMENT, 0),
      position: cell_(row, MASTERSHEET_POSITION, 0),
      // Contains, not exact-equals -- confirmed live 2026-09-19: "P/T RESIGNED"
      // (6 people) doesn't match a plain "RESIGNED" check, so those people
      // showed as fully active with no resigned badge at all.
      status: statusRaw.toUpperCase().indexOf('RESIGNED') !== -1 ? 'resigned' : 'active',
      employmentType: statusRaw,
      rowNumber: i + 1,
      resigningSoon: resigningSoon,
      lastWorkingDay: resigningSoon ? lastWorkingDayRaw : '',
    });
  }
  _mastersheetEmployeesCache = employees;
  setCachedEmployees_(employees);
  return employees;
}

/**
 * O(1) instead of scanning the whole roster (~700 people) per lookup --
 * this is called once per person on every outlet page AND once per
 * Layer-3-auto placement inside reconcileAutoPlacements_ (which runs on
 * every visit to the outlet index), so the old linear scan meant hundreds of
 * thousands of comparisons on every single page load. Built once per
 * execution, alongside the roster array it's indexing.
 */
var _mastersheetEmployeeById = null;
var _mastersheetEmployeeByIdSourceArray = null; // guards against a stale index if the roster was ever rebuilt mid-execution (e.g. apiRefreshData)
function findMastersheetEmployeeById_(employeeId) {
  var employees = readMastersheetEmployees_();
  if (!_mastersheetEmployeeById || _mastersheetEmployeeByIdSourceArray !== employees) {
    var map = {};
    for (var i = 0; i < employees.length; i++) map[employees[i].id] = employees[i];
    _mastersheetEmployeeById = map;
    _mastersheetEmployeeByIdSourceArray = employees;
  }
  return _mastersheetEmployeeById[employeeId] || null;
}

// ---------------------------------------------------------------------
// Org Chart People sheet -- per-person profile additions/overrides
// ---------------------------------------------------------------------

function getPeopleSheet_() {
  var ss = SpreadsheetApp.openById(CONFIG.MASTERSHEET_ID);
  var sheet = ss.getSheetByName(CONFIG.ORG_CHART_PEOPLE_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.ORG_CHART_PEOPLE_SHEET_NAME);
    sheet.getRange(1, 1, 1, ORG_CHART_PEOPLE_HEADERS.length).setValues([ORG_CHART_PEOPLE_HEADERS]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

// Same gap, same fix as readAllPlacements_ (see its comment) -- this had no
// cross-request caching at all, so every apiGetOutletDetail/
// apiGetLeadershipOverview call re-read the whole People sheet live, every
// single time. Confirmed live 2026-09-21 as part of why apiGetOutletDetail
// itself was still taking ~8s for a large outlet even after the roster and
// placements caches were both in place.
var ORG_CHART_PEOPLE_CACHE_PREFIX = 'oc_ppl_';
var ORG_CHART_PEOPLE_CACHE_CHUNK_SIZE = 90000;
var ORG_CHART_PEOPLE_CACHE_TTL_SECONDS = 600;
var _peopleMapCache = null;

function getCachedPeopleMap_() {
  var cache = CacheService.getScriptCache();
  var manifestRaw = cache.get(ORG_CHART_PEOPLE_CACHE_PREFIX + 'manifest');
  if (!manifestRaw) return null;
  var manifest;
  try { manifest = JSON.parse(manifestRaw); } catch (e) { return null; }

  var keys = [];
  for (var i = 0; i < manifest.chunks; i++) keys.push(ORG_CHART_PEOPLE_CACHE_PREFIX + i);
  var chunkMap = cache.getAll(keys);
  var parts = [];
  for (var j = 0; j < manifest.chunks; j++) {
    var part = chunkMap[ORG_CHART_PEOPLE_CACHE_PREFIX + j];
    if (part === undefined) return null;
    parts.push(part);
  }
  try {
    return JSON.parse(parts.join(''));
  } catch (e) {
    return null;
  }
}

function setCachedPeopleMap_(map) {
  var json = JSON.stringify(map);
  var chunks = [];
  for (var i = 0; i < json.length; i += ORG_CHART_PEOPLE_CACHE_CHUNK_SIZE) {
    chunks.push(json.slice(i, i + ORG_CHART_PEOPLE_CACHE_CHUNK_SIZE));
  }
  var payload = {};
  chunks.forEach(function (chunk, idx) { payload[ORG_CHART_PEOPLE_CACHE_PREFIX + idx] = chunk; });
  payload[ORG_CHART_PEOPLE_CACHE_PREFIX + 'manifest'] = JSON.stringify({ chunks: chunks.length });
  try {
    CacheService.getScriptCache().putAll(payload, ORG_CHART_PEOPLE_CACHE_TTL_SECONDS);
  } catch (e) {
    // Too large for the cache this round, or a transient CacheService issue -- not worth failing the request over.
  }
}

/** Called after EVERY write to the People sheet (writePersonRow_, bulk photo writes, apiDeletePerson) so the next read anywhere is never stale. */
function invalidatePeopleMapCache_() {
  _peopleMapCache = null;
  var cache = CacheService.getScriptCache();
  var manifestRaw = cache.get(ORG_CHART_PEOPLE_CACHE_PREFIX + 'manifest');
  var keys = [ORG_CHART_PEOPLE_CACHE_PREFIX + 'manifest'];
  if (manifestRaw) {
    try {
      var manifest = JSON.parse(manifestRaw);
      for (var i = 0; i < manifest.chunks; i++) keys.push(ORG_CHART_PEOPLE_CACHE_PREFIX + i);
    } catch (e) { /* ignore, still clear the manifest key itself */ }
  }
  cache.removeAll(keys);
}

/** {employeeId: {rowNumber, source, name, nickname, position, photoFileId, roleTag}}. */
function readPeopleMap_() {
  if (_peopleMapCache) return _peopleMapCache;
  var cached = getCachedPeopleMap_();
  if (cached) { _peopleMapCache = cached; return cached; }

  var sheet = getPeopleSheet_();
  var lastRow = sheet.getLastRow();
  var map = {};
  if (lastRow < 2) { _peopleMapCache = map; return map; }
  var values = sheet.getRange(2, 1, lastRow - 1, ORG_CHART_PEOPLE_HEADERS.length).getDisplayValues();
  values.forEach(function (row, i) {
    var id = String(row[0] || '').trim();
    if (!id) return;
    map[id] = {
      rowNumber: i + 2,
      source: String(row[1] || '').trim(),
      name: String(row[2] || '').trim(),
      nickname: String(row[3] || '').trim(),
      position: String(row[4] || '').trim(),
      photoFileId: String(row[5] || '').trim(),
      roleTag: String(row[6] || '').trim(),
      companyPhone: String(row[7] || '').trim(),
      companyEmail: String(row[8] || '').trim(),
    };
  });
  _peopleMapCache = map;
  setCachedPeopleMap_(map);
  return map;
}

function writePersonRow_(employeeId, patch) {
  var sheet = getPeopleSheet_();
  var map = readPeopleMap_();
  var existing = map[employeeId];
  var now = new Date(), user = currentUserEmail_();
  var merged = {
    source: patch.source !== undefined ? patch.source : (existing ? existing.source : 'mastersheet'),
    name: patch.name !== undefined ? patch.name : (existing ? existing.name : ''),
    nickname: patch.nickname !== undefined ? patch.nickname : (existing ? existing.nickname : ''),
    position: patch.position !== undefined ? patch.position : (existing ? existing.position : ''),
    photoFileId: patch.photoFileId !== undefined ? patch.photoFileId : (existing ? existing.photoFileId : ''),
    roleTag: patch.roleTag !== undefined ? patch.roleTag : (existing ? existing.roleTag : ''),
    companyPhone: patch.companyPhone !== undefined ? patch.companyPhone : (existing ? existing.companyPhone : ''),
    companyEmail: patch.companyEmail !== undefined ? patch.companyEmail : (existing ? existing.companyEmail : ''),
  };
  var row = [employeeId, merged.source, merged.name, merged.nickname, merged.position, merged.photoFileId, merged.roleTag, merged.companyPhone, merged.companyEmail, now, user];
  if (existing) {
    sheet.getRange(existing.rowNumber, 1, 1, row.length).setValues([row]);
  } else {
    sheet.appendRow(row);
  }
  invalidatePeopleMapCache_();
  return merged;
}

/** Sets an employee's company (work) phone/email -- the Mastersheet has no such column, so this lives entirely in the People sheet, for anyone whether Mastersheet-sourced or manual. */
function apiSetCompanyContact(employeeId, phone, email) {
  requireAdmin_();
  writePersonRow_(employeeId, { companyPhone: String(phone || '').trim(), companyEmail: String(email || '').trim() });
  return true;
}

/**
 * Chris's employee photos live in the Mastersheet's own "EMPLOYEE"S PHOTO"
 * column (CB) via Sheets' "Insert image in cell" feature -- a genuine cell
 * VALUE (a CellImage object from Range#getValue()/getValues()), invisible to
 * the plain Sheets REST values.get API (confirmed live 2026-09-17; a
 * floating "image over cells" object would show up via Sheet#getImages(),
 * but confirmed zero of those exist on this sheet).
 *
 * Scanning the whole ~700-row column to see WHICH rows have a photo is the
 * one genuinely slow part of this feature, so that row list (small, plain
 * numbers, easy to cache) is cached across requests via CacheService, same
 * TTL idea as getCachedEmployees_() above. The actual image bytes are never
 * cached here -- only fetched, one cell at a time, for someone actually
 * being migrated (see migratePhotoFromMastersheetColumn_), which happens
 * once per person, ever.
 */
var ORG_CHART_PHOTO_ROWS_CACHE_KEY = 'oc_photo_rows';
var ORG_CHART_PHOTO_ROWS_CACHE_TTL_SECONDS = 900; // widened from 300s 2026-09-21, same reasoning as the roster cache -- photos in the Mastersheet column change even less often
var _mastersheetPhotoRows = null;
function getMastersheetPhotoRows_() {
  if (_mastersheetPhotoRows) return _mastersheetPhotoRows;
  var cache = CacheService.getScriptCache();
  var rows = null;
  var raw = cache.get(ORG_CHART_PHOTO_ROWS_CACHE_KEY);
  if (raw) {
    try { rows = JSON.parse(raw); } catch (e) { rows = null; }
  }
  if (!rows) {
    rows = [];
    try {
      var photoCol = getMastersheetSnapshot_().headers.indexOf(MASTERSHEET_EMPLOYEE_PHOTO_HEADER) + 1; // 1-indexed; 0 (not found) safely yields no rows
      if (photoCol > 0) {
        var sheet = SpreadsheetApp.openById(CONFIG.MASTERSHEET_ID).getSheetByName(CONFIG.MASTERSHEET_TAB_NAME);
        var lastRow = sheet.getLastRow();
        if (lastRow > 0) {
          var colValues = sheet.getRange(1, photoCol, lastRow, 1).getValues();
          for (var r = 0; r < colValues.length; r++) {
            if (colValues[r][0] && typeof colValues[r][0].getContentUrl === 'function') rows.push(r + 1);
          }
        }
      }
      try { cache.put(ORG_CHART_PHOTO_ROWS_CACHE_KEY, JSON.stringify(rows), ORG_CHART_PHOTO_ROWS_CACHE_TTL_SECONDS); } catch (e) { /* fine to skip caching this round */ }
    } catch (e) {
      // Never let a photo-column read break the page -- behave as if no Mastersheet photos exist this execution.
      console.error('getMastersheetPhotoRows_ failed: ' + ((e && e.message) || e));
    }
  }
  var set = {};
  rows.forEach(function (r) { set[r] = true; });
  _mastersheetPhotoRows = set;
  return set;
}

/**
 * The full (rowNumber -> P-file folder id) map for every Mastersheet row
 * with a resolvable P-file folder link -- ONE bulk getRichTextValues() read
 * of the whole P-file-link column, cached across requests via CacheService
 * (900s TTL, cleared by apiRefreshData). Backs THREE previously-separate
 * live reads of this same column: getMastersheetPfileRows_ (yes/no per row,
 * for hasPhoto), bulkResolvePfileFolderIds_ (the actual folder id, for the
 * P-file-photo-priority feature) and resolvePfileFolderId_ (single-row
 * version, for the lightbox). Confirmed live 2026-09-21: before this
 * consolidation, a single apiGetPhotoDataUrls call could trigger this exact
 * getRichTextValues() scan (4.5-8.7s each) more than once, and it was never
 * cached at all for the folder-id use case -- only the boolean version was.
 */
var ORG_CHART_PFILE_FOLDER_MAP_CACHE_KEY = 'oc_pfile_folderids';
var ORG_CHART_PFILE_FOLDER_MAP_CACHE_TTL_SECONDS = 900;
var _pfileFolderIdMap = null;
function getPfileFolderIdMap_() {
  if (_pfileFolderIdMap) return _pfileFolderIdMap;
  var cache = CacheService.getScriptCache();
  var map = null;
  var raw = cache.get(ORG_CHART_PFILE_FOLDER_MAP_CACHE_KEY);
  if (raw) {
    try { map = JSON.parse(raw); } catch (e) { map = null; }
  }
  if (!map) {
    map = {};
    try {
      var headers = getMastersheetSnapshot_().headers;
      var pfileCol = headers.indexOf(MASTERSHEET_PFILE_LINK);
      if (pfileCol !== -1) {
        var sheet = SpreadsheetApp.openById(CONFIG.MASTERSHEET_ID).getSheetByName(CONFIG.MASTERSHEET_TAB_NAME);
        var lastRow = sheet.getLastRow();
        if (lastRow > 0) {
          var richValues = sheet.getRange(1, pfileCol + 1, lastRow, 1).getRichTextValues();
          for (var r = 0; r < richValues.length; r++) {
            var rt = richValues[r][0];
            var url = rt ? rt.getLinkUrl() : null;
            if (!url) continue;
            var extracted = extractDriveId_(url);
            if (extracted && extracted.isFolder) map[r + 1] = extracted.id;
          }
        }
      }
      try { cache.put(ORG_CHART_PFILE_FOLDER_MAP_CACHE_KEY, JSON.stringify(map), ORG_CHART_PFILE_FOLDER_MAP_CACHE_TTL_SECONDS); } catch (e) { /* fine to skip caching this round */ }
    } catch (e) {
      console.error('getPfileFolderIdMap_ failed: ' + ((e && e.message) || e));
    }
  }
  _pfileFolderIdMap = map;
  return map;
}

/**
 * Which Mastersheet rows have a RESOLVABLE P-file folder link -- so
 * hasPhoto can be true (triggering the lazy fetch) for someone whose only
 * photo source is a file already sitting in their P-file, not just for
 * someone with a Mastersheet CB photo. This does NOT confirm a photo
 * actually exists there (that's still checked lazily, per person, when the
 * batch fetch actually runs), only that there's a real folder link worth
 * checking. Derived from getPfileFolderIdMap_ -- no separate read of its own.
 */
function getMastersheetPfileRows_() {
  var map = getPfileFolderIdMap_();
  var set = {};
  Object.keys(map).forEach(function (r) { set[r] = true; });
  return set;
}

/**
 * First-time-only carry-over of a Mastersheet CB photo into Drive (same
 * P-file-photo-subfolder convention as a manual upload), recorded in the
 * People sheet so every later load skips straight to the fast path. Once
 * ANYTHING (this, a legacy photo, or a manual upload) has set photoFileId,
 * this never runs again for that person -- a manual "Upload Photo" always
 * stays the last word, exactly like every other auto-vs-manual field here.
 */
/**
 * Finds a photo already uploaded FOR THIS SPECIFIC PERSON in a folder --
 * unlike findExistingPhotoFileId_ (which just returns whatever "Org Chart
 * Photo"-named file was modified most recently in the folder, fine for a
 * P-file's own personal subfolder since that only ever holds one person's
 * files, but WRONG for the shared manual-photos folder, which holds many
 * different people's photos together). Matches on an employeeId marker
 * embedded in the filename (see migratePhotoFromMastersheetColumn_) so two
 * different people's photos landing in the same shared folder can never be
 * confused for each other -- confirmed happening live, 2026-09-18 (adding
 * one manual person's photo silently overwrote several unrelated people's
 * photoFileId, because both had no P-file and fell back to the same shared
 * folder).
 */
function findExistingMastersheetPhotoFileId_(folderId, employeeId) {
  var marker = escapeDriveQueryValue_('[' + employeeId + ']');
  var result = Drive.Files.list({
    q: "'" + folderId + "' in parents and trashed = false and name contains '" + marker + "'",
    fields: 'files(id,name,modifiedTime)', pageSize: 5, orderBy: 'modifiedTime desc',
  });
  var files = result.files || [];
  return files.length ? files[0].id : null;
}

/**
 * Bulk version of findExistingMastersheetPhotoFileId_ -- items:
 * [{folderId, employeeId}]. Returns {employeeId: fileId} for whoever
 * already has a marker-matching file, batched via UrlFetchApp.fetchAll()
 * instead of one Drive.Files.list() per person.
 */
function bulkFindExistingMastersheetPhotoFileIds_(items) {
  var result = {};
  if (!items.length) return result;
  var token = ScriptApp.getOAuthToken();
  var requests = items.map(function (it) {
    var marker = escapeDriveQueryValue_('[' + it.employeeId + ']');
    var q = "'" + it.folderId + "' in parents and trashed = false and name contains '" + marker + "'";
    return {
      url: 'https://www.googleapis.com/drive/v3/files?q=' + encodeURIComponent(q) + '&fields=' + encodeURIComponent('files(id,modifiedTime)') + '&orderBy=' + encodeURIComponent('modifiedTime desc') + '&pageSize=5',
      headers: { Authorization: 'Bearer ' + token },
      muteHttpExceptions: true,
    };
  });
  var responses;
  try { responses = UrlFetchApp.fetchAll(requests); } catch (e) { responses = null; }
  items.forEach(function (it, i) {
    var resp = responses && responses[i];
    if (!resp || resp.getResponseCode() !== 200) return;
    try {
      var files = JSON.parse(resp.getContentText()).files || [];
      if (files.length) result[it.employeeId] = files[0].id;
    } catch (e) { /* skip -- treat as no existing copy found */ }
  });
  return result;
}

function migratePhotoFromMastersheetColumn_(employeeId, rowNumber, name) {
  if (!getMastersheetPhotoRows_()[rowNumber]) return '';

  var pfileFolderId = resolvePfileFolderId_(rowNumber);
  var destFolderId = pfileFolderId ? findOrCreatePhotoSubfolder_(pfileFolderId, true) : null;
  if (!destFolderId) destFolderId = getOrCreateManualPhotosFolderId_();

  // Someone appearing on more than one page (an Area Manager on several
  // outlets, or on both an outlet AND a leadership overview) can trigger
  // this from two overlapping requests before either has written back to
  // the People sheet -- this "does a copy already exist" check stops that
  // race from creating duplicate files in the P-file folder (confirmed
  // happening live, 2026-09-18, before this fix). This USED to also take a
  // LockService.getScriptLock() here, but that's a single SCRIPT-WIDE lock,
  // not scoped per employee -- any two concurrent migrations for two
  // DIFFERENT, unrelated people were serializing against each other too,
  // and the code never even checked whether tryLock succeeded, so it was
  // only ever a wait, not a real mutex. Confirmed live 2026-09-21: this was
  // producing 13-25 SECOND photo loads (vs. ~3s normal) whenever a few
  // people's photos needed migrating at once. Removed -- the existing-file
  // check below is enough protection for the rare, low-stakes case of a
  // true same-person race (worst case, one extra duplicate file, same fix
  // as any other duplicate); it's not worth multi-second stalls for
  // everyone to prevent that.
  var existingFileId = findExistingMastersheetPhotoFileId_(destFolderId, employeeId);
  if (existingFileId) {
    writePersonRow_(employeeId, { source: 'mastersheet', photoFileId: existingFileId });
    return existingFileId;
  }

  var photoCol = getMastersheetSnapshot_().headers.indexOf(MASTERSHEET_EMPLOYEE_PHOTO_HEADER) + 1;
  if (photoCol <= 0) return '';
  var sheet = SpreadsheetApp.openById(CONFIG.MASTERSHEET_ID).getSheetByName(CONFIG.MASTERSHEET_TAB_NAME);
  var value = sheet.getRange(rowNumber, photoCol).getValue();
  if (!value || typeof value.getContentUrl !== 'function') return ''; // the cached row list said yes, but this specific cell has since changed -- treat as no photo rather than erroring
  var url = value.getContentUrl() || value.getUrl();
  if (!url) return ''; // no fetchable content URL -- nothing to carry over
  var blob = UrlFetchApp.fetch(url).getBlob();
  var created = driveUploadBytes_(destFolderId, (name || employeeId) + ' - Org Chart Photo (from Mastersheet) [' + employeeId + ']', blob);
  writePersonRow_(employeeId, { source: 'mastersheet', photoFileId: created.id });
  return created.id;
}

// ---------------------------------------------------------------------
// Org Chart Placements sheet -- which outlet + layer a person sits at
// ---------------------------------------------------------------------

function getPlacementsSheet_() {
  var ss = SpreadsheetApp.openById(CONFIG.MASTERSHEET_ID);
  var sheet = ss.getSheetByName(CONFIG.ORG_CHART_PLACEMENTS_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.ORG_CHART_PLACEMENTS_SHEET_NAME);
    sheet.getRange(1, 1, 1, ORG_CHART_PLACEMENTS_HEADERS.length).setValues([ORG_CHART_PLACEMENTS_HEADERS]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/**
 * Every placement row -- {employeeId, outlet, layer, source, rowNumber}[].
 * `source` is 'auto' (bulk-seeded, or last relocated by
 * reconcileAutoPlacements_ following a Mastersheet LOCATION change) or
 * 'manual' (Chris explicitly added, moved, or promoted this person --
 * never auto-relocated again). A row written before this column existed
 * reads as '' here; treated as 'auto' only when it's actually a Layer 3
 * row (matches what bulk-seeding always wrote), 'manual' otherwise, since
 * Layer 1/2 was always a deliberate placement even before this column.
 */
// Confirmed live 2026-09-21: this used to be an in-memory-only cache, which
// only ever helped WITHIN one execution -- every separate page load is its
// own fresh execution, so apiGetOutletList/apiGetOutletDetail/
// apiGetLeadershipOverview were re-reading the ENTIRE Placements sheet live
// from Sheets every single time, unlike the roster and photo-row list
// (which both got real cross-request CacheService caching earlier). This
// was the dominant remaining cost -- a steady ~2.5-3s per outlet-list load
// even with a warm roster cache. Same chunked-cache pattern as
// getCachedEmployees_/setCachedEmployees_ above.
var ORG_CHART_PLACEMENTS_CACHE_PREFIX = 'oc_plc_';
var ORG_CHART_PLACEMENTS_CACHE_CHUNK_SIZE = 90000;
var ORG_CHART_PLACEMENTS_CACHE_TTL_SECONDS = 600;

function getCachedPlacements_() {
  var cache = CacheService.getScriptCache();
  var manifestRaw = cache.get(ORG_CHART_PLACEMENTS_CACHE_PREFIX + 'manifest');
  if (!manifestRaw) return null;
  var manifest;
  try { manifest = JSON.parse(manifestRaw); } catch (e) { return null; }

  var keys = [];
  for (var i = 0; i < manifest.chunks; i++) keys.push(ORG_CHART_PLACEMENTS_CACHE_PREFIX + i);
  var chunkMap = cache.getAll(keys);
  var parts = [];
  for (var j = 0; j < manifest.chunks; j++) {
    var part = chunkMap[ORG_CHART_PLACEMENTS_CACHE_PREFIX + j];
    if (part === undefined) return null; // a chunk expired/evicted independently -- treat the whole thing as a miss
    parts.push(part);
  }
  try {
    return JSON.parse(parts.join(''));
  } catch (e) {
    return null;
  }
}

function setCachedPlacements_(placements) {
  var json = JSON.stringify(placements);
  var chunks = [];
  for (var i = 0; i < json.length; i += ORG_CHART_PLACEMENTS_CACHE_CHUNK_SIZE) {
    chunks.push(json.slice(i, i + ORG_CHART_PLACEMENTS_CACHE_CHUNK_SIZE));
  }
  var payload = {};
  chunks.forEach(function (chunk, idx) { payload[ORG_CHART_PLACEMENTS_CACHE_PREFIX + idx] = chunk; });
  payload[ORG_CHART_PLACEMENTS_CACHE_PREFIX + 'manifest'] = JSON.stringify({ chunks: chunks.length });
  try {
    CacheService.getScriptCache().putAll(payload, ORG_CHART_PLACEMENTS_CACHE_TTL_SECONDS);
  } catch (e) {
    // Too large for the cache this round, or a transient CacheService issue -- not worth failing the request over; just skip caching it.
  }
}

function clearPlacementsCache_() {
  var cache = CacheService.getScriptCache();
  var manifestRaw = cache.get(ORG_CHART_PLACEMENTS_CACHE_PREFIX + 'manifest');
  var keys = [ORG_CHART_PLACEMENTS_CACHE_PREFIX + 'manifest'];
  if (manifestRaw) {
    try {
      var manifest = JSON.parse(manifestRaw);
      for (var i = 0; i < manifest.chunks; i++) keys.push(ORG_CHART_PLACEMENTS_CACHE_PREFIX + i);
    } catch (e) { /* ignore, still clear the manifest key itself */ }
  }
  cache.removeAll(keys);
}

var _placementsCache = null;
/** Called after EVERY write (add/move/remove/role-tag/delete) so the next read anywhere is never stale -- TTL length above barely matters for correctness, it's just a safety net. */
function invalidatePlacementsCache_() {
  _placementsCache = null;
  clearPlacementsCache_();
}

function readAllPlacements_() {
  if (_placementsCache) return _placementsCache;
  var cached = getCachedPlacements_();
  if (cached) { _placementsCache = cached; return cached; }

  var sheet = getPlacementsSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) { _placementsCache = []; return _placementsCache; }
  var values = sheet.getRange(2, 1, lastRow - 1, ORG_CHART_PLACEMENTS_HEADERS.length).getDisplayValues();
  var out = [];
  values.forEach(function (row, i) {
    var employeeId = String(row[0] || '').trim();
    if (!employeeId) return;
    var layer = Number(row[2]) || 3;
    // Validate against the two known values, not just "is it non-empty" --
    // confirmed live 2026-09-23: rows written before the Source column
    // existed (pre-@10, 2026-09-19) have LEFTOVER data in this column
    // position from the sheet's old 5-column layout (what used to be
    // "Updated At", a raw timestamp) -- non-empty, so the old `if (!source)`
    // check never caught it, silently skipping the documented migration
    // policy ("default to auto for Layer 3, manual otherwise") for exactly
    // the rows it was meant to cover. A garbled Source also means
    // reconcileAutoPlacements_ can never match `p.source === PLACEMENT_SOURCE_AUTO`
    // for these rows, so they silently stop following a person's Mastersheet
    // location changes forever (confirmed: Yun Seongjun, Jung Ye Sun's
    // placements stuck at "Initia Management" despite their LOCATION long
    // since changed to Initia International / RE:CODE respectively).
    var source = String(row[3] || '').trim();
    if (source !== PLACEMENT_SOURCE_AUTO && source !== PLACEMENT_SOURCE_MANUAL) {
      source = layer === 3 ? PLACEMENT_SOURCE_AUTO : PLACEMENT_SOURCE_MANUAL;
    }
    out.push({ employeeId: employeeId, outlet: String(row[1] || '').trim(), layer: layer, source: source, rowNumber: i + 2 });
  });
  _placementsCache = out;
  setCachedPlacements_(out);
  return out;
}

function upsertPlacement_(employeeId, outlet, layer, source) {
  var sheet = getPlacementsSheet_();
  var all = readAllPlacements_();
  var now = new Date(), user = currentUserEmail_();
  var existing = null;
  for (var i = 0; i < all.length; i++) {
    if (all[i].employeeId === employeeId && outletKey_(all[i].outlet) === outletKey_(outlet)) { existing = all[i]; break; }
  }
  var row = [employeeId, outlet, layer, source || PLACEMENT_SOURCE_MANUAL, now, user];
  if (existing) {
    sheet.getRange(existing.rowNumber, 1, 1, row.length).setValues([row]);
  } else {
    sheet.appendRow(row);
  }
  invalidatePlacementsCache_();
}

/**
 * Follows a person to their current outlet when it's changed underneath
 * them -- but ONLY for 'auto' Layer 3 placements (bulk-seeded ground team,
 * never manually touched). Anything Chris explicitly added, moved, or
 * promoted -- Layer 1/2 always, or a Layer 3 person he's deliberately
 * placed -- is 'manual' and never auto-relocated, no matter what the
 * Mastersheet says.
 *
 * ALSO seeds active employees who have NO placement anywhere yet -- e.g. a
 * new hire added to the Mastersheet after their outlet's one-time
 * first-visit auto-seed already ran (apiGetOutletDetail only seeds an
 * outlet the FIRST time it's opened, via `if (!placements.length)` --
 * once any placement exists there, a later new joiner is never picked up
 * by anything). Confirmed live 2026-09-23 (Nur Aishah Binte Sazali,
 * SGFT1055, joined "Initia Management" -- which already had placements
 * from before -- and was never auto-seeded at all). Placed the same way
 * the original first-visit seed would have: Layer 3, source 'auto'.
 *
 * Rewrites the whole sheet body in one bulk write only when an existing
 * row's outlet actually changed; new-hire rows are a separate append (no
 * need to touch the rest of the sheet just to add a few rows) -- both are
 * skipped entirely when neither applies (cheap no-op).
 */
// TEMPORARY (2026-09-21): now returns {changed, readMs, scanMs, writeMs} instead of a plain boolean, for the same diagnostic pass as apiGetOutletList's _timing -- revert to a plain boolean return once the bottleneck is found (both call sites already ignore the return value, so this is safe either way).
function reconcileAutoPlacements_() {
  var tRead0 = Date.now();
  var all = readAllPlacements_();
  var readMs = Date.now() - tRead0;

  var tScan0 = Date.now();
  var changed = false;
  // Keyed by employeeId -> { outletKey: true, ... } -- every outlet a
  // person already has SOME placement at (their own outlet, a leadership
  // page, another outlet Chris placed them at by hand, ...). Deliberately
  // NOT just "has any placement at all": confirmed live 2026-09-24 (Ethan
  // James Tan) -- someone manually added to the Singapore F&B Leadership
  // page's "People Managers" list (a real, separate placement) had NO
  // placement at their own actual outlet (Modu AMY per the Mastersheet),
  // and the old "does this employeeId have ANY placement anywhere" check
  // treated the leadership placement as covering them, so they were never
  // auto-seeded onto their own outlet's page at all. A person can and
  // often does legitimately hold several placements at once (that's the
  // whole point of the multi-placement model) -- this only needs to make
  // sure their OWN current outlet is one of them, additively, never
  // touching whatever else they're already placed on.
  var placedOutletKeys = {};
  var relocated = []; // {name, from, to} -- for the visible sync summary, see buildSyncSummary_
  var rebuilt = all.map(function (p) {
    var outlet = p.outlet;
    if (p.layer === 3 && p.source === PLACEMENT_SOURCE_AUTO) {
      var ms = findMastersheetEmployeeById_(p.employeeId);
      if (ms && ms.location && outletKey_(ms.location) !== outletKey_(p.outlet)) {
        changed = true;
        relocated.push({ name: ms.name, from: p.outlet, to: ms.location });
        outlet = ms.location;
      }
    }
    (placedOutletKeys[p.employeeId] || (placedOutletKeys[p.employeeId] = {}))[outletKey_(outlet)] = true;
    return { employeeId: p.employeeId, outlet: outlet, layer: p.layer, source: p.source };
  });

  var newHires = [];
  readMastersheetEmployees_().forEach(function (e) {
    if (!e.location) return;
    var key = outletKey_(e.location);
    if (placedOutletKeys[e.id] && placedOutletKeys[e.id][key]) return; // already placed at their own current outlet somewhere
    newHires.push({ employeeId: e.id, outlet: e.location, layer: 3, source: PLACEMENT_SOURCE_AUTO, name: e.name });
  });
  var scanMs = Date.now() - tScan0;

  if (!changed && !newHires.length) return { changed: false, readMs: readMs, scanMs: scanMs, writeMs: 0, newHires: 0, newHireNames: [], relocated: [] };

  var tWrite0 = Date.now();
  var sheet = getPlacementsSheet_();
  var now = new Date(), user = 'auto-sync';
  if (changed) {
    var rewrittenRows = rebuilt.map(function (p) { return [p.employeeId, p.outlet, p.layer, p.source, now, user]; });
    sheet.getRange(2, 1, all.length, ORG_CHART_PLACEMENTS_HEADERS.length).clearContent();
    sheet.getRange(2, 1, rewrittenRows.length, ORG_CHART_PLACEMENTS_HEADERS.length).setValues(rewrittenRows);
  }
  var newHireNames = [];
  if (newHires.length) {
    // Re-check against a FRESH live read, right before writing -- confirmed
    // live 2026-09-24 (Park Eunhee, two identical rows at RE:CODE):
    // apiGetOutletList and apiGetOutletDetail both call this on every load
    // with no lock between them (removed at @37 for a different function,
    // same reasoning applies -- a script-wide lock stalls every concurrent
    // viewer to prevent a rare, harmless-ish duplicate), so two overlapping
    // requests can both read "not yet placed" before either has written and
    // both append the same new-hire row. This doesn't close the window
    // entirely (that would need the lock this codebase deliberately avoids)
    // but shrinks it from "the whole request" to "the gap between this read
    // and the write a few lines down", the same trade-off @37 made.
    var freshLastRow = sheet.getLastRow();
    var freshCoverage = {};
    if (freshLastRow >= 2) {
      sheet.getRange(2, 1, freshLastRow - 1, 2).getDisplayValues().forEach(function (row) {
        var id = String(row[0] || '').trim();
        if (!id) return;
        (freshCoverage[id] || (freshCoverage[id] = {}))[outletKey_(row[1])] = true;
      });
    }
    newHires = newHires.filter(function (p) {
      return !(freshCoverage[p.employeeId] && freshCoverage[p.employeeId][outletKey_(p.outlet)]);
    });
  }
  if (newHires.length) {
    var newRows = newHires.map(function (p) {
      newHireNames.push(p.name + ' (' + p.outlet + ')');
      return [p.employeeId, p.outlet, p.layer, p.source, now, user];
    });
    sheet.getRange(sheet.getLastRow() + 1, 1, newRows.length, ORG_CHART_PLACEMENTS_HEADERS.length).setValues(newRows);
  }
  invalidatePlacementsCache_();
  return {
    changed: true, readMs: readMs, scanMs: scanMs, writeMs: Date.now() - tWrite0,
    newHires: newHires.length, newHireNames: newHireNames, relocated: relocated,
  };
}

/**
 * Turns a reconcileAutoPlacements_() result into short, human-readable
 * lines for a visible confirmation banner -- per Chris 2026-09-23 ("why do
 * I have to find this out myself"), so the org chart proves it caught
 * something instead of fixing it silently in the background. Returns null
 * when there's nothing to show.
 */
function buildSyncSummary_(reconcileResult) {
  if (!reconcileResult || !reconcileResult.changed) return null;
  var lines = [];
  if (reconcileResult.newHireNames && reconcileResult.newHireNames.length) {
    lines.push((reconcileResult.newHireNames.length === 1 ? 'New employee added automatically: ' : reconcileResult.newHireNames.length + ' new employees added automatically: ') + reconcileResult.newHireNames.join(', '));
  }
  if (reconcileResult.relocated && reconcileResult.relocated.length) {
    reconcileResult.relocated.forEach(function (r) {
      lines.push(r.name + ' moved from ' + r.from + ' to ' + r.to);
    });
  }
  return lines.length ? lines : null;
}

function removePlacement_(employeeId, outlet) {
  var sheet = getPlacementsSheet_();
  var all = readAllPlacements_();
  for (var i = 0; i < all.length; i++) {
    if (all[i].employeeId === employeeId && outletKey_(all[i].outlet) === outletKey_(outlet)) {
      sheet.deleteRow(all[i].rowNumber);
      invalidatePlacementsCache_();
      return true;
    }
  }
  return false;
}

/** Removes EVERY placement for this person, on every outlet and leadership page -- used by apiDeletePerson, not exposed on its own (removing from just one outlet stays the ordinary "Remove from this outlet" action). */
function removeAllPlacementsForPerson_(employeeId) {
  var sheet = getPlacementsSheet_();
  var rowsToDelete = readAllPlacements_()
    .filter(function (p) { return p.employeeId === employeeId; })
    .map(function (p) { return p.rowNumber; })
    .sort(function (a, b) { return b - a; }); // bottom-up so deleting one row never shifts the row number of the next one to delete
  rowsToDelete.forEach(function (rowNumber) { sheet.deleteRow(rowNumber); });
  if (rowsToDelete.length) invalidatePlacementsCache_();
  return rowsToDelete.length;
}

// ---------------------------------------------------------------------
// Ground-team role classification -- the tag SET depends on what kind of
// outlet this is (Chris: F&B outlets split FOH/BOH, salon outlets split
// Service Provider/Reception instead -- "Other" was dropped entirely once
// "Unsorted" already exists as the catch-all, no need for both). Best-
// effort from the Mastersheet's own POSITION text; only classifies where
// it's genuinely unambiguous, everything else comes back '' ("Unsorted")
// for Chris to tag by hand in the page -- see apiSetRoleTag.
// ---------------------------------------------------------------------

var ROLE_SCHEME_FNB = 'fnb', ROLE_SCHEME_SALON = 'salon', ROLE_SCHEME_OFFICE = 'office';
// A real outlet that isn't actually F&B/salon-shaped at all (e.g. "Am I
// Addicted" -- Chris 2026-09-19: "not a F&B outlet... just put under ground
// team") -- Ground Team stays a single flat list, no FOH/BOH-style split.
var ROLE_SCHEME_FLAT = 'flat';
// Leadership-overview-only pseudo-schemes -- never returned by getRoleSchemeForOutlet_ for a real outlet, only used inside apiGetLeadershipOverview.
var ROLE_SCHEME_SALON_LEADERSHIP = 'salon_leadership';
var ROLE_SCHEME_DEPARTMENT = 'department';
var ROLE_TAG_OPTIONS = {
  fnb: ['FOH', 'BOH'],
  salon: ['Service Provider', 'Reception'],
  office: ['Executive', 'Junior'],
  flat: [],
  salon_leadership: ['Reception Lead', 'Service Provider Lead'],
};
// Layer labels also depend on scheme -- "Outlet In-Charge" / "Ground Team"
// read oddly for a back-office function with no physical outlet at all.
var LAYER_LABELS = {
  fnb: { layer1: 'Area Manager / GM', layer2: 'Outlet In-Charge', layer3: 'Ground Team' },
  salon: { layer1: 'Area Manager / GM', layer2: 'Outlet In-Charge', layer3: 'Ground Team' },
  office: { layer1: 'Area Manager / GM', layer2: 'Department Lead', layer3: 'Team' },
  flat: { layer1: 'Area Manager / GM', layer2: 'Outlet In-Charge', layer3: 'Ground Team' },
  // "Area Manager" never fit a back-office entity (Initia Management/
  // International) -- per Chris 2026-09-23, department-scheme outlets use
  // their own Layer 1 wording instead of the generic outlet default.
  department: { layer1: 'GM and Managing Directors', layer2: 'Department Lead', layer3: 'By Department' },
};
// Outlets that don't fit the FNB/SALON pattern at all -- named explicitly,
// same convention as OFFICE_LOCATION_NAMES below (checked by outlet/location
// name, not department, since the Mastersheet has no cleaner signal).
var FLAT_GROUND_TEAM_LOCATION_NAMES = ['AM I ADDICTED'];
var BOH_POSITION_KEYWORDS = ['BOH', 'CHEF', 'COMMIS', 'COOK', 'KITCHEN', 'CDP', 'STEWARD', 'DISHWASHER'];
var FOH_POSITION_KEYWORDS = ['FOH', 'CASHIER', 'HOST', 'WAITER', 'WAITRESS', 'SERVER', 'DINING ENTERTAINMENT', 'GUEST', 'AMBASSADOR', 'FRONT OF HOUSE'];
var SALON_RECEPTION_KEYWORDS = ['RECEPTION', 'FRONT DESK', 'CUSTOMER SERVICE', 'GUEST RELATION'];
var OFFICE_EXECUTIVE_KEYWORDS = ['MANAGER', 'DIRECTOR', 'HEAD', 'LEAD', 'SENIOR'];
var OFFICE_JUNIOR_KEYWORDS = ['ASSISTANT', 'JUNIOR', 'INTERN', 'TRAINEE', 'CLERK', 'EXECUTIVE']; // "...Executive" job TITLES (e.g. "Marketing Executive") are the entry/mid rung here, not the Executive TAG -- a real naming clash, resolved by checking seniority keywords first

// Back-office/support functions Chris named -- these have no physical
// outlet at all, so the FOH/BOH and Service Provider/Reception splits
// don't apply; matched by outlet/location name, not department, since
// that's how these show up in the Mastersheet's own LOCATION column.
var OFFICE_LOCATION_NAMES = ['BRANDING', 'MARKETING', 'INITIA INTERNATIONAL', 'INITIA MANAGEMENT'];

// ---------------------------------------------------------------------
// Leadership overviews -- Chris's cross-outlet pages (2026-09-18, expanded
// 2026-09-19 into three): each is a manually-curated 3-tier chart
// (Operations Management / Area Managers / People Managers), the People
// Managers tier split by a page-specific scheme, plus (for the two
// outlet-facing pages) a read-only rollup of every matching real outlet's
// current Layer 2 (Outlet In-Charge) people. None of these are real
// Mastersheet LOCATIONs -- each is stored as placements against its own
// reserved sentinel outlet name so the EXISTING add/move/remove/photo
// machinery (upsertPlacement_, apiAddPlacement, apiMoveLayer, etc.) works
// for all three completely unchanged. Never shown as normal outlet tiles
// (see apiGetOutletList's exclusion of these keys) -- the client reaches
// them via their own pinned tiles instead.
//
// fnb's outletName is the ORIGINAL single leadership page's sentinel,
// unchanged on purpose -- it's just been renamed/re-scoped to be F&B-
// specific, and must keep the same key so Chris's existing entries (Suresh,
// Jim, Grace Park, etc.) aren't orphaned.
// ---------------------------------------------------------------------
var GROUP_OPS_DEPARTMENTS = [
  'F&B Operations', 'Salon Operations', 'Accounts', 'Project', 'Product',
  'R&D (Production)', 'Procurement & Warehouse', 'Office Admin', 'SPS',
  'Branding', 'Maintenance', 'Marketing', 'Group Operations', 'Salon Management',
  'F&B Management', 'Business Development', 'HR', 'Group Management', 'Academy', 'Pottery',
];
var LEADERSHIP_PAGES = {
  fnb: {
    outletName: '__LEADERSHIP_OVERVIEW__',
    title: 'Singapore F&B Leadership',
    roleScheme: ROLE_SCHEME_FNB,
    roleTagOptions: ROLE_TAG_OPTIONS.fnb,
    showTiers: true,
    layer3Mode: 'flat', // People Managers is one flat list, not split -- the FOH/BOH split instead applies to the Outlet In-Charge Leads rollup below
    layerLabels: { layer1: 'Operations Management', layer2: 'Area Managers', layer3: 'People Managers' },
    outletRollupScheme: ROLE_SCHEME_FNB, // rollup only shows fnb-scheme outlets
    // Grouped by each outlet's own Outlet In-Charge FOH/BOH tag (set on that
    // outlet's own page via layer2RoleTagOptions -- see apiGetOutletDetail),
    // not by outlet -- same "Outlet In-Charge Leads split into FOH/BOH,
    // People Managers not split" structure Chris asked for on Salon.
    rollupGroupBy: 'roleTag',
    // Operations Management (Layer 1) split into named sub-groups -- per
    // Chris 2026-09-23. Tagged the same way as Layer 2/3 (manually, via the
    // "⋯" menu, never auto-classified) -- see layer1RoleTagOptions in
    // apiGetLeadershipOverview's response.
    layer1RoleTagOptions: ['F&B Operations Management', 'Dessert Operations Management'],
  },
  salon: {
    outletName: '__LEADERSHIP_SALON__',
    title: 'Singapore Salon Leadership',
    roleScheme: ROLE_SCHEME_SALON_LEADERSHIP,
    roleTagOptions: ROLE_TAG_OPTIONS.salon_leadership,
    showTiers: true,
    layer3Mode: 'hidden', // salon has no separate "People Managers" tier -- Outlet In-Charge already covers that; see rollupGroupBy below instead
    layerLabels: { layer1: 'Operations Management', layer2: 'Area Managers', layer3: 'People Managers' },
    outletRollupScheme: ROLE_SCHEME_SALON, // rollup only shows salon-scheme outlets
    // Instead of one box per outlet, the rollup groups every outlet's Outlet
    // In-Charge by their OWN Reception Lead/Service Provider Lead tag (set
    // on that outlet's own page, via layer2RoleTagOptions -- see
    // apiGetOutletDetail) -- "no People Managers tier, Outlet In-Charge
    // Leads split into Reception Lead / Service Provider Lead instead."
    rollupGroupBy: 'roleTag',
  },
  groupops: {
    outletName: '__LEADERSHIP_GROUPOPS__',
    title: 'Singapore Group Operations/Management Leadership',
    roleScheme: ROLE_SCHEME_DEPARTMENT,
    roleTagOptions: GROUP_OPS_DEPARTMENTS,
    showTiers: false, // flat, department-sorted list only -- these are functional departments, not outlets with an in-charge to roll up
    layer3Mode: 'split', // the department columns ARE this page's whole point
    layerLabels: { layer1: 'Operations Management', layer2: 'Area Managers', layer3: 'By Department' },
    outletRollupScheme: null,
    rollupGroupBy: null,
  },
};

// ---------------------------------------------------------------------
// Outlet Settings -- an explicit, admin-editable override of each outlet's
// Role Scheme (added 2026-09-23, per Chris: the heuristics below had been
// misclassifying some salon/back-office outlets as F&B, so F&B Leadership's
// Layer 1 was showing up on outlets it shouldn't). One row per outlet
// LOCATION; a "department" scheme also carries its own comma-separated
// department list here (an outlet-specific version of what
// GROUP_OPS_DEPARTMENTS is for the cross-outlet leadership page).
// getRoleSchemeForOutlet_ checks this FIRST -- an outlet with no explicit
// row still falls back to the original heuristics below, so a genuinely
// NEW outlet (not yet reviewed by the team) still gets a reasonable
// default instead of showing up unclassified.
// ---------------------------------------------------------------------
// "Layer1 Manual" appended at the END (not inserted among the other
// columns) so existing rows written before this field existed don't have
// their Updated At/By shifted -- reads are strictly by column position.
// When truthy, this outlet's Layer 1 is a normal, directly-editable
// placement instead of auto-mirroring its scheme's Leadership page --
// added 2026-09-23 per Chris: AiFOKATO/Tofu G outlets need a different
// manager than the rest of F&B, so they need to opt OUT of the shared
// Singapore F&B Leadership mirror specifically.
var ORG_CHART_OUTLET_SETTINGS_HEADERS = ['Location', 'Role Scheme', 'Departments', 'Updated At', 'Updated By', 'Layer1 Manual'];

function getOutletSettingsSheet_() {
  var ss = SpreadsheetApp.openById(CONFIG.MASTERSHEET_ID);
  var sheet = ss.getSheetByName(CONFIG.ORG_CHART_OUTLET_SETTINGS_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.ORG_CHART_OUTLET_SETTINGS_SHEET_NAME);
    sheet.getRange(1, 1, 1, ORG_CHART_OUTLET_SETTINGS_HEADERS.length).setValues([ORG_CHART_OUTLET_SETTINGS_HEADERS]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

var ORG_CHART_OUTLET_SETTINGS_CACHE_KEY = 'oc_outlet_settings';
var ORG_CHART_OUTLET_SETTINGS_CACHE_TTL_SECONDS = 600;
var _outletSettingsMap = null; // {outletKey: {location, scheme, departments: [...], rowNumber}}
function readOutletSettingsMap_() {
  if (_outletSettingsMap) return _outletSettingsMap;
  var cache = CacheService.getScriptCache();
  var raw = cache.get(ORG_CHART_OUTLET_SETTINGS_CACHE_KEY);
  if (raw) {
    try { _outletSettingsMap = JSON.parse(raw); return _outletSettingsMap; } catch (e) { /* fall through to a live read */ }
  }
  var sheet = getOutletSettingsSheet_();
  var lastRow = sheet.getLastRow();
  var map = {};
  if (lastRow >= 2) {
    var values = sheet.getRange(2, 1, lastRow - 1, ORG_CHART_OUTLET_SETTINGS_HEADERS.length).getValues();
    values.forEach(function (row, i) {
      var location = String(row[0] || '').trim();
      if (!location) return;
      var departments = String(row[2] || '').split(',').map(function (d) { return d.trim(); }).filter(Boolean);
      map[outletKey_(location)] = {
        location: location, scheme: String(row[1] || '').trim(), departments: departments,
        layer1Manual: !!String(row[5] || '').trim(), rowNumber: i + 2,
      };
    });
  }
  try { cache.put(ORG_CHART_OUTLET_SETTINGS_CACHE_KEY, JSON.stringify(map), ORG_CHART_OUTLET_SETTINGS_CACHE_TTL_SECONDS); } catch (e) { /* fine to skip caching this round */ }
  _outletSettingsMap = map;
  return map;
}
function invalidateOutletSettingsCache_() {
  _outletSettingsMap = null;
  try { CacheService.getScriptCache().remove(ORG_CHART_OUTLET_SETTINGS_CACHE_KEY); } catch (e) { /* fine if this fails -- it'll just expire on its own TTL */ }
}

/**
 * Every distinct outlet name the team might need to classify -- every
 * Mastersheet LOCATION value (regardless of current headcount, so a
 * soon-to-be-relevant or currently-empty outlet can still be pre-configured)
 * plus any outlet that only exists via Placements, minus the 3 leadership
 * sentinel keys (never real outlets). Case-insensitively deduped via
 * outletKey_, same convention as apiGetOutletList.
 */
function getAllKnownOutletNames_() {
  var leadershipKeys = getLeadershipOutletKeySet_();
  var byKey = {}; // key -> a display casing
  var snapshot = getMastersheetSnapshot_();
  var headers = snapshot.headers, allValues = snapshot.allValues;
  for (var i = snapshot.headerRowNumber; i < allValues.length; i++) {
    var row = { headers: headers, values: allValues[i] };
    var location = cell_(row, MASTERSHEET_LOCATION, 0);
    if (!location) continue;
    var key = outletKey_(location);
    if (leadershipKeys[key]) continue;
    if (!byKey[key]) byKey[key] = location;
  }
  readAllPlacements_().forEach(function (p) {
    var key = outletKey_(p.outlet);
    if (leadershipKeys[key] || byKey[key]) return;
    byKey[key] = p.outlet;
  });
  return Object.keys(byKey).map(function (key) { return byKey[key]; }).sort(function (a, b) { return a.localeCompare(b); });
}

/** Everything the admin settings screen needs: every known outlet, its current EFFECTIVE scheme (explicit override if set, else the auto-detected default), whether that's an override or just the heuristic default, and whether its Layer 1 is opted out of the Leadership-page mirror. */
function apiGetOutletSettingsAdmin() {
  requireAdmin_();
  var settingsMap = readOutletSettingsMap_();
  return getAllKnownOutletNames_().map(function (name) {
    var configured = settingsMap[outletKey_(name)];
    return {
      name: name,
      scheme: getRoleSchemeForOutlet_(name),
      isOverride: !!(configured && configured.scheme),
      departments: (configured && configured.departments) || [],
      layer1Manual: !!(configured && configured.layer1Manual),
    };
  });
}

/** Sets (or clears, if scheme is blank) an outlet's explicit Role Scheme override, and its Layer1-manual opt-out. departmentsCsv is only meaningful when scheme === ROLE_SCHEME_DEPARTMENT. */
function apiSetOutletSetting(outletName, scheme, departmentsCsv, layer1Manual) {
  requireAdmin_();
  var sheet = getOutletSettingsSheet_();
  var settingsMap = readOutletSettingsMap_();
  var key = outletKey_(outletName);
  var existing = settingsMap[key];
  var now = new Date(), user = currentUserEmail_();
  var row = [outletName, scheme || '', departmentsCsv || '', now, user, layer1Manual ? 'YES' : ''];
  if (existing) {
    sheet.getRange(existing.rowNumber, 1, 1, row.length).setValues([row]);
  } else {
    sheet.getRange(sheet.getLastRow() + 1, 1, 1, row.length).setValues([row]);
  }
  invalidateOutletSettingsCache_();
  return true;
}

/** True if this outlet has opted out of its scheme's Leadership-page Layer 1 mirror (set via Outlet Settings) -- its Layer 1 is then a normal, directly-editable placement instead. */
function isLayer1Manual_(outletName) {
  var configured = readOutletSettingsMap_()[outletKey_(outletName)];
  return !!(configured && configured.layer1Manual);
}

/** flat (explicit list) > office (explicit list) > salon (majority "...Salon..." department) > fnb (the default). */
function getRoleSchemeForOutlet_(outletName) {
  var key = outletKey_(outletName);
  var configured = readOutletSettingsMap_()[key];
  if (configured && configured.scheme) return configured.scheme;
  if (FLAT_GROUND_TEAM_LOCATION_NAMES.indexOf(key) !== -1) return ROLE_SCHEME_FLAT;
  if (OFFICE_LOCATION_NAMES.indexOf(key) !== -1) return ROLE_SCHEME_OFFICE;
  var here = readMastersheetEmployees_().filter(function (e) { return outletKey_(e.location) === key; });
  if (!here.length) return ROLE_SCHEME_FNB;
  var salonCount = 0;
  here.forEach(function (e) { if (String(e.department || '').toUpperCase().indexOf('SALON') !== -1) salonCount++; });
  return salonCount > here.length / 2 ? ROLE_SCHEME_SALON : ROLE_SCHEME_FNB;
}

/** The outlet-specific department list for a "department"-scheme outlet, set via apiSetOutletSetting -- falls back to the cross-outlet leadership page's fixed list only if somehow unconfigured. */
function getOutletDepartmentList_(outletName) {
  var configured = readOutletSettingsMap_()[outletKey_(outletName)];
  return (configured && configured.departments && configured.departments.length) ? configured.departments : GROUP_OPS_DEPARTMENTS;
}

function classifyRoleTag_(position, scheme) {
  var p = String(position || '').toUpperCase();
  if (scheme === ROLE_SCHEME_SALON_LEADERSHIP || scheme === ROLE_SCHEME_FLAT) return ''; // leadership-level titles don't hint reception vs. service; flat outlets have no split at all -- always leave unclassified, never guess
  if (!p) return '';
  if (scheme === ROLE_SCHEME_SALON) {
    for (var k = 0; k < SALON_RECEPTION_KEYWORDS.length; k++) { if (p.indexOf(SALON_RECEPTION_KEYWORDS[k]) !== -1) return 'Reception'; }
    return 'Service Provider'; // salon positions are overwhelmingly the service itself -- unlike F&B, rarely genuinely ambiguous
  }
  if (scheme === ROLE_SCHEME_OFFICE) {
    // Deliberately more cautious than salon's default-to-one-tag: job-title
    // seniority is fuzzy (a "Marketing Executive" isn't the Executive TAG),
    // so anything not clearly matching either keyword set stays Unsorted
    // for Chris to sort by hand -- same philosophy as F&B's FOH/BOH.
    for (var m = 0; m < OFFICE_EXECUTIVE_KEYWORDS.length; m++) { if (p.indexOf(OFFICE_EXECUTIVE_KEYWORDS[m]) !== -1) return 'Executive'; }
    for (var n = 0; n < OFFICE_JUNIOR_KEYWORDS.length; n++) { if (p.indexOf(OFFICE_JUNIOR_KEYWORDS[n]) !== -1) return 'Junior'; }
    return '';
  }
  for (var i = 0; i < BOH_POSITION_KEYWORDS.length; i++) { if (p.indexOf(BOH_POSITION_KEYWORDS[i]) !== -1) return ROLE_TAG_BOH; }
  for (var j = 0; j < FOH_POSITION_KEYWORDS.length; j++) { if (p.indexOf(FOH_POSITION_KEYWORDS[j]) !== -1) return ROLE_TAG_FOH; }
  return ''; // ambiguous (e.g. bare "Management Trainee", "Supervisor") -- leave for manual sort
}

// ---------------------------------------------------------------------
// Person resolution -- merges Mastersheet facts (if any) with People-sheet
// overrides/manual profile into one shape the client renders. Role-tag
// AUTO-classification is deliberately NOT done here (it needs the outlet's
// scheme, which this function doesn't know) -- see apiGetOutletDetail.
// ---------------------------------------------------------------------

function resolvePerson_(employeeId, peopleMap) {
  var override = peopleMap[employeeId];
  var ms = findMastersheetEmployeeById_(employeeId);

  if (ms) {
    var photoFileId = override ? override.photoFileId : '';
    // A Mastersheet CB photo counts as "has a photo" even before it's been
    // carried over to Drive -- apiGetPhotoDataUrl does that carry-over the
    // first time the client actually asks to load this avatar (see
    // migratePhotoFromMastersheetColumn_), so this only needs to know one
    // exists, not fetch it here.
    var hasPhoto = !!photoFileId || !!getMastersheetPhotoRows_()[ms.rowNumber] || !!getMastersheetPfileRows_()[ms.rowNumber];
    return {
      id: employeeId, source: 'mastersheet', name: ms.name, nickname: ms.nickname, position: ms.position,
      entity: ms.entity, location: ms.location, department: ms.department, status: ms.status,
      hasPhoto: hasPhoto, roleTag: override ? override.roleTag : '',
      companyPhone: override ? override.companyPhone : '', companyEmail: override ? override.companyEmail : '',
      resigningSoon: ms.resigningSoon, lastWorkingDay: ms.lastWorkingDay,
      employmentType: ms.employmentType,
    };
  }
  if (override && override.source === 'manual') {
    return {
      id: employeeId, source: 'manual', name: override.name, nickname: override.nickname, position: override.position,
      entity: '', location: '', department: '', status: 'active',
      hasPhoto: !!override.photoFileId, roleTag: override.roleTag || '',
      companyPhone: override.companyPhone || '', companyEmail: override.companyEmail || '',
      employmentType: '', // no Mastersheet row to carry a real F/T-P/T status from
    };
  }
  return null; // placement points at someone who no longer resolves (deleted manual person, etc.)
}

// ---------------------------------------------------------------------
// Outlets
// ---------------------------------------------------------------------

/**
 * Every outlet name worth showing in the index -- live Mastersheet locations,
 * union any outlet only reachable via a manual placement. Grouped by
 * outletKey_ (case-insensitive) so free-typed Mastersheet LOCATION variants
 * like "INITIA INTERNATIONAL"/"Initia International" merge into one outlet.
 *
 * Display casing prefers the LIVE Mastersheet text over whatever's stored on
 * Placements rows -- Placements' `outlet` column is a point-in-time snapshot
 * from whenever someone was seeded/moved, and rows for people who've since
 * resigned or left never get cleaned up, so old casing can otherwise sit
 * there indefinitely outvoting a Mastersheet cleanup Chris just made (this is
 * exactly why a LOCATION casing fix didn't show up after clicking Refresh).
 * Only when NO active Mastersheet employee currently votes for a key (outlet
 * only reachable via manual placements) does a Placements-based casing vote
 * get used at all.
 */
// TEMPORARY (2026-09-21): phase-by-phase timing, returned to the client's
// existing perf panel, to find out why apiGetOutletList is still slow even
// after both the placements cache (@38) and the lock removal (@37) --
// remove the _timing field and every t0/t1/... line below once the
// remaining bottleneck is found.
function apiGetOutletList() {
  var timing = {};
  var tReconcile0 = Date.now();
  var reconcileResult = reconcileAutoPlacements_();
  timing.reconcile = Date.now() - tReconcile0;
  timing.reconcileChanged = !!(reconcileResult && reconcileResult.changed);
  timing.reconcileReadMs = reconcileResult && reconcileResult.readMs;
  timing.reconcileScanMs = reconcileResult && reconcileResult.scanMs;
  timing.reconcileWriteMs = reconcileResult && reconcileResult.writeMs;

  var counts = {}; // key -> count
  var msCasingVotes = {}; // key -> { exact casing -> vote count }, from LIVE Mastersheet rows only
  var placementCasingVotes = {}; // key -> { exact casing -> vote count }, fallback only
  function vote(map, key, casing) {
    if (!map[key]) map[key] = {};
    map[key][casing] = (map[key][casing] || 0) + 1;
  }

  var tEmployees0 = Date.now();
  var employees = readMastersheetEmployees_();
  timing.readEmployees = Date.now() - tEmployees0;
  employees.forEach(function (e) {
    if (e.status !== 'active' || !e.location) return;
    var key = outletKey_(e.location);
    counts[key] = (counts[key] || 0) + 1;
    vote(msCasingVotes, key, e.location);
  });

  var leadershipKeys = getLeadershipOutletKeySet_();
  var tPlacements0 = Date.now();
  var placements = readAllPlacements_();
  timing.readPlacements = Date.now() - tPlacements0;
  placements.forEach(function (p) {
    var key = outletKey_(p.outlet);
    if (leadershipKeys[key]) return; // handled by apiGetLeadershipOverview instead -- never a normal outlet tile
    if (!(key in counts)) counts[key] = 0;
    vote(placementCasingVotes, key, p.outlet);
  });

  var tBuild0 = Date.now();
  var results = Object.keys(counts).map(function (key) {
    var votes = msCasingVotes[key] || placementCasingVotes[key] || {};
    var bestCasing = key, bestVotes = -1;
    Object.keys(votes).forEach(function (casing) {
      if (votes[casing] > bestVotes) { bestCasing = casing; bestVotes = votes[casing]; }
    });
    return { name: bestCasing, activeCount: counts[key] };
  });
  results.sort(function (a, b) { return a.name.localeCompare(b.name); });
  timing.build = Date.now() - tBuild0;

  return { outlets: results, _timing: timing, syncSummary: buildSyncSummary_(reconcileResult) };
}

function getLeadershipOutletKeySet_() {
  var set = {};
  Object.keys(LEADERSHIP_PAGES).forEach(function (k) { set[outletKey_(LEADERSHIP_PAGES[k].outletName)] = true; });
  return set;
}

// ---------------------------------------------------------------------
// Incoming Employees -- active FULL-TIME onboarding only (admin read-only)
// ---------------------------------------------------------------------

function incomingNameKey_(value) {
  return String(value || '').trim().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '');
}

function incomingClickUpField_(task, fieldName) {
  var fields = (task && task.custom_fields) || [];
  for (var i = 0; i < fields.length; i++) {
    var field = fields[i];
    if (String(field.name || '').trim().toLowerCase() !== String(fieldName || '').trim().toLowerCase()) continue;
    var value = field.value;
    if (value === null || value === undefined || value === '') return '';
    if (field.type === 'drop_down' && field.type_config && field.type_config.options) {
      var options = field.type_config.options;
      for (var j = 0; j < options.length; j++) {
        if (String(options[j].id) === String(value) || j === Number(value)) return options[j].name || options[j].label || String(value);
      }
    }
    if (Array.isArray(value)) return value.map(function (v) { return v.name || v.label || String(v); }).join(', ');
    if (typeof value === 'object') return value.name || value.label || value.value || '';
    return String(value);
  }
  return '';
}

function readIncomingPhotoMap_() {
  var sheet = SpreadsheetApp.openById(CONFIG.APPLICATION_FORM_SPREADSHEET_ID)
    .getSheetByName(CONFIG.APPLICATION_FORM_SHEET_NAME);
  if (!sheet) throw new Error('Application form response sheet was not found.');
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return {};
  var count = lastRow - 1;
  var names = sheet.getRange(2, CONFIG.ORG_CHART_APPLICATION_NAME_COLUMN, count, 1).getDisplayValues();
  var photos = sheet.getRange(2, CONFIG.ORG_CHART_APPLICATION_PHOTO_COLUMN, count, 1).getDisplayValues();
  var map = {};
  for (var i = 0; i < count; i++) {
    var key = incomingNameKey_(names[i][0]);
    var photo = String(photos[i][0] || '').trim();
    // Later form submissions are normally the newest, so let them win.
    if (key && photo) map[key] = photo;
  }
  return map;
}

// ---------------------------------------------------------------------
// Manual photo override for an Incoming Employees card -- per Chris
// 2026-09-25 ("some employees photos are not shown ... add a three dots on
// the side of the card profile to manually insert the photos too"). Keyed
// by ClickUp task id, not employee id -- these people don't have one yet.
// Per-execution only (no CacheService layer): the incoming list is short
// (a few dozen at most) and read once per page load, so there's nothing
// worth caching across requests here.
// ---------------------------------------------------------------------

function getIncomingPhotosSheet_() {
  var ss = SpreadsheetApp.openById(CONFIG.MASTERSHEET_ID);
  var sheet = ss.getSheetByName(CONFIG.ORG_CHART_INCOMING_PHOTOS_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.ORG_CHART_INCOMING_PHOTOS_SHEET_NAME);
    sheet.getRange(1, 1, 1, 4).setValues([['Task ID', 'Photo File ID', 'Updated At', 'Updated By']]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/** ClickUp task id -> {fileId, rowNumber}. */
var _incomingPhotoOverrides = null;
function readIncomingPhotoOverrides_() {
  if (_incomingPhotoOverrides) return _incomingPhotoOverrides;
  var sheet = getIncomingPhotosSheet_();
  var lastRow = sheet.getLastRow();
  var map = {};
  if (lastRow >= 2) {
    sheet.getRange(2, 1, lastRow - 1, 2).getDisplayValues().forEach(function (row, i) {
      var taskId = String(row[0] || '').trim();
      var fileId = String(row[1] || '').trim();
      if (taskId && fileId) map[taskId] = { fileId: fileId, rowNumber: i + 2 };
    });
  }
  _incomingPhotoOverrides = map;
  return map;
}
function invalidateIncomingPhotosCache_() { _incomingPhotoOverrides = null; }

function getOrCreateIncomingPhotosFolderId_() {
  var it = DriveApp.getFoldersByName(CONFIG.ORG_CHART_INCOMING_PHOTOS_FOLDER_NAME);
  if (it.hasNext()) return it.next().getId();
  return DriveApp.createFolder(CONFIG.ORG_CHART_INCOMING_PHOTOS_FOLDER_NAME).getId();
}

/**
 * Uploads privately to Drive (never publicly shared -- same as every other
 * photo in this app, and especially deliberate here given PDPA) and returns
 * an immediate data URL for display; re-fetched the same private way (see
 * apiGetIncomingEmployees below) on every later load, never a public link.
 */
function apiSetIncomingEmployeePhoto(taskId, base64Data, mimeType, fileName) {
  requireAdmin_();
  var id = String(taskId || '').trim();
  if (!id) throw new Error('Missing task id.');
  var bytes = Utilities.base64Decode(base64Data);
  var extension = guessExtensionFromMimeType_(mimeType) || '';
  var blob = Utilities.newBlob(bytes, mimeType, (fileName || 'Incoming Photo') + ' [' + id + ']' + extension);
  var folderId = getOrCreateIncomingPhotosFolderId_();
  var created = driveUploadBytes_(folderId, blob.getName(), blob);

  var sheet = getIncomingPhotosSheet_();
  var overrides = readIncomingPhotoOverrides_();
  var now = new Date(), user = currentUserEmail_();
  if (overrides[id]) {
    sheet.getRange(overrides[id].rowNumber, 1, 1, 4).setValues([[id, created.id, now, user]]);
  } else {
    sheet.getRange(sheet.getLastRow() + 1, 1, 1, 4).setValues([[id, created.id, now, user]]);
  }
  invalidateIncomingPhotosCache_();
  return { dataUrl: blobToDataUrl_(blob) };
}

/** Doesn't delete the Drive file itself -- same non-destructive reasoning as apiClearPhoto. Falls back to the auto name-match, if any. */
function apiClearIncomingEmployeePhoto(taskId) {
  requireAdmin_();
  var id = String(taskId || '').trim();
  var overrides = readIncomingPhotoOverrides_();
  if (overrides[id]) {
    getIncomingPhotosSheet_().deleteRow(overrides[id].rowNumber);
    invalidateIncomingPhotosCache_();
  }
  return true;
}

function fetchIncomingClickUpList_(industry, token) {
  var tasks = [];
  for (var page = 0; page < 100; page++) {
    var url = 'https://api.clickup.com/api/v2/list/' + encodeURIComponent(industry.listId) + '/task?page=' + page + '&subtasks=true';
    var response = UrlFetchApp.fetch(url, {
      method: 'get',
      headers: { Authorization: token },
      muteHttpExceptions: true,
    });
    var code = response.getResponseCode();
    if (code < 200 || code >= 300) throw new Error('ClickUp could not load ' + industry.label + ' (HTTP ' + code + ').');
    var body = JSON.parse(response.getContentText() || '{}');
    var pageTasks = body.tasks || [];
    pageTasks.forEach(function (task) { if (!task.parent) tasks.push(task); });
    if (body.last_page === true || pageTasks.length === 0) break;
  }
  return tasks;
}

function apiGetIncomingEmployees() {
  requireAdmin_();
  var token = String(PropertiesService.getScriptProperties().getProperty('CLICKUP_TOKEN') || '').trim();
  if (!token) throw new Error('Incoming Employees is not connected yet. Add CLICKUP_TOKEN in this Apps Script project\'s Script Properties.');
  var photoMap = readIncomingPhotoMap_();
  var photoOverrides = readIncomingPhotoOverrides_();
  var industries = (CONFIG.ORG_CHART_INCOMING_INDUSTRIES || []).map(function (industry) {
    var rows = fetchIncomingClickUpList_(industry, token).map(function (task) {
      var fullName = incomingClickUpField_(task, CONFIG.ORG_CHART_INCOMING_FULL_NAME_FIELD) || task.name || '';
      var position = incomingClickUpField_(task, CONFIG.ORG_CHART_INCOMING_POSITION_FIELD);
      var proposedStartMs = Number(incomingClickUpField_(task, CONFIG.ORG_CHART_INCOMING_START_DATE_FIELD) || 0);
      var dueMs = proposedStartMs || Number(task.due_date || 0);
      var taskId = String(task.id || '');
      var override = photoOverrides[taskId];
      var manualPhotoUrl = '';
      if (override) {
        // The file could've been trashed/moved outside the app -- fall back
        // to the auto name-match below rather than break the whole list.
        try { manualPhotoUrl = blobToDataUrl_(DriveApp.getFileById(override.fileId).getBlob()); } catch (e) { manualPhotoUrl = ''; }
      }
      return {
        id: taskId,
        fullName: fullName,
        position: position,
        outlet: incomingClickUpField_(task, CONFIG.ORG_CHART_INCOMING_OUTLET_FIELD),
        department: incomingClickUpField_(task, CONFIG.ORG_CHART_INCOMING_DEPARTMENT_FIELD),
        status: task.status && task.status.status ? String(task.status.status) : '',
        joinDate: dueMs ? Utilities.formatDate(new Date(dueMs), Session.getScriptTimeZone(), 'dd MMM yyyy') : 'TBC',
        photoUrl: manualPhotoUrl || photoMap[incomingNameKey_(fullName)] || '',
        photoIsManual: !!manualPhotoUrl,
        isManagementTrainee: !!industry.isManagementTraineeList || /management\s*trainee/i.test(position),
      };
    }).filter(function (row) { return row.fullName; });
    rows.sort(function (a, b) {
      if (a.isManagementTrainee !== b.isManagementTrainee) return a.isManagementTrainee ? -1 : 1;
      return String(a.position || '').localeCompare(String(b.position || '')) || String(a.fullName).localeCompare(String(b.fullName));
    });
    return { code: industry.code, label: industry.label, employees: rows };
  });
  return {
    industries: industries,
    total: industries.reduce(function (sum, item) { return sum + item.employees.length; }, 0),
  };
}

/**
 * One of the three leadership overview pages' data (see LEADERSHIP_PAGES):
 * its own 3 manually-curated tiers -- People Managers split by that page's
 * own scheme (FOH/BOH for F&B, Reception Lead/Service Provider Lead for
 * Salon, or by department for Group Ops/Management) -- plus, for the two
 * outlet-facing pages, a read-only rollup of every MATCHING real outlet's
 * current Layer 2 (Outlet In-Charge) people, built from the SAME placements
 * pass so it always matches whatever's live on each outlet's own page (no
 * separate storage to keep in sync). Group Ops/Management has no rollup at
 * all (kind=null) -- these are functional departments, not outlets with an
 * in-charge.
 */
function apiGetLeadershipOverview(kind) {
  var config = LEADERSHIP_PAGES[kind];
  if (!config) throw new Error('Unknown leadership page: ' + kind);
  var reconcileResult = reconcileAutoPlacements_();
  var leadershipKey = outletKey_(config.outletName);

  var canonicalNames = {};
  if (config.outletRollupScheme) {
    apiGetOutletList().outlets.forEach(function (o) { canonicalNames[outletKey_(o.name)] = o.name; }); // apiGetOutletList returns {outlets, _timing} during the TEMPORARY timing pass -- see apiGetOutletList's own comment
  }
  var outletSchemeCache = {};
  function schemeForOutlet(outlet) {
    var key = outletKey_(outlet);
    if (!(key in outletSchemeCache)) outletSchemeCache[key] = getRoleSchemeForOutlet_(outlet);
    return outletSchemeCache[key];
  }

  var peopleMap = readPeopleMap_();
  var layer1 = [], layer2 = [], layer3 = [];
  var groupMap = {}; // keyed by outlet OR by role tag, depending on config.rollupGroupBy
  var otherLeadershipKeys = getLeadershipOutletKeySet_();

  readAllPlacements_().forEach(function (p) {
    var key = outletKey_(p.outlet);
    if (key === leadershipKey) {
      var person = resolvePerson_(p.employeeId, peopleMap);
      if (!person) return;
      person.layer = p.layer;
      // Same stale-tag-vanishes-the-person bug as apiGetOutletDetail (see its
      // comment) -- only actually at risk here on the groupops page (its
      // Layer 3 is the only one of the three leadership pages that's
      // tag-grouped, layer3Mode 'split'; fnb/salon render Layer 3 flat/hidden
      // so a stale tag there is inert), but validating uniformly is simplest.
      if (p.layer === 3 && (!person.roleTag || config.roleTagOptions.indexOf(person.roleTag) === -1)) {
        person.roleTag = config.roleScheme === ROLE_SCHEME_DEPARTMENT
          ? (GROUP_OPS_DEPARTMENTS.indexOf(person.department) !== -1 ? person.department : '')
          : classifyRoleTag_(person.position, config.roleScheme);
      }
      // Same reasoning again for Layer 1 -- only fnb's layer1RoleTagOptions is
      // ever tag-grouped (salon/groupops render Layer 1 flat, so a stale tag
      // there is inert). roleTag is one shared field per PERSON across every
      // placement they hold, so someone tagged for a DIFFERENT context
      // entirely (e.g. Chin Chen Zhuan's "Business Development" department
      // tag from his Initia Management placement) silently vanished from this
      // page's Layer 1 with no way to even reach their card to fix it, since
      // the vanish happens before the card ever renders. Resetting to blank
      // (never auto-classified for Layer 1 -- same as before) at least drops
      // them into Unsorted instead of nowhere.
      if (p.layer === 1 && config.layer1RoleTagOptions && config.layer1RoleTagOptions.length && person.roleTag && config.layer1RoleTagOptions.indexOf(person.roleTag) === -1) {
        person.roleTag = '';
      }
      if (p.layer === 1) layer1.push(person);
      else if (p.layer === 2) layer2.push(person);
      else layer3.push(person);
      return;
    }
    // Any OTHER leadership page's own sentinel -- never a real outlet.
    // Without this, getRoleSchemeForOutlet_ falls back to 'fnb' for a
    // sentinel name (no real Mastersheet employees "there" to check), so a
    // placement like Salon Leadership's own Area Managers would wrongly
    // look like an fnb-scheme outlet and leak into the F&B rollup (confirmed
    // happening live, 2026-09-19 -- a box literally labeled
    // "__LEADERSHIP_SALON__" showed up in F&B's Outlet In-Charge Leads).
    if (otherLeadershipKeys[key]) return;
    if (!config.outletRollupScheme || p.layer !== 2) return;
    if (schemeForOutlet(p.outlet) !== config.outletRollupScheme) return;
    var leadPerson = resolvePerson_(p.employeeId, peopleMap);
    if (!leadPerson) return;

    if (config.rollupGroupBy === 'roleTag') {
      // Grouped by the Outlet In-Charge's OWN tag (set on their outlet's own
      // page via layer2RoleTagOptions), not by outlet -- each person carries
      // which outlet they're actually from since the box no longer says so.
      leadPerson.outletLabel = canonicalNames[key] || p.outlet;
      var tag = leadPerson.roleTag || '';
      var groupKey = 'tag:' + tag;
      if (!groupMap[groupKey]) groupMap[groupKey] = { outlet: tag || 'Not yet tagged', sortKey: tag, people: [] };
      groupMap[groupKey].people.push(leadPerson);
    } else {
      if (!groupMap[key]) groupMap[key] = { outlet: canonicalNames[key] || p.outlet, sortKey: canonicalNames[key] || p.outlet, people: [] };
      groupMap[key].people.push(leadPerson);
    }
  });

  var byName = function (a, b) { return a.name.localeCompare(b.name); };
  layer1.sort(byName); layer2.sort(byName); layer3.sort(byName);

  var outletLeads = null;
  if (config.rollupGroupBy) {
    outletLeads = Object.keys(groupMap).map(function (key) {
      groupMap[key].people.sort(byName);
      return groupMap[key];
    });
    if (config.rollupGroupBy === 'roleTag') {
      var tagOrder = config.roleTagOptions;
      outletLeads.sort(function (a, b) {
        var ia = tagOrder.indexOf(a.sortKey); if (ia === -1) ia = tagOrder.length;
        var ib = tagOrder.indexOf(b.sortKey); if (ib === -1) ib = tagOrder.length;
        return ia - ib;
      });
    } else {
      outletLeads.sort(function (a, b) { return a.sortKey.localeCompare(b.sortKey); });
    }
  }

  return {
    outlet: config.outletName, title: config.title, showTiers: config.showTiers, layer3Mode: config.layer3Mode,
    layer1: layer1, layer2: layer2, layer3: layer3,
    roleScheme: config.roleScheme, roleTagOptions: config.roleTagOptions, layerLabels: config.layerLabels,
    outletLeads: outletLeads, rollupGroupBy: config.rollupGroupBy,
    layer1RoleTagOptions: config.layer1RoleTagOptions || [],
    syncSummary: buildSyncSummary_(reconcileResult),
  };
}

/**
 * Everything needed to render one outlet's 3-layer page. First call for an
 * outlet with no placements yet auto-seeds Layer 3 with every active
 * Mastersheet employee at that location (Layer 1/2 stay empty -- Chris
 * places outlet leads/management by hand, deliberately never guessed).
 */
function apiGetOutletDetail(outletName) {
  // Used to skip reconciling here, trusting apiGetOutletList() to have just
  // done it moments earlier in the same page load -- but that assumption
  // breaks whenever this is reached WITHOUT going through the index first,
  // e.g. clicking Refresh while already sitting on an outlet's own page
  // (hardRefresh -> reloadCurrentView -> goOutlet, never touches
  // apiGetOutletList at all). Confirmed live 2026-09-23: Do Ba Ha/Do Ba Nam
  // (long-standing employees, never placed anywhere -- same gap as Nur
  // Aishah) only showed up after a fresh visit via the index; refreshing
  // directly on the outlet page never picked them up. Reconciling
  // unconditionally here removes the assumption entirely -- cheap when
  // nothing's changed, since it just re-reads the already-cached roster/
  // placements rather than a fresh live scan.
  var reconcileResult = reconcileAutoPlacements_();
  var outletKey = outletKey_(outletName);
  var placements = readAllPlacements_().filter(function (p) { return outletKey_(p.outlet) === outletKey; });

  if (!placements.length) {
    var atLocation = readMastersheetEmployees_().filter(function (e) { return outletKey_(e.location) === outletKey && e.status === 'active'; });
    if (atLocation.length) {
      // A big outlet can be 60-80+ people -- upsertPlacement_ in a loop
      // would mean that many separate read-the-whole-sheet-then-write
      // round trips. This only ever runs once per outlet (the very first
      // time it's opened), so a single bulk append is worth it.
      var now = new Date(), user = currentUserEmail_();
      var rows = atLocation.map(function (e) { return [e.id, outletName, 3, PLACEMENT_SOURCE_AUTO, now, user]; });
      var placementsSheet = getPlacementsSheet_();
      placementsSheet.getRange(placementsSheet.getLastRow() + 1, 1, rows.length, ORG_CHART_PLACEMENTS_HEADERS.length).setValues(rows);
      invalidatePlacementsCache_();
      placements = readAllPlacements_().filter(function (p) { return outletKey_(p.outlet) === outletKey; });
    }
  }

  var scheme = getRoleSchemeForOutlet_(outletName);
  // "department" outlets (e.g. Initia International, Initia Management --
  // Chris 2026-09-23) classify Layer 3 by the person's own DEPARTMENT field
  // against this outlet's own configured department list, not by position
  // keywords -- same idea as the Group Ops Leadership page, just per-outlet
  // configurable now instead of one fixed global list.
  var departmentList = scheme === ROLE_SCHEME_DEPARTMENT ? getOutletDepartmentList_(outletName) : null;
  // A roleTag left over from BEFORE this outlet was on its current scheme
  // (e.g. an office-scheme "Executive"/"Junior" tag surviving a switch to
  // "department", or a department name Chris has since renamed/removed) no
  // longer matches any of this scheme's own columns -- the column-rendering
  // loop client-side only iterates over the CURRENT valid tags plus
  // Unsorted, so a person carrying a stale tag silently has nowhere to
  // render at all (not even Unsorted, which only catches a genuinely BLANK
  // tag) and vanishes from the page entirely. Confirmed live 2026-09-23:
  // Do Ba Ha/Do Ba Nam both carried a stale "Executive" tag from Initia
  // International's old office-scheme auto-detection, from before Chris set
  // it to department scheme. Validating against THIS scheme's own valid
  // tags (not just checking for blank) and re-deriving whenever it doesn't
  // match closes this for every scheme going forward, not just department,
  // and not just for these two people -- the same silent-vanish can happen
  // any time an outlet's Role Scheme or department list changes.
  var layer3ValidTags = scheme === ROLE_SCHEME_DEPARTMENT ? departmentList : ROLE_TAG_OPTIONS[scheme];
  var layer2ValidTags = scheme === ROLE_SCHEME_SALON ? ROLE_TAG_OPTIONS.salon_leadership
    : scheme === ROLE_SCHEME_FNB ? ROLE_TAG_OPTIONS.fnb
    : scheme === ROLE_SCHEME_DEPARTMENT ? departmentList : null; // null: office/flat Layer 2 isn't tag-grouped, nothing to go stale against
  var peopleMap = readPeopleMap_();
  var layer1 = [], layer2 = [], layer3 = [];
  placements.forEach(function (p) {
    var person = resolvePerson_(p.employeeId, peopleMap);
    if (!person) return;
    person.layer = p.layer;
    if (p.layer === 1) layer1.push(person);
    else if (p.layer === 2) {
      if (layer2ValidTags && person.roleTag && layer2ValidTags.indexOf(person.roleTag) === -1) person.roleTag = '';
      layer2.push(person);
    } else {
      if (!person.roleTag || layer3ValidTags.indexOf(person.roleTag) === -1) {
        person.roleTag = scheme === ROLE_SCHEME_DEPARTMENT
          ? (departmentList.indexOf(person.department) !== -1 ? person.department : '')
          : classifyRoleTag_(person.position, scheme);
      }
      layer3.push(person);
    }
  });
  var byName = function (a, b) { return a.name.localeCompare(b.name); };
  layer1.sort(byName); layer2.sort(byName); layer3.sort(byName);

  // Chris (2026-09-19): whoever's on Layer 1 of Singapore F&B/Salon
  // Leadership should be on Layer 1 of EVERY matching outlet -- these ARE
  // the Area Managers/GMs overseeing all of them, not per-outlet management.
  // Layer 1 for an fnb/salon outlet is therefore a live MIRROR of that
  // Leadership page's own Layer 1 (never this outlet's own placements,
  // which is why the loop above still collects them into `layer1` but this
  // unconditionally replaces it below) -- edited only at the source, same
  // "auto-follow, edit elsewhere" principle as the outlet-leads rollup.
  // ROLE_SCHEME_FNB/ROLE_SCHEME_SALON happen to equal LEADERSHIP_PAGES'
  // 'fnb'/'salon' keys, so this lookup doubles as the scheme check.
  // An outlet can opt OUT of this mirror via Outlet Settings (isLayer1Manual_)
  // -- added 2026-09-23, per Chris: AiFOKATO/Tofu G outlets need a different
  // manager than the rest of F&B, so Layer 1 there goes back to being a
  // normal, directly-editable placement instead of following Suresh/Jim.
  var layer1Source = 'manual', layer1SourceTitle = '';
  var leadershipConfig = isLayer1Manual_(outletName) ? null : LEADERSHIP_PAGES[scheme];
  if (leadershipConfig) {
    var leadershipKey = outletKey_(leadershipConfig.outletName);
    layer1 = readAllPlacements_()
      .filter(function (p) { return outletKey_(p.outlet) === leadershipKey && p.layer === 1; })
      .map(function (p) { return resolvePerson_(p.employeeId, peopleMap); })
      .filter(Boolean);
    layer1.sort(byName);
    layer1Source = 'leadership';
    layer1SourceTitle = leadershipConfig.title;
  }

  return {
    outlet: outletName, layer1: layer1, layer2: layer2, layer3: layer3,
    roleScheme: scheme, roleTagOptions: scheme === ROLE_SCHEME_DEPARTMENT ? departmentList : ROLE_TAG_OPTIONS[scheme], layerLabels: LAYER_LABELS[scheme],
    layer3Mode: scheme === ROLE_SCHEME_FLAT ? 'flat' : 'split',
    layer1Source: layer1Source, layer1SourceTitle: layer1SourceTitle,
    // Outlet In-Charge (Layer 2) itself gets a tag for fnb and salon outlets
    // -- the F&B/Salon Leadership overviews' rollups group every outlet's
    // Outlet In-Charge by this tag (FOH/BOH, or Reception Lead/Service
    // Provider Lead) instead of one box per outlet, and that needs each one
    // tagged at the source (here, on the outlet's own page) since it's never
    // auto-classified. Office-scheme outlets have no equivalent leadership
    // rollup, so no tag options there.
    // Department-scheme outlets tag Layer 2 (Department Lead) by department
    // too -- per Chris 2026-09-23, so each department column can show its
    // own lead(s), same "⋯" menu mechanism fnb/salon already use, never
    // auto-classified (same as those two).
    layer2RoleTagOptions: scheme === ROLE_SCHEME_SALON ? ROLE_TAG_OPTIONS.salon_leadership : (scheme === ROLE_SCHEME_FNB ? ROLE_TAG_OPTIONS.fnb : (scheme === ROLE_SCHEME_DEPARTMENT ? departmentList : [])),
    syncSummary: buildSyncSummary_(reconcileResult),
  };
}

// ---------------------------------------------------------------------
// Add employee -- search existing (Mastersheet + manual people already in
// the org chart), or create a brand-new manual person (for the top
// management tracked in a Mastersheet Chris doesn't have access to).
// ---------------------------------------------------------------------

/** Top ~25 matches by name/nickname/position across BOTH Mastersheet and already-known manual people. */
function apiSearchPeople(query) {
  var q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  var results = [];

  readMastersheetEmployees_().forEach(function (e) {
    if (e.status !== 'active') return;
    var blob = (e.name + ' ' + e.nickname + ' ' + e.position + ' ' + e.location).toLowerCase();
    if (blob.indexOf(q) !== -1) results.push({ id: e.id, name: e.name, nickname: e.nickname, position: e.position, location: e.location, source: 'mastersheet' });
  });

  var peopleMap = readPeopleMap_();
  Object.keys(peopleMap).forEach(function (id) {
    var p = peopleMap[id];
    if (p.source !== 'manual') return;
    var blob = (p.name + ' ' + p.nickname + ' ' + p.position).toLowerCase();
    if (blob.indexOf(q) !== -1) results.push({ id: id, name: p.name, nickname: p.nickname, position: p.position, location: '', source: 'manual' });
  });

  return results.slice(0, 25);
}

/** Places an EXISTING person (found via apiSearchPeople) onto an outlet's layer. */
/**
 * roleTag is optional -- set in the SAME call (one round trip) instead of a
 * separate apiSetRoleTag call afterward, so the client can build the new
 * card locally without a second server hit. Returns the fully-resolved
 * person (same shape apiGetOutletDetail already returns per-person) so the
 * client can push it directly into state and locally re-render instead of
 * a full reloadCurrentView() -- confirmed live 2026-09-23: reloading the
 * whole outlet just to add one person meant re-fetching and re-downloading
 * every already-loaded photo on the page too, the same class of slowness
 * already fixed for move/tag actions (see rerenderCurrentView()).
 */
function apiAddPlacement(employeeId, outlet, layer, roleTag) {
  requireAdmin_();
  // An explicit, deliberate placement -- never auto-relocated later, even if it's Layer 3.
  upsertPlacement_(employeeId, outlet, Number(layer), PLACEMENT_SOURCE_MANUAL);
  if (roleTag) writePersonRow_(employeeId, { roleTag: roleTag });
  var person = resolvePerson_(employeeId, readPeopleMap_());
  if (person) person.layer = Number(layer);
  return person;
}

/** Creates a brand-new manual person (no Mastersheet row) and places them in one step. roleTag optional, same reasoning as apiAddPlacement -- returns the fully-resolved person for a local re-render, not just the new id. */
function apiCreateManualPerson(name, nickname, position, outlet, layer, roleTag) {
  requireAdmin_();
  name = String(name || '').trim();
  if (!name) throw new Error('Name is required.');
  var id = newManualId_();
  writePersonRow_(id, { source: 'manual', name: name, nickname: String(nickname || '').trim(), position: String(position || '').trim(), roleTag: roleTag || '' });
  upsertPlacement_(id, outlet, Number(layer), PLACEMENT_SOURCE_MANUAL);
  var person = resolvePerson_(id, readPeopleMap_());
  if (person) person.layer = Number(layer);
  return person;
}

/** Removes someone from one outlet's chart (their Mastersheet row/People profile is untouched). */
function apiRemovePlacement(employeeId, outlet) {
  requireAdmin_();
  return removePlacement_(employeeId, outlet);
}

/**
 * Fully deletes a manually-added person: every placement they're on (any
 * outlet, any leadership page), their uploaded photo (trashed, not
 * permanently destroyed -- recoverable from Drive trash), and their row in
 * the People sheet. ONLY for manual profiles -- a Mastersheet-sourced person
 * has no "delete" concept here at all, since the org chart never owns their
 * facts; "Remove from this outlet" (a single placement) is the right action
 * for them. Exists for exactly the case Chris hit: accidentally creating the
 * same manual person two or three times over instead of finding the
 * already-added one via search.
 */
function apiDeletePerson(employeeId) {
  requireAdmin_();
  var peopleMap = readPeopleMap_();
  var person = peopleMap[employeeId];
  if (!person || person.source !== 'manual') {
    throw new Error('Only a manually-added person can be deleted this way.');
  }
  removeAllPlacementsForPerson_(employeeId);
  if (person.photoFileId) {
    try { driveTrashFile_(person.photoFileId); } catch (e) { /* stale id -- fine to skip, nothing left to clean up */ }
  }
  getPeopleSheet_().deleteRow(person.rowNumber);
  invalidatePeopleMapCache_();
  return true;
}

/**
 * TEMPORARY (2026-09-19): surfaces every group of manually-added people who
 * share the same name (normalized: trimmed, collapsed whitespace, case-
 * insensitive) -- built so Chris can find and clean up accidental duplicate
 * profiles (e.g. clicking "+ Create a new person" instead of finding the
 * one already added) from one place, rather than hunting across every
 * outlet/leadership page they might be scattered across. Each entry
 * includes where that specific copy is currently placed, so Chris can tell
 * them apart before deleting. Remove this function, apiDeletePerson's
 * temporary caller (the "Find duplicate profiles" button and its view) once
 * Chris confirms he's done cleaning up -- apiDeletePerson itself stays
 * permanently, only this finder is meant to be temporary.
 */
/**
 * TEMPORARY one-shot cleanup for the wrong-photo bug in deployment @52
 * (2026-09-21): P-file photo matching briefly matched by file TYPE (any
 * image in the "04. PERSONAL INFORMATION" folder) instead of by name,
 * which could pick up an ID/passport scan or other non-photo image instead
 * of the actual photo, and PERSIST that wrong fileId into the People sheet.
 * Checks every person with a saved Photo File ID against that Drive file's
 * CURRENT name; anyone whose file name does NOT contain "photo"
 * (case-insensitive) almost certainly isn't a real photo -- every
 * legitimate source (a genuine P-file photo, a CB-column migration, or a
 * manual upload) always has "Photo" somewhere in its filename by
 * convention -- so their Photo File ID is cleared (not the file itself,
 * just the reference) and they'll be re-resolved correctly, against the
 * fixed name-based matching, next time their avatar loads. Remove this
 * function and its button once Chris confirms the cleanup ran clean.
 */
function apiRepairWrongPfilePhotos() {
  requireAdmin_();
  var sheet = getPeopleSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return { checked: 0, cleared: 0, unverified: 0, names: [] };
  var values = sheet.getRange(2, 1, lastRow - 1, ORG_CHART_PEOPLE_HEADERS.length).getValues();
  var candidates = []; // {i (0-based row index into values), id, photoFileId}
  values.forEach(function (row, i) {
    var id = String(row[0] || '').trim();
    var photoFileId = row[5];
    if (id && photoFileId) candidates.push({ i: i, id: id, photoFileId: photoFileId });
  });
  if (!candidates.length) return { checked: 0, cleared: 0, unverified: 0, names: [] };

  // Chunked, not one giant fetchAll -- confirmed live 2026-09-21: firing all
  // 407 lookups in a single UrlFetchApp.fetchAll() call silently failed the
  // WHOLE batch (every response came back null), which then looked
  // identical to "everyone's photo is fine" (checked=407, cleared=0)
  // instead of "couldn't check anyone." This codebase's other fetchAll
  // batches (avatar thumbnails etc.) are confirmed working up to ~80
  // requests, so chunk well under that.
  var token = ScriptApp.getOAuthToken();
  var CHUNK = 50;
  var names = {}; // id -> name string, or null if the lookup itself failed
  for (var start = 0; start < candidates.length; start += CHUNK) {
    var chunk = candidates.slice(start, start + CHUNK);
    var requests = chunk.map(function (c) {
      return { url: 'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(c.photoFileId) + '?fields=name', headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true };
    });
    var responses;
    try { responses = UrlFetchApp.fetchAll(requests); } catch (e) { responses = null; }
    chunk.forEach(function (c, i) {
      var resp = responses && responses[i];
      if (resp && resp.getResponseCode() === 200) {
        try { names[c.id] = JSON.parse(resp.getContentText()).name || null; } catch (e) { names[c.id] = null; }
      } else {
        names[c.id] = null;
      }
    });
  }

  var clearedNames = [];
  var unverified = 0;
  var touched = false;
  candidates.forEach(function (c) {
    var name = names[c.id];
    if (!name) { unverified++; return; } // couldn't verify (request failed, or stale/deleted file) -- leave alone rather than guess
    if (name.toLowerCase().indexOf('photo') === -1) {
      values[c.i][5] = ''; // Photo File ID
      values[c.i][9] = new Date(); // Updated At
      values[c.i][10] = currentUserEmail_(); // Updated By
      clearedNames.push(c.id + ' (was "' + name + '")');
      touched = true;
    }
  });
  if (touched) sheet.getRange(2, 1, values.length, ORG_CHART_PEOPLE_HEADERS.length).setValues(values);
  invalidatePeopleMapCache_();
  return { checked: candidates.length, cleared: clearedNames.length, unverified: unverified, names: clearedNames };
}

/**
 * TEMPORARY one-shot cleanup for duplicate "Org Chart Photo" files that
 * accumulated across repeated migrations/uploads for the same person --
 * confirmed live 2026-09-21 (Solomon Nikko Aquino's P-file had 3 copies of
 * the same CB-migrated photo; the dedup-skip bug that caused it is fixed in
 * @55, but doesn't retroactively remove files already sitting there). Only
 * ever touches files whose name contains "Org Chart Photo" -- never a real
 * document (Application Form, Professional Photo, Passport, etc.) -- and
 * within that, only ever TRASHES (Drive.Files.update trashed:true --
 * recoverable from Drive Trash, never a permanent delete) a file that is
 * NOT the person's currently-referenced Photo File ID, so nothing actively
 * in use can ever be removed by this.
 *
 * Two passes: (1) every Mastersheet-sourced person's own P-file "04.
 * PERSONAL INFORMATION" subfolder (where the bug actually happened --
 * collisions there are only ever the SAME person's own old duplicates); (2)
 * the shared "Org Chart - Manually Added Profiles" folder (holds many
 * different people's files side by side, grouped by the [employeeId]
 * marker every file here carries, same technique as
 * findExistingMastersheetPhotoFileId_).
 */
function apiCleanupDuplicateOrgChartPhotos() {
  requireAdmin_();
  var peopleSheet = getPeopleSheet_();
  var lastRow = peopleSheet.getLastRow();
  var currentPhotoFileId = {}; // employeeId -> current Photo File ID
  var sourceById = {};
  if (lastRow >= 2) {
    var peopleValues = peopleSheet.getRange(2, 1, lastRow - 1, ORG_CHART_PEOPLE_HEADERS.length).getValues();
    peopleValues.forEach(function (row) {
      var id = String(row[0] || '').trim();
      var photoFileId = row[5];
      if (id && photoFileId) { currentPhotoFileId[id] = photoFileId; sourceById[id] = row[1]; }
    });
  }

  var token = ScriptApp.getOAuthToken();
  var CHUNK = 50; // stay well under fetchAll's practical limit -- see apiRepairWrongPfilePhotos
  var trashed = []; // {id, name}
  var trashRequests = []; // raw PATCH requests, fired in one final batch

  // --- Pass 1: individual P-file subfolders (Mastersheet-sourced people) ---
  var pfileCandidates = []; // {id, rowNumber}
  Object.keys(currentPhotoFileId).forEach(function (id) {
    if (sourceById[id] !== 'mastersheet') return;
    var ms = findMastersheetEmployeeById_(id);
    if (ms) pfileCandidates.push({ id: id, rowNumber: ms.rowNumber });
  });
  var folderMap = bulkResolvePfilePhotoFolders_(pfileCandidates.map(function (c) { return c.rowNumber; }));
  var withPhotoFolder = pfileCandidates.filter(function (c) { return folderMap[c.rowNumber] && folderMap[c.rowNumber].photoFolderId; });

  for (var start = 0; start < withPhotoFolder.length; start += CHUNK) {
    var chunk = withPhotoFolder.slice(start, start + CHUNK);
    var listRequests = chunk.map(function (c) {
      var q = "'" + folderMap[c.rowNumber].photoFolderId + "' in parents and trashed = false and name contains 'Org Chart Photo'";
      return {
        url: 'https://www.googleapis.com/drive/v3/files?q=' + encodeURIComponent(q) + '&fields=' + encodeURIComponent('files(id,name)') + '&pageSize=20',
        headers: { Authorization: 'Bearer ' + token },
        muteHttpExceptions: true,
      };
    });
    var listResponses;
    try { listResponses = UrlFetchApp.fetchAll(listRequests); } catch (e) { listResponses = null; }
    chunk.forEach(function (c, i) {
      var resp = listResponses && listResponses[i];
      if (!resp || resp.getResponseCode() !== 200) return;
      var files;
      try { files = JSON.parse(resp.getContentText()).files || []; } catch (e) { return; }
      files.forEach(function (f) {
        if (f.id === currentPhotoFileId[c.id]) return; // the one actually in use -- never touch
        trashed.push({ id: c.id, name: f.name });
        trashRequests.push(f.id);
      });
    });
  }

  // --- Pass 2: the shared manual-photos folder, grouped by [employeeId] marker ---
  var manualFolderId = null;
  try {
    var it = DriveApp.getFoldersByName(ORG_CHART_MANUAL_PHOTOS_FOLDER_NAME);
    if (it.hasNext()) manualFolderId = it.next().getId();
  } catch (e) { /* folder doesn't exist yet -- nothing to clean up here */ }
  if (manualFolderId) {
    var manualFiles = [];
    var pageToken = null;
    do {
      var listed = Drive.Files.list({
        q: "'" + manualFolderId + "' in parents and trashed = false",
        fields: 'nextPageToken,files(id,name)', pageSize: 1000, pageToken: pageToken || undefined,
      });
      manualFiles = manualFiles.concat(listed.files || []);
      pageToken = listed.nextPageToken;
    } while (pageToken);

    var byMarker = {}; // employeeId -> [{id,name}]
    manualFiles.forEach(function (f) {
      var m = /\[([^\]]+)\]/.exec(f.name || '');
      if (!m) return;
      var id = m[1];
      (byMarker[id] || (byMarker[id] = [])).push(f);
    });
    Object.keys(byMarker).forEach(function (id) {
      var group = byMarker[id];
      if (group.length < 2) return;
      group.forEach(function (f) {
        if (f.id === currentPhotoFileId[id]) return; // in use -- never touch
        trashed.push({ id: id, name: f.name });
        trashRequests.push(f.id);
      });
    });
  }

  // --- Trash everything found, batched ---
  var trashedCount = 0;
  for (var t = 0; t < trashRequests.length; t += CHUNK) {
    var idsChunk = trashRequests.slice(t, t + CHUNK);
    var patchRequests = idsChunk.map(function (fileId) {
      return {
        url: 'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(fileId),
        method: 'patch',
        contentType: 'application/json',
        headers: { Authorization: 'Bearer ' + token },
        payload: JSON.stringify({ trashed: true }),
        muteHttpExceptions: true,
      };
    });
    var patchResponses;
    try { patchResponses = UrlFetchApp.fetchAll(patchRequests); } catch (e) { patchResponses = null; }
    (patchResponses || []).forEach(function (resp) {
      if (resp && resp.getResponseCode() === 200) trashedCount++;
    });
  }

  return {
    scanned: withPhotoFolder.length,
    found: trashed.length,
    trashed: trashedCount,
    names: trashed.map(function (t) { return t.id + ' ("' + t.name + '")'; }),
  };
}

/**
 * TEMPORARY bulk-import tool for the ~130 people missing photos (Chris,
 * 2026-09-22). items: [{filename, mimeType, base64}] from the browser's
 * file picker. Each filename must contain the person's Employee ID (e.g.
 * "Ivy SGFT0531.jpeg") -- matched via regex, NEVER by name alone, given
 * everything this project has already been through today with wrong-photo
 * matching. For each match: uploads into their P-file "04. PERSONAL
 * INFORMATION" subfolder as "Professional Photo - <Full Name> - <Nickname>",
 * sets it as their active org-chart photo, and inserts the SAME image into
 * the Mastersheet's own "EMPLOYEE"S PHOTO" (CB) column -- same technique
 * PhotoBackfill.js already uses in production (SpreadsheetApp.newCellImage()
 * built from a URL; CellImageBuilder has no blob-based constructor, so this
 * requires briefly making just that ONE uploaded file link-viewable, not
 * the P-file folder or any other document in it).
 *
 * Also (Chris, 2026-09-22): if another Mastersheet row shares the exact
 * same Full Name AND Nick Name with a "P/T SUB" status, the SAME photo is
 * copied onto that row's CB cell too (reusing the same public URL -- no
 * second P-file upload, since a P/T Sub row doesn't get its own P-file).
 */
function apiBulkImportProfessionalPhotos(items) {
  requireAdmin_();
  var idPattern = /([A-Z]{2,4}\d{3,5})/;
  var results = [];

  (items || []).forEach(function (item) {
    var m = idPattern.exec(item.filename);
    if (!m) { results.push({ filename: item.filename, status: 'no_id_in_filename' }); return; }
    var employeeId = m[1];
    var ms = findAnyMastersheetRowById_(employeeId);
    if (!ms) { results.push({ filename: item.filename, employeeId: employeeId, status: 'employee_not_found' }); return; }

    try {
      var bytes = Utilities.base64Decode(item.base64);
      var targetBaseName = 'Professional Photo - ' + ms.name + (ms.nickname ? ' - ' + ms.nickname : '');
      var extension = guessExtensionFromMimeType_(item.mimeType) || '';
      var blob = Utilities.newBlob(bytes, item.mimeType, targetBaseName + extension);

      var pfileFolderId = resolvePfileFolderId_(ms.rowNumber);
      if (!pfileFolderId) { results.push({ filename: item.filename, employeeId: employeeId, name: ms.name, status: 'no_pfile_link' }); return; }
      var photoFolderId = findOrCreatePhotoSubfolder_(pfileFolderId, true);
      // Confirmed live 2026-09-22 (Ivy/Chen Yu Ning): this folder can
      // already hold a perfectly good photo under some OTHER name ("Latest
      // Photo - ...", etc.) -- report it rather than silently piling on
      // another file with no way for Chris to know it happened.
      var hadExistingPhoto = !!findExistingPhotoFileId_(photoFolderId);
      var uploaded = driveUploadBytes_(photoFolderId, blob.getName(), blob);

      writePersonRow_(employeeId, { source: 'mastersheet', photoFileId: uploaded.id });

      var cbResult = insertUploadedPhotoIntoMastersheetCb_(ms.rowNumber, uploaded.id);

      var siblingInfo = null;
      var sibling = findMastersheetPtSubSiblingRow_(ms.name, ms.nickname, ms.rowNumber);
      if (sibling) {
        var siblingCbResult = insertUploadedPhotoIntoMastersheetCb_(sibling.rowNumber, uploaded.id, cbResult.publicUrl);
        siblingInfo = { employeeId: sibling.employeeId, status: siblingCbResult.status };
      }

      results.push({
        filename: item.filename, employeeId: employeeId, name: ms.name, status: 'ok',
        cb: cbResult.status, sibling: siblingInfo, hadExistingPhoto: hadExistingPhoto,
      });
    } catch (e) {
      results.push({ filename: item.filename, employeeId: employeeId, status: 'error: ' + ((e && e.message) || e) });
    }
  });

  invalidatePeopleMapCache_();
  return results;
}

/**
 * Inserts an already-uploaded Drive photo into a specific Mastersheet row's
 * CB column -- same technique as PhotoBackfill.js's insertPhotoCellImage_.
 * Pass publicUrlOpt to reuse an already-shared file's URL (the P/T Sub
 * sibling case) instead of re-sharing the same file a second time.
 */
function insertUploadedPhotoIntoMastersheetCb_(rowNumber, fileId, publicUrlOpt) {
  try {
    var publicUrl = publicUrlOpt;
    if (!publicUrl) {
      DriveApp.getFileById(fileId).setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      // NOT uc?export=view -- confirmed live 2026-09-22 that format silently
      // failed to populate the cell (it serves an HTML preview page to a
      // non-browser fetch, not raw image bytes). Google's dedicated
      // thumbnail-proxy endpoint serves actual image bytes for a
      // link-shared Drive file, which is what CellImageBuilder needs.
      publicUrl = 'https://drive.google.com/thumbnail?id=' + fileId + '&sz=w1000';
    }
    var sheet = SpreadsheetApp.openById(CONFIG.MASTERSHEET_ID).getSheetByName(CONFIG.MASTERSHEET_TAB_NAME);
    var photoCol = getMastersheetSnapshot_().headers.indexOf(MASTERSHEET_EMPLOYEE_PHOTO_HEADER) + 1;
    if (photoCol <= 0) return { status: 'no_photo_column', publicUrl: publicUrl };
    var image = SpreadsheetApp.newCellImage().setSourceUrl(publicUrl).build();
    sheet.getRange(rowNumber, photoCol).setValue(image);
    return { status: 'ok', publicUrl: publicUrl };
  } catch (e) {
    return { status: 'failed: ' + ((e && e.message) || e), publicUrl: publicUrlOpt || null };
  }
}

/**
 * Finds a Mastersheet row by Employee ID regardless of status (resigned,
 * converted, P/T Sub, anything) -- unlike findMastersheetEmployeeById_,
 * which is backed by readMastersheetEmployees_()'s org-chart-only filtered
 * list (correct for the org chart itself, but wrong for admin tools like
 * the bulk photo importer and the P-file photo scanner, which need to
 * reach anyone with a real Mastersheet row). Confirmed live 2026-09-22:
 * "employee_not_found" for Dylia (SGPT0437) and Akram (SGPT0486) turned out
 * to mean "not currently active," not "doesn't exist" -- same root cause
 * already fixed once for apiScanAndUpdateExistingPfilePhotos.
 */
function findAnyMastersheetRowById_(employeeId) {
  var snapshot = getMastersheetSnapshot_();
  var headers = snapshot.headers, allValues = snapshot.allValues;
  for (var i = snapshot.headerRowNumber; i < allValues.length; i++) {
    var row = { headers: headers, values: allValues[i] };
    if (cell_(row, MASTERSHEET_EMPLOYEE_ID, 0) === employeeId) {
      return {
        id: employeeId, rowNumber: i + 1,
        name: cell_(row, MASTERSHEET_FULL_NAME, 0), nickname: cell_(row, MASTERSHEET_NICK_NAME, 0),
        status: cell_(row, MASTERSHEET_EMPLOYEE_STATUS, 0),
      };
    }
  }
  return null;
}

/**
 * Finds another Mastersheet row for the SAME real person (exact Full Name +
 * Nick Name match, case-insensitive) with a "P/T SUB" status -- these rows
 * don't get their own P-file, so their CB cell is the only place their
 * photo can live. Scans the full raw snapshot (not the filtered/excluded
 * employee list readMastersheetEmployees_ uses), since P/T SUB rows are
 * deliberately excluded from that list.
 */
function findMastersheetPtSubSiblingRow_(fullName, nickName, excludeRowNumber) {
  var snapshot = getMastersheetSnapshot_();
  var headers = snapshot.headers, allValues = snapshot.allValues;
  var targetName = String(fullName || '').trim().toUpperCase();
  var targetNick = String(nickName || '').trim().toUpperCase();
  if (!targetName) return null;

  for (var i = snapshot.headerRowNumber; i < allValues.length; i++) {
    var rowNumber = i + 1;
    if (rowNumber === excludeRowNumber) continue;
    var row = { headers: headers, values: allValues[i] };
    var rowName = cell_(row, MASTERSHEET_FULL_NAME, 0).toUpperCase();
    var rowNick = cell_(row, MASTERSHEET_NICK_NAME, 0).toUpperCase();
    var rowStatus = cell_(row, MASTERSHEET_EMPLOYEE_STATUS, 0).toUpperCase();
    if (rowName === targetName && rowNick === targetNick && rowStatus.indexOf('P/T SUB') !== -1) {
      return { rowNumber: rowNumber, employeeId: cell_(row, MASTERSHEET_EMPLOYEE_ID, 0) };
    }
  }
  return null;
}

/**
 * TEMPORARY tool for Chris's manual photo-import pass (2026-09-22): he's
 * finding that many people already have a usable "Professional Photo" (or
 * similar) sitting in their P-file that just never made it into the
 * Mastersheet's own CB column. Given a list of full names, this finds each
 * person's EXISTING P-file photo (same name-based match as the org chart's
 * own P-file-priority lookup) and pushes it into their CB cell -- it never
 * uploads anything new to the P-file, only reuses what's already there.
 *
 * Matching is deliberately conservative: exact full-name match only (plus a
 * couple of nickname-concatenation variants, since Chris's list looks like
 * it may have been copied from a display that shows nickname under full
 * name). Zero or multiple matches are reported, never guessed -- given
 * everything today already turned up about wrong-photo risk, silently
 * picking "close enough" here is not worth it.
 */
function apiScanAndUpdateExistingPfilePhotos(names) {
  requireAdmin_();
  // Scans EVERY raw Mastersheet row, not readMastersheetEmployees_()'s
  // filtered/active-only list -- confirmed live 2026-09-22: "De Asis Zyra
  // Mae" (RESIGNED) was invisible to the filtered list, so the scan
  // reported "not found" for someone who's very much in the Mastersheet.
  // Chris wants the CB column kept accurate regardless of current status.
  var snapshot = getMastersheetSnapshot_();
  var headers = snapshot.headers, allValues = snapshot.allValues;
  var byExactName = {}; // normalized full name -> [candidate]
  var byCombined = {}; // normalized "full name + nickname" or "nickname + full name" -> [candidate]

  function norm(s) { return String(s || '').replace(/\s+/g, ' ').trim().toUpperCase(); }
  function addTo(map, key, candidate) {
    if (!key) return;
    (map[key] || (map[key] = [])).push(candidate);
  }

  for (var i = snapshot.headerRowNumber; i < allValues.length; i++) {
    var row = { headers: headers, values: allValues[i] };
    var id = cell_(row, MASTERSHEET_EMPLOYEE_ID, 0);
    var fullName = cell_(row, MASTERSHEET_FULL_NAME, 0);
    if (!id || !fullName) continue;
    var candidate = {
      id: id, name: fullName, nickname: cell_(row, MASTERSHEET_NICK_NAME, 0),
      status: cell_(row, MASTERSHEET_EMPLOYEE_STATUS, 0), rowNumber: i + 1,
    };
    addTo(byExactName, norm(candidate.name), candidate);
    if (candidate.nickname) {
      addTo(byCombined, norm(candidate.name + ' ' + candidate.nickname), candidate);
      addTo(byCombined, norm(candidate.nickname + ' ' + candidate.name), candidate);
    }
  }

  var seen = {};
  var results = [];

  (names || []).forEach(function (rawName) {
    var name = String(rawName || '').trim();
    if (!name) return;
    var key = norm(name);
    if (seen[key]) return; // dedupe -- Chris's list had a couple of repeats
    seen[key] = true;

    var candidates = byExactName[key] || byCombined[key] || [];
    // De-dupe candidates by employeeId (same person could match both maps).
    var byId = {};
    candidates.forEach(function (c) { byId[c.id] = c; });
    var uniqueCandidates = Object.keys(byId).map(function (id) { return byId[id]; });

    if (!uniqueCandidates.length) { results.push({ input: name, status: 'not_found' }); return; }
    if (uniqueCandidates.length > 1) {
      // Confirmed live 2026-09-22 (Lee Seoen, Chai Hong En): the common
      // case for a duplicate name isn't two different people -- it's the
      // SAME person's old resigned/converted row plus their current one.
      // When exactly one candidate looks currently active, use that one
      // without asking; only report genuinely ambiguous when that's not
      // the case (0 or 2+ active-looking candidates).
      var activeish = uniqueCandidates.filter(function (c) {
        var s = String(c.status || '').trim().toUpperCase();
        return s && !ORG_CHART_EXCLUDED_STATUSES[s] && s.indexOf('RESIGNED') === -1;
      });
      if (activeish.length !== 1) {
        results.push({ input: name, status: 'ambiguous', candidates: uniqueCandidates.map(function (c) { return c.id + ' (' + c.name + ', ' + (c.status || 'no status') + ')'; }) });
        return;
      }
      uniqueCandidates = activeish;
    }

    var ms = uniqueCandidates[0];
    try {
      var pfileFolderId = resolvePfileFolderId_(ms.rowNumber);
      if (!pfileFolderId) { results.push({ input: name, employeeId: ms.id, name: ms.name, status: 'no_pfile_link' }); return; }
      var photoFolderId = findOrCreatePhotoSubfolder_(pfileFolderId, false);
      if (!photoFolderId) { results.push({ input: name, employeeId: ms.id, name: ms.name, status: 'no_photo_subfolder' }); return; }
      var existingFileId = findExistingPhotoFileId_(photoFolderId);
      if (!existingFileId) { results.push({ input: name, employeeId: ms.id, name: ms.name, status: 'no_existing_photo' }); return; }

      writePersonRow_(ms.id, { source: 'mastersheet', photoFileId: existingFileId });
      var cbResult = insertUploadedPhotoIntoMastersheetCb_(ms.rowNumber, existingFileId);

      var siblingInfo = null;
      var sibling = findMastersheetPtSubSiblingRow_(ms.name, ms.nickname, ms.rowNumber);
      if (sibling) {
        var siblingCbResult = insertUploadedPhotoIntoMastersheetCb_(sibling.rowNumber, existingFileId, cbResult.publicUrl);
        siblingInfo = { employeeId: sibling.employeeId, status: siblingCbResult.status };
      }

      results.push({ input: name, employeeId: ms.id, name: ms.name, status: 'ok', cb: cbResult.status, sibling: siblingInfo });
    } catch (e) {
      results.push({ input: name, employeeId: ms.id, name: ms.name, status: 'error: ' + ((e && e.message) || e) });
    }
  });

  invalidatePeopleMapCache_();
  return results;
}

function apiFindDuplicateManualProfiles() {
  requireAdmin_();
  var sheet = getPeopleSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  var values = sheet.getRange(2, 1, lastRow - 1, ORG_CHART_PEOPLE_HEADERS.length).getDisplayValues();

  var byName = {};
  values.forEach(function (row) {
    var id = String(row[0] || '').trim();
    var source = String(row[1] || '').trim();
    if (!id || source !== 'manual') return;
    var name = String(row[2] || '').trim();
    var key = name.toLowerCase().replace(/\s+/g, ' ');
    if (!key) return;
    (byName[key] = byName[key] || []).push({
      id: id, name: name, nickname: String(row[3] || '').trim(), position: String(row[4] || '').trim(),
      hasPhoto: !!String(row[5] || '').trim(),
    });
  });

  var placementsByEmployee = {};
  readAllPlacements_().forEach(function (p) {
    (placementsByEmployee[p.employeeId] = placementsByEmployee[p.employeeId] || []).push(p);
  });
  function friendlyOutletName(outlet) {
    var key = outletKey_(outlet);
    for (var k in LEADERSHIP_PAGES) {
      if (outletKey_(LEADERSHIP_PAGES[k].outletName) === key) return LEADERSHIP_PAGES[k].title;
    }
    return outlet;
  }
  var layerLabelWords = { 1: 'Layer 1', 2: 'Layer 2', 3: 'Layer 3' };

  var groups = [];
  Object.keys(byName).forEach(function (key) {
    var people = byName[key];
    if (people.length < 2) return;
    people.forEach(function (p) {
      p.placements = (placementsByEmployee[p.id] || []).map(function (pl) {
        return friendlyOutletName(pl.outlet) + ' (' + layerLabelWords[pl.layer] + ')';
      });
    });
    groups.push(people);
  });
  groups.sort(function (a, b) { return a[0].name.localeCompare(b[0].name); });
  return groups;
}

/** Moves someone to a different layer on the SAME outlet (e.g. promoting a Layer 3 person to Layer 2) -- a deliberate move, so it locks in as 'manual' and stops following the Mastersheet's LOCATION even if it's still Layer 3. */
function apiMoveLayer(employeeId, outlet, newLayer) {
  requireAdmin_();
  upsertPlacement_(employeeId, outlet, Number(newLayer), PLACEMENT_SOURCE_MANUAL);
  return true;
}

/** Manual FOH/BOH/Other override, for anyone classifyRoleTag_() couldn't confidently sort. */
function apiSetRoleTag(employeeId, roleTag) {
  requireAdmin_();
  writePersonRow_(employeeId, { roleTag: roleTag });
  return true;
}

// ---------------------------------------------------------------------
// Photos -- Mastersheet-sourced people: their P-file's "04. PERSONAL
// INFORMATION" subfolder (same one PfileCreation.js already files
// Typeform photos into). Manual people (no P-file at all): a dedicated
// Drive folder just for org-chart manual profiles.
// ---------------------------------------------------------------------

/** Single-row lookup, derived from the cached getPfileFolderIdMap_ -- no live read of its own. */
function resolvePfileFolderId_(rowNumber) {
  return getPfileFolderIdMap_()[rowNumber] || null;
}

/**
 * Bulk version of resolvePfileFolderId_ for many rows at once, also derived
 * from the cached getPfileFolderIdMap_ -- see that function for why this
 * used to be a live per-request (and sometimes per-call-site-duplicated)
 * getRichTextValues() scan of the whole P-file-link column, and no longer
 * is. Returns {rowNumber: folderId or null}.
 */
function bulkResolvePfileFolderIds_(rowNumbers) {
  var map = getPfileFolderIdMap_();
  var result = {};
  rowNumbers.forEach(function (rowNumber) { result[rowNumber] = map[rowNumber] || null; });
  return result;
}

function findOrCreatePhotoSubfolder_(pfileFolderId, createIfMissing) {
  var existing = driveFindChildFolder_(pfileFolderId, CONFIG.ORG_CHART_PHOTO_SUBFOLDER_NAME);
  if (existing) return existing.id;
  if (!createIfMissing) return null;
  return driveCreateFolder_(CONFIG.ORG_CHART_PHOTO_SUBFOLDER_NAME, pfileFolderId).id;
}

/**
 * Finds the photo sitting in someone's P-file "04. PERSONAL INFORMATION"
 * folder. Matched by name containing 'photo' (case-insensitive, covers
 * "Professional Photo"/"Formal Photo"/"Recent Photo"/"Casual Photo"/plain
 * "Photo"/"Org Chart Photo", every variant Chris has described). NOT
 * matched by file type alone -- tried that 2026-09-21 on the theory that
 * this folder only holds one image (the photo) alongside a fixed set of
 * PDFs, but Chris caught it live: the folder can ALSO hold other image
 * files (IC/passport scans, certificates, etc.), and matching "the most
 * recently modified image" pulled several of those into the org chart as
 * people's avatars -- a real wrong-photo bug, not just an edge case.
 *
 * Prefers "Professional Photo"/"Formal Photo" over any other match (e.g.
 * "Casual Photo") when a folder has both -- per Chris 2026-09-23, confirmed
 * some P-files (Lee Doo Kyu, Bryan Ang Jing Rong) hold both a professional
 * AND a casual photo, and picking by "most recently modified" alone could
 * pick either one somewhat arbitrarily. Falls back to any "photo" match
 * only when no professional/formal one exists.
 */
function findExistingPhotoFileId_(photoFolderId) {
  var preferred = Drive.Files.list({
    q: "'" + photoFolderId + "' in parents and trashed = false and (name contains 'professional photo' or name contains 'formal photo')",
    fields: 'files(id,name,modifiedTime)', pageSize: 10, orderBy: 'modifiedTime desc',
  });
  var preferredFiles = preferred.files || [];
  if (preferredFiles.length) return preferredFiles[0].id;

  var result = Drive.Files.list({
    q: "'" + photoFolderId + "' in parents and trashed = false and name contains 'photo'",
    fields: 'files(id,name,modifiedTime)', pageSize: 10, orderBy: 'modifiedTime desc',
  });
  var files = result.files || [];
  return files.length ? files[0].id : null;
}

function getOrCreateManualPhotosFolderId_() {
  var it = DriveApp.getFoldersByName(ORG_CHART_MANUAL_PHOTOS_FOLDER_NAME);
  if (it.hasNext()) return it.next().getId();
  return DriveApp.createFolder(ORG_CHART_MANUAL_PHOTOS_FOLDER_NAME).getId();
}

function blobToDataUrl_(blob) {
  return 'data:' + blob.getContentType() + ';base64,' + Utilities.base64Encode(blob.getBytes());
}

/** {dataUrl} or {dataUrl:null} -- never throws for "no photo yet", only for a genuinely broken setup. */
/**
 * Finds a photo that's ALREADY sitting in someone's P-file "04. PERSONAL
 * INFORMATION" subfolder (named like "Professional Photo - <name>", from
 * onboarding) -- no download, no upload, just a reference to the existing
 * file. Returns the file id, or null if there's no P-file link, no photo
 * subfolder, or no matching file there.
 */
function findPfilePhotoFileId_(rowNumber) {
  var pfileFolderId = resolvePfileFolderId_(rowNumber);
  if (!pfileFolderId) return null;
  var photoFolderId = findOrCreatePhotoSubfolder_(pfileFolderId, false);
  if (!photoFolderId) return null;
  return findExistingPhotoFileId_(photoFolderId);
}

/**
 * Bulk version of findPfilePhotoFileId_ -- the per-person version does TWO
 * live Drive.Files.list() calls each (subfolder lookup, then photo lookup
 * inside it), and calling it once per person inside apiGetPhotoDataUrls's
 * loop meant 2*N sequential round trips. Confirmed live 2026-09-21: on a
 * 64-person outlet this made first load WORSE than before the P-file-
 * priority feature existed (92-134s vs. the prior ~46-56s baseline),
 * because this path wasn't batched at all. Fixed the same way as the
 * CB-column downloads/uploads: raw Drive v3 files.list HTTP requests fired
 * through UrlFetchApp.fetchAll(), in two passes (subfolder lookup, then
 * photo lookup within whatever subfolders the first pass found -- the
 * second pass genuinely depends on the first's results, so it can't be
 * collapsed into one). items: [{id, rowNumber}]. Returns {id: fileId} for
 * whoever has one; ids with no P-file photo are simply absent.
 */
/**
 * One-time resolution of (Mastersheet row -> P-file folder -> "04. PERSONAL
 * INFORMATION" subfolder) for a whole batch of rows, shared by
 * bulkFindPfilePhotoFileIds_ (existing-photo lookup) AND
 * bulkMigratePhotoFromMastersheetColumn_ (upload destination) so the same
 * rows' P-file links and subfolders are only ever resolved ONCE per
 * apiGetPhotoDataUrls call. Confirmed live 2026-09-21: before this, both
 * functions independently called bulkResolvePfileFolderIds_'s full-column
 * getRichTextValues() read for the exact same rowNumbers -- one read taking
 * 4.5-8.7s, done TWICE in the same request. Returns
 * {rowNumber: {pfileFolderId, photoFolderId}} -- either may be null
 * (no P-file link at all, or a link but no subfolder created yet).
 */
function bulkResolvePfilePhotoFolders_(rowNumbers, timingOut) {
  var result = {};
  var t0 = Date.now();
  var pfileFolderIds = bulkResolvePfileFolderIds_(rowNumbers);
  if (timingOut) timingOut.resolveFolderMs = Date.now() - t0;

  rowNumbers.forEach(function (rn) { result[rn] = { pfileFolderId: pfileFolderIds[rn] || null, photoFolderId: null }; });
  var withFolder = rowNumbers.filter(function (rn) { return !!pfileFolderIds[rn]; });
  if (timingOut) timingOut.withFolderCount = withFolder.length;
  if (!withFolder.length) return result;

  var token = ScriptApp.getOAuthToken();
  var subfolderName = escapeDriveQueryValue_(CONFIG.ORG_CHART_PHOTO_SUBFOLDER_NAME);
  var subfolderRequests = withFolder.map(function (rn) {
    var q = "'" + pfileFolderIds[rn] + "' in parents and trashed = false and mimeType = '" + FOLDER_MIME_TYPE + "' and name = '" + subfolderName + "'";
    return {
      url: 'https://www.googleapis.com/drive/v3/files?q=' + encodeURIComponent(q) + '&fields=' + encodeURIComponent('files(id)') + '&pageSize=1',
      headers: { Authorization: 'Bearer ' + token },
      muteHttpExceptions: true,
    };
  });

  var t1 = Date.now();
  var subfolderResponses;
  try {
    subfolderResponses = UrlFetchApp.fetchAll(subfolderRequests);
  } catch (e) {
    if (timingOut) timingOut.subfolderFetchMs = Date.now() - t1;
    return result;
  }
  if (timingOut) timingOut.subfolderFetchMs = Date.now() - t1;

  withFolder.forEach(function (rn, i) {
    var resp = subfolderResponses[i];
    if (!resp || resp.getResponseCode() !== 200) return;
    try {
      var files = JSON.parse(resp.getContentText()).files || [];
      if (files.length) result[rn].photoFolderId = files[0].id;
    } catch (e) { /* leave null -- treat as no subfolder yet */ }
  });

  return result;
}

/**
 * Given a folderMap already resolved by bulkResolvePfilePhotoFolders_, finds
 * whichever items have an EXISTING photo file sitting in their P-file photo
 * subfolder -- pure Drive lookup, no Sheets read (that's folderMap's job,
 * done once by the caller). items: [{id, rowNumber}]. Returns {id: fileId}
 * for whoever has one.
 */
function bulkFindPfilePhotoFileIds_(items, folderMap, timingOut) {
  var result = {};
  var withPhotoFolder = items.filter(function (it) { return folderMap[it.rowNumber] && folderMap[it.rowNumber].photoFolderId; });
  if (timingOut) timingOut.withPhotoFolderCount = withPhotoFolder.length;
  if (!withPhotoFolder.length) return result;

  var token = ScriptApp.getOAuthToken();

  function runPass(candidates, query, msKey) {
    var t0 = Date.now();
    var requests = candidates.map(function (it) {
      var q = "'" + folderMap[it.rowNumber].photoFolderId + "' in parents and trashed = false" + query;
      return {
        url: 'https://www.googleapis.com/drive/v3/files?q=' + encodeURIComponent(q) + '&fields=' + encodeURIComponent('files(id,modifiedTime)') + '&orderBy=' + encodeURIComponent('modifiedTime desc') + '&pageSize=10',
        headers: { Authorization: 'Bearer ' + token },
        muteHttpExceptions: true,
      };
    });
    var responses;
    try {
      responses = UrlFetchApp.fetchAll(requests);
    } catch (e) {
      responses = null;
    }
    if (timingOut) timingOut[msKey] = Date.now() - t0;
    var stillNeeded = [];
    candidates.forEach(function (it, i) {
      var resp = responses && responses[i];
      var files = null;
      if (resp && resp.getResponseCode() === 200) {
        try { files = JSON.parse(resp.getContentText()).files || []; } catch (e) { files = null; }
      }
      if (files && files.length) result[it.id] = files[0].id;
      else stillNeeded.push(it);
    });
    return stillNeeded;
  }

  // Two passes, same priority as findExistingPhotoFileId_ (singular) -- per
  // Chris 2026-09-23: prefer "Professional Photo"/"Formal Photo" over any
  // other match (e.g. "Casual Photo") when a P-file has both, instead of
  // picking whichever was modified most recently. NOT by mimeType alone:
  // that matched ID/passport scans and other non-photo images also sitting
  // in this folder, a real wrong-photo bug caught live 2026-09-21.
  var stillNeedsGeneric = runPass(withPhotoFolder, " and (name contains 'professional photo' or name contains 'formal photo')", 'photoFetchPreferredMs');
  if (stillNeedsGeneric.length) runPass(stillNeedsGeneric, " and name contains 'photo'", 'photoFetchMs');

  return result;
}

function apiGetPhotoDataUrl(employeeId, peopleMapOpt) {
  var peopleMap = peopleMapOpt || readPeopleMap_();
  var override = peopleMap[employeeId];
  var photoFileId = override ? override.photoFileId : '';

  var ms = findMastersheetEmployeeById_(employeeId);
  // Prefer whatever's ALREADY sitting in the P-file over pulling a fresh
  // copy from the Mastersheet CB column and uploading a duplicate -- per
  // Chris 2026-09-21, most people already have a photo there from
  // onboarding, so this is both faster (no download+upload) and avoids
  // creating needless duplicate files.
  if (!photoFileId && ms) {
    var pfileFileId = findPfilePhotoFileId_(ms.rowNumber);
    if (pfileFileId) {
      writePersonRow_(employeeId, { source: 'mastersheet', photoFileId: pfileFileId });
      photoFileId = pfileFileId;
    }
  }
  if (!photoFileId && ms) photoFileId = migratePhotoFromMastersheetColumn_(employeeId, ms.rowNumber, ms.name);

  if (photoFileId) {
    try {
      return { dataUrl: blobToDataUrl_(DriveApp.getFileById(photoFileId).getBlob()) };
    } catch (err) { /* stale id -- fall through */ }
  }
  return { dataUrl: null };
}

/**
 * Batch version of apiGetPhotoDataUrl -- one round trip for a whole page of
 * avatars instead of one call per card, AND the actual Drive downloads are
 * batched too via UrlFetchApp.fetchAll(), which runs them concurrently
 * instead of one-at-a-time. That second part matters even after the id-list
 * caching fix: DriveApp.getFileById(id).getBlob() is still one network round
 * trip per photo, so 80 people fetched sequentially inside a single
 * execution was just as slow as 80 separate calls, only without the extra
 * per-call script-startup overhead. peopleMap is also read ONCE here and
 * shared across every id, instead of once per id.
 */
/**
 * One People-sheet read + one write for a whole batch of photoFileId
 * updates, instead of writePersonRow_'s one-read-one-write PER CALL -- see
 * bulkMigratePhotoFromMastersheetColumn_. items: [{id, photoFileId}].
 */
function bulkWritePersonPhotoFileIds_(items) {
  var byId = {};
  items.forEach(function (it) { byId[it.id] = it.photoFileId; });

  var sheet = getPeopleSheet_();
  var lastRow = sheet.getLastRow();
  var now = new Date(), user = currentUserEmail_();

  if (lastRow >= 2) {
    var values = sheet.getRange(2, 1, lastRow - 1, ORG_CHART_PEOPLE_HEADERS.length).getValues();
    var touched = false;
    values.forEach(function (row) {
      var id = String(row[0] || '').trim();
      if (id && byId.hasOwnProperty(id)) {
        row[5] = byId[id]; // Photo File ID
        row[9] = now; // Updated At
        row[10] = user; // Updated By
        delete byId[id];
        touched = true;
      }
    });
    if (touched) sheet.getRange(2, 1, values.length, ORG_CHART_PEOPLE_HEADERS.length).setValues(values);
  }

  var remainingIds = Object.keys(byId);
  if (remainingIds.length) {
    var appendRows = remainingIds.map(function (id) {
      return [id, 'mastersheet', '', '', '', byId[id], '', '', '', now, user];
    });
    sheet.getRange(sheet.getLastRow() + 1, 1, appendRows.length, ORG_CHART_PEOPLE_HEADERS.length).setValues(appendRows);
  }
  invalidatePeopleMapCache_();
}

/**
 * Uploads MANY files to Drive in one batch via raw multipart HTTP requests
 * through UrlFetchApp.fetchAll(), instead of DriveApp.createFile() (or the
 * Advanced Drive service's Files.create), which only ever creates ONE file
 * per call no matter how it's invoked -- see bulkMigratePhotoFromMastersheetColumn_
 * for why this matters. items: [{parentId, filename, blob}]. Returns an
 * array of file ids in the SAME order as items, null for any that failed.
 * Generic (no org-chart-specific logic) -- reusable elsewhere if another
 * bulk-upload need ever comes up.
 */
function bulkUploadBytesToDrive_(items) {
  var token = ScriptApp.getOAuthToken();
  var boundary = 'orgchartbulkupload';
  var requests = items.map(function (it) {
    var contentType = it.blob.getContentType() || 'application/octet-stream';
    var metadata = JSON.stringify({ name: it.filename, parents: [it.parentId] });
    var body = '--' + boundary + '\r\n' +
      'Content-Type: application/json; charset=UTF-8\r\n\r\n' + metadata + '\r\n' +
      '--' + boundary + '\r\n' +
      'Content-Type: ' + contentType + '\r\n' +
      'Content-Transfer-Encoding: base64\r\n\r\n' + Utilities.base64Encode(it.blob.getBytes()) + '\r\n' +
      '--' + boundary + '--';
    return {
      url: 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id',
      method: 'post',
      headers: { Authorization: 'Bearer ' + token },
      contentType: 'multipart/related; boundary=' + boundary,
      payload: body,
      muteHttpExceptions: true,
    };
  });

  var responses;
  try {
    responses = UrlFetchApp.fetchAll(requests);
  } catch (e) {
    return items.map(function () { return null; });
  }

  return responses.map(function (resp) {
    if (!resp || resp.getResponseCode() !== 200) return null;
    try {
      return JSON.parse(resp.getContentText()).id || null;
    } catch (e) {
      return null;
    }
  });
}

/**
 * Batched version of migratePhotoFromMastersheetColumn_ for many people at
 * once -- the one-at-a-time version (a live Drive.Files.list() PLUS a live
 * single-cell Sheets read PLUS a sequential UrlFetch PLUS a Drive upload
 * PLUS a full People-sheet read+write, ALL repeated per person) is exactly
 * why a 75-photo outlet took 41 SECONDS to load the first time (confirmed
 * live 2026-09-21). Batches the CB-cell reads (one bulk range read), the
 * image downloads (one UrlFetchApp.fetchAll), the Drive uploads (one more
 * UrlFetchApp.fetchAll via bulkUploadBytesToDrive_), and the People-sheet
 * write (one bulkWritePersonPhotoFileIds_ call) across the whole list.
 * items: [{id, rowNumber, name}]. Returns {id: photoFileId} for anyone
 * successfully migrated (omits anyone who couldn't be).
 */
/**
 * folderMap: the SAME (rowNumber -> {pfileFolderId, photoFolderId}) map the
 * caller already resolved once via bulkResolvePfilePhotoFolders_ -- passed
 * in instead of re-resolved here. Confirmed live 2026-09-21: this function
 * used to call bulkResolvePfileFolderIds_ itself, which meant the whole
 * P-file-link column's getRichTextValues() read (4.5-8.7s) ran a second
 * time in the same request, for the exact same rows bulkFindPfilePhotoFileIds_
 * had just resolved moments earlier.
 */
function bulkMigratePhotoFromMastersheetColumn_(items, folderMap) {
  var result = {};
  var photoRows = getMastersheetPhotoRows_();
  var toMigrate = items.filter(function (it) { return !!photoRows[it.rowNumber]; });
  if (!toMigrate.length) return result;

  var photoCol = getMastersheetSnapshot_().headers.indexOf(MASTERSHEET_EMPLOYEE_PHOTO_HEADER) + 1;
  if (photoCol <= 0) return result;

  var sheet = SpreadsheetApp.openById(CONFIG.MASTERSHEET_ID).getSheetByName(CONFIG.MASTERSHEET_TAB_NAME);
  // ONE bulk read of the WHOLE photo column, instead of one live read per
  // person. Sheet#getRangeList().getRanges() (the first version of this
  // fix) does NOT actually bulk-fetch values -- RangeList is a
  // write/formatting-oriented API (setBackground, clearFormat, etc.); each
  // .getValue() call on the ranges it returns is still its own live round
  // trip. Confirmed live 2026-09-21: that "batching" was illusory, and a
  // 53-photo outlet was still taking 46s. A single contiguous range read
  // covering the whole column (the same technique getMastersheetPhotoRows_
  // already uses to build its row-index) is the real fix -- one call
  // regardless of how many people need migrating.
  var lastRow = sheet.getLastRow();
  var colValues = lastRow > 0 ? sheet.getRange(1, photoCol, lastRow, 1).getValues() : [];

  var urlItems = []; // {item, url}
  toMigrate.forEach(function (it) {
    var cell = colValues[it.rowNumber - 1];
    var value = cell && cell[0];
    if (value && typeof value.getContentUrl === 'function') {
      var url = value.getContentUrl() || value.getUrl();
      if (url) urlItems.push({ item: it, url: url });
    }
  });
  if (!urlItems.length) return result;

  var fetchResponses;
  try {
    fetchResponses = UrlFetchApp.fetchAll(urlItems.map(function (u) { return { url: u.url, muteHttpExceptions: true }; }));
  } catch (e) {
    return result;
  }

  // Anyone whose P-file "04. PERSONAL INFORMATION" subfolder doesn't exist
  // yet (folderMap has a pfileFolderId but no photoFolderId) needs it
  // created -- batched via raw HTTP POST + fetchAll, same technique as the
  // uploads below, instead of one findOrCreatePhotoSubfolder_(..., true)
  // Drive.Files.list()+maybe-create call per person. Confirmed live
  // 2026-09-21: this per-person call was the dominant cost in cbMigration
  // (12-16s for just 10 people) even after every other step was batched.
  var needsCreate = [];
  var seenNeedsCreate = {};
  urlItems.forEach(function (u) {
    var f = folderMap[u.item.rowNumber];
    if (f && f.pfileFolderId && !f.photoFolderId && !seenNeedsCreate[u.item.rowNumber]) {
      seenNeedsCreate[u.item.rowNumber] = true;
      needsCreate.push(u.item.rowNumber);
    }
  });
  var createdFolderIds = {}; // rowNumber -> newly created photoFolderId
  if (needsCreate.length) {
    var token = ScriptApp.getOAuthToken();
    var createRequests = needsCreate.map(function (rowNumber) {
      return {
        url: 'https://www.googleapis.com/drive/v3/files?fields=id',
        method: 'post',
        contentType: 'application/json',
        headers: { Authorization: 'Bearer ' + token },
        payload: JSON.stringify({ name: CONFIG.ORG_CHART_PHOTO_SUBFOLDER_NAME, mimeType: FOLDER_MIME_TYPE, parents: [folderMap[rowNumber].pfileFolderId] }),
        muteHttpExceptions: true,
      };
    });
    var createResponses;
    try {
      createResponses = UrlFetchApp.fetchAll(createRequests);
    } catch (e) {
      createResponses = null;
    }
    needsCreate.forEach(function (rowNumber, i) {
      var resp = createResponses && createResponses[i];
      if (resp && resp.getResponseCode() === 200) {
        try { createdFolderIds[rowNumber] = JSON.parse(resp.getContentText()).id || null; } catch (e) { /* leave unset -- falls through to the manual folder below */ }
      }
    });
  }

  var manualFolderId = null; // resolved at most once, lazily, only if someone actually has no P-file link
  function destFolderIdFor(rowNumber) {
    var f = folderMap[rowNumber];
    if (f && f.photoFolderId) return f.photoFolderId;
    if (f && f.pfileFolderId) return createdFolderIds[rowNumber] || null;
    if (manualFolderId === null) manualFolderId = getOrCreateManualPhotosFolderId_();
    return manualFolderId;
  }

  // Resolve everyone's destination folder up front, then check ALL of them
  // (batched via fetchAll) for an existing copy BEFORE uploading anything --
  // including people going into their own P-file subfolder. That folder
  // can't collide between two DIFFERENT people, but it CAN already hold a
  // duplicate of the SAME person's photo from an earlier migration run (a
  // prior session, or after their photoFileId got cleared and this ran
  // again) -- confirmed live 2026-09-21: Solomon Nikko Aquino's P-file had
  // 3 duplicate "Org Chart Photo (from Mastersheet)" uploads accumulate
  // this way, because the old code deliberately skipped this check for any
  // P-file-subfolder destination on the (correct, but incomplete)
  // assumption that only cross-person collisions needed guarding against.
  var destByRowNumber = {};
  urlItems.forEach(function (u) { destByRowNumber[u.item.rowNumber] = destFolderIdFor(u.item.rowNumber); });
  var existingCheckItems = urlItems
    .filter(function (u) { return !!destByRowNumber[u.item.rowNumber]; })
    .map(function (u) { return { folderId: destByRowNumber[u.item.rowNumber], employeeId: u.item.id }; });
  var existingFileIds = bulkFindExistingMastersheetPhotoFileIds_(existingCheckItems);

  var toWrite = [];
  var uploadCandidates = []; // {item, blob, destFolderId, filename} -- anyone who needs an actual new Drive upload
  urlItems.forEach(function (u, i) {
    var resp = fetchResponses[i];
    if (!resp || resp.getResponseCode() !== 200) return;
    var blob = resp.getBlob();
    var destFolderId = destByRowNumber[u.item.rowNumber];
    if (!destFolderId) return; // couldn't resolve or create a destination -- skip rather than fail the whole batch
    var existingFileId = existingFileIds[u.item.id];
    if (existingFileId) {
      result[u.item.id] = existingFileId;
      toWrite.push({ id: u.item.id, photoFileId: existingFileId });
      return;
    }
    uploadCandidates.push({
      item: u.item, blob: blob, destFolderId: destFolderId,
      filename: (u.item.name || u.item.id) + ' - Org Chart Photo (from Mastersheet) [' + u.item.id + ']',
    });
  });

  // The remaining, genuinely unavoidable cost: DriveApp.createFile() (or the
  // Advanced Drive service) only ever creates ONE file per call, no matter
  // how it's invoked -- confirmed live 2026-09-21: even with every other
  // step batched, DRIM Gold's 53 sequential Drive uploads alone were still
  // costing ~25s (roughly 450ms each, Drive's own per-file create latency).
  // Fixed the same way as the download step: raw multipart HTTP requests
  // through UrlFetchApp.fetchAll() instead of one-at-a-time DriveApp calls.
  if (uploadCandidates.length) {
    var fileIds = bulkUploadBytesToDrive_(uploadCandidates.map(function (c) {
      return { parentId: c.destFolderId, filename: c.filename, blob: c.blob };
    }));
    uploadCandidates.forEach(function (c, i) {
      var fileId = fileIds[i];
      if (!fileId) return;
      result[c.item.id] = fileId;
      toWrite.push({ id: c.item.id, photoFileId: fileId });
    });
  }

  if (toWrite.length) bulkWritePersonPhotoFileIds_(toWrite);
  return result;
}

/**
 * Fetches SMALL avatar-sized images for a batch of Drive file ids, instead
 * of downloading + base64-encoding each full-resolution original -- the
 * real remaining bottleneck confirmed live 2026-09-21: P-file "Professional
 * Photo" originals average ~766KB (some several MB), and just the
 * base64-encoding step for 63 of them took 49s of a 61s total, even though
 * every avatar on the page renders as a 44px circle. Uses each file's own
 * Drive-generated thumbnailLink (pinned to a small size via its `=sNN`
 * suffix) instead of the raw file bytes -- a few KB instead of hundreds.
 * Falls back to the full original for any file Drive doesn't return a
 * thumbnail for (rare, but some file types/states have none). Both the
 * thumbnail-link lookup and the actual image fetches are batched via
 * UrlFetchApp.fetchAll(), same technique as everywhere else in this file --
 * one concurrent round trip per pass, not one per photo. Returns
 * {fileId: dataUrl|null}; fills `timing` if given.
 */
function bulkFetchAvatarDataUrls_(fileIds, timing) {
  var result = {};
  if (!fileIds.length) return result;
  var token = ScriptApp.getOAuthToken();

  var tMeta = Date.now();
  var metaRequests = fileIds.map(function (fileId) {
    return {
      url: 'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(fileId) + '?fields=thumbnailLink',
      headers: { Authorization: 'Bearer ' + token },
      muteHttpExceptions: true,
    };
  });
  var metaResponses;
  try {
    metaResponses = UrlFetchApp.fetchAll(metaRequests);
  } catch (e) {
    metaResponses = null;
  }
  if (timing) timing.thumbMetaMs = Date.now() - tMeta;

  var withThumb = []; // {fileId, url}
  var noThumb = [];
  fileIds.forEach(function (fileId, i) {
    var resp = metaResponses && metaResponses[i];
    var link = null;
    if (resp && resp.getResponseCode() === 200) {
      try { link = JSON.parse(resp.getContentText()).thumbnailLink || null; } catch (e) { /* fall through to noThumb */ }
    }
    if (link) {
      var resized = /=s\d+$/.test(link) ? link.replace(/=s\d+$/, '=s160') : link + '=s160';
      withThumb.push({ fileId: fileId, url: resized });
    } else {
      noThumb.push(fileId);
    }
  });
  if (timing) { timing.thumbFoundCount = withThumb.length; timing.thumbMissingCount = noThumb.length; }

  var totalThumbBytes = 0;
  if (withThumb.length) {
    var tThumb = Date.now();
    var thumbRequests = withThumb.map(function (w) {
      return { url: w.url, headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true };
    });
    var thumbResponses;
    try {
      thumbResponses = UrlFetchApp.fetchAll(thumbRequests);
    } catch (e) {
      thumbResponses = null;
    }
    if (timing) timing.thumbFetchMs = Date.now() - tThumb;
    withThumb.forEach(function (w, i) {
      var resp = thumbResponses && thumbResponses[i];
      if (resp && resp.getResponseCode() === 200) {
        var contentType = resp.getHeaders()['Content-Type'] || 'image/jpeg';
        var bytes = resp.getContent();
        totalThumbBytes += bytes.length;
        result[w.fileId] = 'data:' + contentType + ';base64,' + Utilities.base64Encode(bytes);
      } else {
        noThumb.push(w.fileId); // thumbnail fetch itself failed -- fall back to the original
      }
    });
  }
  if (timing) timing.totalThumbBytes = totalThumbBytes;

  if (noThumb.length) {
    var tFallback = Date.now();
    var fallbackRequests = noThumb.map(function (fileId) {
      return { url: 'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(fileId) + '?alt=media', headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true };
    });
    var fallbackResponses;
    try {
      fallbackResponses = UrlFetchApp.fetchAll(fallbackRequests);
    } catch (e) {
      fallbackResponses = null;
    }
    if (timing) { timing.fallbackFetchMs = Date.now() - tFallback; timing.fallbackCount = noThumb.length; }
    noThumb.forEach(function (fileId, i) {
      var resp = fallbackResponses && fallbackResponses[i];
      if (resp && resp.getResponseCode() === 200) {
        var contentType = resp.getHeaders()['Content-Type'] || 'image/jpeg';
        result[fileId] = 'data:' + contentType + ';base64,' + Utilities.base64Encode(resp.getContent());
      } else {
        result[fileId] = null;
      }
    });
  }

  return result;
}

/** TEMPORARY server-side timing breakdown -- see the _timing field on the return value. Remove once perf is confirmed good. */
function apiGetPhotoDataUrls(employeeIds) {
  var timing = {};
  var tStart = Date.now();
  var peopleMap = readPeopleMap_();
  timing.readPeopleMapMs = Date.now() - tStart;
  var result = {};
  var fastIds = [], fastFileIds = [];
  var needMigration = []; // {id, rowNumber, name}

  var tLoop = Date.now();
  (employeeIds || []).forEach(function (id) {
    var override = peopleMap[id];
    var photoFileId = override ? override.photoFileId : '';
    if (photoFileId) { fastIds.push(id); fastFileIds.push(photoFileId); return; }
    var ms = findMastersheetEmployeeById_(id);
    if (ms) needMigration.push({ id: id, rowNumber: ms.rowNumber, name: ms.name });
    else result[id] = { dataUrl: null };
  });
  timing.initialLoopMs = Date.now() - tLoop;

  if (needMigration.length) {
    // Prefer whatever's ALREADY in each person's P-file over pulling a
    // fresh copy from Mastersheet CB and uploading a duplicate -- per
    // Chris 2026-09-21. bulkFindPfilePhotoFileIds_ batches the Drive
    // lookups via UrlFetchApp.fetchAll() instead of looping
    // findPfilePhotoFileId_ per person -- the per-person version was tried
    // first and made first-load WORSE (92-134s for 64 people) than before
    // this feature existed, since it was 2 sequential live Drive.Files.list()
    // calls per person.
    timing.needMigrationCount = needMigration.length;
    var tFolders = Date.now();
    var folderTiming = {};
    var folderMap = bulkResolvePfilePhotoFolders_(needMigration.map(function (it) { return it.rowNumber; }), folderTiming);
    timing.folderResolveMs = Date.now() - tFolders;
    timing.folderResolveDetail = folderTiming;

    var tPfile = Date.now();
    var pfileTiming = {};
    var pfileFound = bulkFindPfilePhotoFileIds_(needMigration.map(function (it) { return { id: it.id, rowNumber: it.rowNumber }; }), folderMap, pfileTiming);
    timing.pfileLookupMs = Date.now() - tPfile;
    timing.pfileLookupDetail = pfileTiming;
    var stillNeedsCbMigration = [];
    var pfileWrites = [];
    needMigration.forEach(function (it) {
      var pfileFileId = pfileFound[it.id];
      if (pfileFileId) {
        fastIds.push(it.id); fastFileIds.push(pfileFileId);
        pfileWrites.push({ id: it.id, photoFileId: pfileFileId });
      } else {
        stillNeedsCbMigration.push(it);
      }
    });
    timing.pfileFoundCount = pfileWrites.length;
    if (pfileWrites.length) bulkWritePersonPhotoFileIds_(pfileWrites);

    if (stillNeedsCbMigration.length) {
      var tCb = Date.now();
      var migrated = bulkMigratePhotoFromMastersheetColumn_(stillNeedsCbMigration, folderMap);
      timing.cbMigrationMs = Date.now() - tCb;
      timing.cbMigrationCount = stillNeedsCbMigration.length;
      stillNeedsCbMigration.forEach(function (it) {
        if (migrated[it.id]) { fastIds.push(it.id); fastFileIds.push(migrated[it.id]); }
        else result[it.id] = { dataUrl: null };
      });
    }
  }

  if (fastFileIds.length) {
    var avatarTiming = {};
    var uniqueFileIds = [];
    var seenFileIds = {};
    fastFileIds.forEach(function (fileId) {
      if (!seenFileIds[fileId]) { seenFileIds[fileId] = true; uniqueFileIds.push(fileId); }
    });
    var dataUrlByFileId = bulkFetchAvatarDataUrls_(uniqueFileIds, avatarTiming);
    timing.avatarFetch = avatarTiming;
    for (var i = 0; i < fastIds.length; i++) {
      result[fastIds[i]] = { dataUrl: dataUrlByFileId[fastFileIds[i]] || null };
    }
  }
  timing.totalMs = Date.now() - tStart;
  result._timing = timing;
  return result;
}

/** Uploads a manually-supplied photo (base64 from an <input type=file>) for ANY person, Mastersheet-sourced or manual. */
function apiUploadPhoto(employeeId, base64Data, mimeType) {
  requireAdmin_();
  var peopleMap = readPeopleMap_();
  var override = peopleMap[employeeId];
  var ms = findMastersheetEmployeeById_(employeeId);
  var name = ms ? ms.name : (override ? override.name : employeeId);

  var bytes = Utilities.base64Decode(base64Data);
  var extension = guessExtensionFromMimeType_(mimeType) || '';
  // The [employeeId] marker keeps every photo unambiguously traceable to
  // its person, especially in the shared manual-photos folder where many
  // different people's files sit side by side -- see
  // findExistingMastersheetPhotoFileId_ for why that matters.
  var blob = Utilities.newBlob(bytes, mimeType, name + ' - Org Chart Photo [' + employeeId + ']' + extension);

  // Try the person's real P-file folder first; fall back to the shared
  // manual-profiles folder whenever there's no P-file link to resolve
  // (rather than erroring -- a photo should never be blocked on that).
  var destFolderId = null;
  if (ms) {
    var pfileFolderId = resolvePfileFolderId_(ms.rowNumber);
    if (pfileFolderId) destFolderId = findOrCreatePhotoSubfolder_(pfileFolderId, true);
  }
  if (!destFolderId) destFolderId = getOrCreateManualPhotosFolderId_();

  var created = driveUploadBytes_(destFolderId, blob.getName(), blob);
  writePersonRow_(employeeId, { source: ms ? 'mastersheet' : 'manual', photoFileId: created.id });
  return { dataUrl: blobToDataUrl_(blob) };
}

/**
 * Clears a person's photo back to initials -- for when a photo turns out to
 * be flat-out wrong. Doesn't delete the Drive file itself (harmless
 * leftover, not worth the risk of deleting something still referenced
 * elsewhere) -- just clears the People-sheet override. Safe to use on
 * anyone, whatever the photo's original source.
 */
function apiClearPhoto(employeeId) {
  requireAdmin_();
  writePersonRow_(employeeId, { photoFileId: '' });
  return true;
}
