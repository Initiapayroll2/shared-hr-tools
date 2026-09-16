/**
 * F&B PT Onboarding Portal
 * Shows each PIC only the onboarding status rows for their own outlet(s).
 *
 * SIGN-IN: this deployment runs "Execute as: Me" (the developer), not "User
 * accessing the web app". Under "User accessing the web app", Apps Script makes
 * every visitor grant this project's own permissions - whatever scopes the code
 * uses, e.g. PropertiesService/CacheService/UrlFetchApp - before they can see
 * anything, via a grey, native "(Unverified)" Apps Script screen. That screen
 * shows once per visitor and is unavoidable under that mode no matter how
 * minimal the scopes are - it's not related to whether the OAuth consent
 * screen itself is published/verified. Under "Execute as: Me", only the
 * developer's own authorization ever matters, so instead visitors go through a
 * real "Sign in with Google" button - a normal OAuth 2.0 flow using a separate
 * "Portal Sign-In" OAuth client (not Apps Script's own auto-managed one) - that
 * just proves who they are, no permission grant at all. See doGet/signInPage_/
 * exchangeCodeForEmail_ below. Because visitors never get an implicit Apps
 * Script identity this way, this project can't rely on Session.getActiveUser()
 * - every admin/viewer check below takes an explicit, HMAC-signed session token
 * instead (see signSession_/verifySession_), threaded from doGet's URL through
 * to every google.script.run call the client makes.
 * The sign-in link opens in a new tab (target="_blank"), not the same tab -
 * Apps Script's HtmlService always serves this project's output inside its own
 * sandboxed iframe, which is deliberately not granted allow-top-navigation, so
 * a same-tab redirect back to a clean URL after Google's OAuth callback isn't
 * possible here; doGet renders the dashboard directly in that new tab instead
 * once the code exchange succeeds, rather than trying to bounce anywhere else.
 *
 * This project deliberately contains NO ClickUp-polling/trigger code
 * (ScriptApp.newTrigger). That's a second, separate Apps Script project - the
 * "ClickUp Fetcher" - which nobody but the owner ever opens: it polls ClickUp
 * every minute and pushes the result here (see pushData below), authenticated
 * by a shared secret. The push itself goes through Apps Script's Library
 * mechanism (Fetcher adds this project as a library and calls pushData(...)
 * directly), not an HTTP webhook - this Workspace domain's web app deployments
 * reject every server-to-server call regardless of access level ("Anyone with a
 * Google account" and "Only myself" were both tried) or Authorization token, so
 * a doPost-based push cannot work here at all. A library call is a plain
 * in-process function call, so there's no sign-in gate to fail.
 * The dashboard (stat cards, by-outlet, by-status, table) re-renders entirely
 * client-side when the outlet filter changes - no page reload. The header's
 * "Refresh" button works the same way, via getDashboardData(token) - this is
 * deliberate, not just a nicety: a real browser reload would resend this
 * tab's URL, which (per the SIGN-IN note above) still carries the original
 * one-time OAuth "code" from sign-in, and Google always rejects a reused
 * code. So a real reload eventually fails with "Sign-in failed" and forces
 * the visitor to log in again - e.g. right after an Admin adds them a new
 * outlet and asks them to refresh. The in-page Refresh button re-fetches
 * fresh rows for the same session without ever reloading the page, so that
 * never happens.
 *
 * SETUP:
 * 1. Script Properties (Project Settings > Script Properties):
 *    PUSH_SECRET         = a long random string, must match the Fetcher
 *                          project's own PUSH_SECRET exactly - it's how
 *                          pushData knows a call actually came from it.
 *    OAUTH_CLIENT_ID     = the "Portal Sign-In" OAuth client's Client ID.
 *    OAUTH_CLIENT_SECRET = ...its Client secret.
 *                          (Google Cloud Console > APIs & Services / Google
 *                          Auth Platform > Clients > Create client > Web
 *                          application, with an Authorized redirect URI equal
 *                          to this deployment's exec URL, exactly.)
 *    SESSION_SECRET is generated automatically the first time anyone signs in -
 *    never set it by hand, and never reset it while anyone might have a live
 *    session (it immediately invalidates every signed-in visitor).
 *    (ADMINS, VIEWERS, PIC_MAPPINGS and OUTLET_CATEGORIES are all created/managed
 *    automatically by the in-portal "Manage Access" panel below - no manual setup.)
 * 2. Deploy > New deployment > Web app (for human visitors).
 *    - Execute as: Me
 *    - Who has access: Anyone
 *    (This project's own doGet enforces sign-in itself - see SIGN-IN above - so
 *    the deployment-level access setting is deliberately wide open; Google no
 *    longer gates the raw URL at all, this script's own code does.)
 *    Also: Deploy > New deployment > Library (for the Fetcher to call pushData).
 *    Note this deployment's Script ID and version.
 * 3. In the Fetcher project, add this project as a library (using the Script ID
 *    and version from step 2), then run ensureRefreshTrigger_() once there to
 *    start the 1-minute background push, and refreshAndPush_() once immediately
 *    after so this cache isn't empty before the first trigger fires.
 * 4. Share the deployment URL. Add each PIC/Viewer/Admin via the in-portal "Manage Access"
 *    panel (Admins only). There is deliberately no Google Sheet involved anywhere in
 *    this project: who-has-access-to-what is sensitive (it shows every PIC's outlet
 *    assignment), and a Sheet is a Drive file - shareable, findable, exportable. It's
 *    stored instead in this script's own Properties Service, which isn't a Drive object
 *    at all, so there's nothing for a PIC to ever find in their Drive, regardless of any
 *    sharing setting. No PIC needs, or gets, any Drive/Sheet permission at any point.
 *
 * ROLES:
 *    Super Admin - sees every outlet in every country. Only role that can manage
 *                  Admins/Viewers, and the only one who can open the separate
 *                  "Manage Outlet Categories" panel.
 *    SG/MY Admin - a country-scoped Admin: sees and manages PICs for their own
 *                  country only. Cannot see the other country, Admins, Viewers, or
 *                  outlet categories - "Manage Access" for them shows just their
 *                  own country's PIC section.
 *    Viewer      - read-only, no Manage Access button. Scope 'all' ("Super Viewer")
 *                  sees everything a Super Admin sees; 'fnb'/'salon'/'others'/
 *                  'group_management' sees only outlets tagged with that category in
 *                  OUTLET_CATEGORIES. A country with none of its outlets tagged for
 *                  that scope simply doesn't show up for that Viewer, rather than
 *                  showing it unfiltered.
 *    PIC         - sees only their explicitly assigned outlet(s), as before.
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

// Category an outlet can be tagged with (the "Manage Outlet Categories" panel,
// OUTLET_CATEGORIES) - kept independent of the Viewer *scopes* below, which
// reuse these same four names as cross-country scopes, plus eight per-country
// variants, so this list must never be derived from VALID_SCOPES (it used to
// be, which would silently let the per-country scopes below be tagged onto an
// outlet as if they were categories).
var VALID_CATEGORIES = ['fnb', 'salon', 'others', 'group_management'];
var CATEGORY_LABELS = { fnb: 'F&B', salon: 'Salon', others: 'Others', group_management: 'Group Management' };

// Viewer scopes: 'all' ("Super Viewer") sees every outlet in both countries, unfiltered.
// 'SG'/'MY' ("SG Viewer"/"MY Viewer") sees every outlet in just that one country,
// unfiltered - a country-scoped Admin can grant only their own country's flavor of
// this (see requireViewerScopePermission_ below). 'fnb'/'salon'/'others'/
// 'group_management' are category scopes that cut across both countries, depending
// on OUTLET_CATEGORIES being set per outlet - see getOutletCategories_/
// saveOutletCategories_. The eight "<country>_<category>" scopes (e.g. "SG_fnb" =
// "SG F&B only") are the same category filter restricted to a single country - an
// "SG F&B only" Viewer never sees Malaysia's F&B outlets, even if some are tagged.
// A country-scoped Admin can grant their own plain country scope or any of their
// own country's four compound scopes; the four cross-country category scopes stay
// Super-Admin-only to grant, same as the categories themselves (see
// requireViewerScopePermission_/viewerScopeAllowedForCountryAdmin_ below).
var VALID_SCOPES = [
  'all', 'SG', 'MY',
  'fnb', 'salon', 'others', 'group_management',
  'SG_fnb', 'SG_salon', 'SG_others', 'SG_group_management',
  'MY_fnb', 'MY_salon', 'MY_others', 'MY_group_management'
];
var VIEWER_COUNTRY_LABELS = { all: 'Super Viewer', SG: 'SG Viewer', MY: 'MY Viewer' };

// Human label for a category or country+category Viewer scope (e.g. "F&B",
// "SG · F&B") - never called for 'all'/'SG'/'MY', which VIEWER_COUNTRY_LABELS
// covers instead.
function viewerScopeCategoryLabel_(scope) {
  var us = scope.indexOf('_');
  if (us === -1) return CATEGORY_LABELS[scope] || scope;
  var cc = scope.slice(0, us);
  var cat = scope.slice(us + 1);
  return cc + ' · ' + (CATEGORY_LABELS[cat] || cat);
}

// Admin scopes: 'super' manages both countries plus Admins/Viewers/outlet categories;
// 'SG'/'MY' is a country-scoped Admin, restricted to that country's own dashboard and
// PIC management only. See ADMINS storage note below for the on-disk shape.
var ADMIN_SCOPES = ['super', 'SG', 'MY'];
var ADMIN_ROLE_LABELS = { super: 'Super Admin', SG: 'SG Admin', MY: 'MY Admin' };

// Each country has its own outlet namespace - an outlet named e.g. "Modu K" in
// Singapore is a completely different outlet from one with the same name in
// Malaysia. So a PIC's access is always resolved within a single country's own
// stored mappings and own ClickUp list - never matched against another country's
// outlets or tasks.
function doGet(e) {
  var params = (e && e.parameter) || {};
  var execUrl = ScriptApp.getService().getUrl();

  // Google redirected back from the "Sign in with Google" button below with
  // either an auth code (success) or an error (denied/cancelled). This lands
  // in a NEW TAB (see signInPage_'s target="_blank" - Apps Script's sandboxed
  // iframe has no allow-top-navigation, so a same-tab redirect back to a clean
  // "?token=..." URL isn't possible here); render the dashboard directly in
  // that tab rather than trying to bounce anywhere else.
  if (params.code) {
    try {
      var newEmail = exchangeCodeForEmail_(params.code, execUrl);
      return renderDashboardOrError_(newEmail, signSession_(newEmail));
    } catch (err) {
      Logger.log('OAuth callback failed: ' + (err && err.message ? err.message : err));
      return signInPage_(execUrl, 'Sign-in failed. Please try again.');
    }
  }
  if (params.error) {
    return signInPage_(execUrl, 'Sign-in was cancelled. Please try again.');
  }

  // Normal page view - a browser that already completed sign-in carries its
  // session token in the URL (see renderShell_'s embedded SESSION_TOKEN).
  var email = params.token ? verifySession_(params.token) : null;
  if (!email) {
    return signInPage_(execUrl, null);
  }
  return renderDashboardOrError_(email, params.token);
}

function renderDashboardOrError_(email, token) {
  try {
    return doGetInner_(email, token);
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

// Shared by doGetInner_ (full page load) and getDashboardData (in-page Refresh
// button) so both compute a signed-in visitor's countries/rows identically.
// Returns { isAdmin, roleLabel, countries } on success, or { isAdmin, roleLabel,
// countries: null, noAccessHtml, noAccessMessage } when nothing is configured
// for them - noAccessHtml is the rich version for a full page render,
// noAccessMessage a plain-text equivalent for a thrown Error (Refresh path).
function computeDashboardCountries_(email) {
  var adminScope = getAdminCountryScope_(email); // 'super' | 'SG' | 'MY' | null
  var isAdmin = adminScope !== null;
  var viewerScope = isAdmin ? null : getViewerScope_(email);
  var roleLabel = adminScope ? ADMIN_ROLE_LABELS[adminScope]
    : (VIEWER_COUNTRY_LABELS[viewerScope] ? VIEWER_COUNTRY_LABELS[viewerScope]
    : (viewerScope ? 'Viewer \u00B7 ' + viewerScopeCategoryLabel_(viewerScope) : 'PIC'));
  var countries;

  if (adminScope === 'super' || viewerScope === 'all') {
    countries = COUNTRIES.map(function (c) {
      var rows = getClickUpTasks_(c);
      return {
        code: c.code,
        label: c.label,
        outletsLabel: c.label + (adminScope === 'super' ? ' (admin view)' : ' (all outlets)'),
        rows: rows,
        outlets: getOutletOptionsForCountry_(c)
      };
    });
  } else if (adminScope === 'SG' || adminScope === 'MY') {
    // Country-scoped Admin: full unfiltered view of their own country only, same
    // shape as the Super Admin branch above but a single country.
    var scopedCountry = COUNTRIES.filter(function (c) { return c.code === adminScope; })[0];
    countries = [{
      code: scopedCountry.code,
      label: scopedCountry.label,
      outletsLabel: scopedCountry.label + ' (' + ADMIN_ROLE_LABELS[adminScope] + ' view)',
      rows: getClickUpTasks_(scopedCountry),
      outlets: getOutletOptionsForCountry_(scopedCountry)
    }];
  } else if (viewerScope === 'SG' || viewerScope === 'MY') {
    // Country-scoped Viewer: full unfiltered read-only view of just this one country,
    // same shape as the country-scoped Admin branch above minus the Manage Access button.
    var viewerCountry = COUNTRIES.filter(function (c) { return c.code === viewerScope; })[0];
    countries = [{
      code: viewerCountry.code,
      label: viewerCountry.label,
      outletsLabel: viewerCountry.label + ' (all outlets)',
      rows: getClickUpTasks_(viewerCountry),
      outlets: getOutletOptionsForCountry_(viewerCountry)
    }];
  } else if (viewerScope && viewerScope.indexOf('_') !== -1) {
    // Country + category scoped Viewer (e.g. "SG_fnb" = "SG F&B only"): the same
    // category filter as the cross-country branch below, but restricted to just
    // this one country - an "SG F&B only" Viewer never sees Malaysia's F&B
    // outlets, even if some are tagged.
    var compoundSplit = viewerScope.indexOf('_');
    var compoundCC = viewerScope.slice(0, compoundSplit);
    var compoundCategory = viewerScope.slice(compoundSplit + 1);
    var compoundCountry = COUNTRIES.filter(function (c) { return c.code === compoundCC; })[0];
    var compoundCategories = getOutletCategories_();
    var compoundRows = compoundCountry ? getClickUpTasks_(compoundCountry).filter(function (t) {
      return getOutletCategoryFor_(compoundCategories, compoundCC, t.outlet) === compoundCategory;
    }) : [];
    if (!compoundCountry || compoundRows.length === 0) {
      var compoundCountryLabel = compoundCountry ? compoundCountry.label : compoundCC;
      return {
        isAdmin: isAdmin,
        roleLabel: roleLabel,
        countries: null,
        noAccessHtml: '<p>No ' + escapeHtml_(CATEGORY_LABELS[compoundCategory] || compoundCategory) + ' outlets found in ' + escapeHtml_(compoundCountryLabel) + ' for <b>' + escapeHtml_(email) + '</b> right now.</p>' +
          '<p>Contact HR if this looks wrong.</p>',
        noAccessMessage: 'No ' + (CATEGORY_LABELS[compoundCategory] || compoundCategory) + ' outlets found in ' + compoundCountryLabel + ' for ' + email + ' right now. Contact HR if this looks wrong.'
      };
    }
    countries = [{
      code: compoundCountry.code,
      label: compoundCountry.label,
      outletsLabel: compoundCountry.label + ' (' + (CATEGORY_LABELS[compoundCategory] || compoundCategory) + ')',
      rows: compoundRows,
      outlets: uniqueOutlets_(compoundRows)
    }];
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
      return {
        isAdmin: isAdmin,
        roleLabel: roleLabel,
        countries: null,
        noAccessHtml: '<p>No ' + escapeHtml_(CATEGORY_LABELS[viewerScope] || viewerScope) + ' outlets found for <b>' + escapeHtml_(email) + '</b> right now.</p>' +
          '<p>Contact HR if this looks wrong.</p>',
        noAccessMessage: 'No ' + (CATEGORY_LABELS[viewerScope] || viewerScope) + ' outlets found for ' + email + ' right now. Contact HR if this looks wrong.'
      };
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
      return {
        isAdmin: isAdmin,
        roleLabel: roleLabel,
        countries: null,
        noAccessHtml: '<p>No outlet is set up for <b>' + escapeHtml_(email) + '</b>.</p>' +
          '<p>Contact HR to be added to the onboarding portal.</p>',
        noAccessMessage: 'No outlet is set up for ' + email + '. Contact HR to be added to the onboarding portal.'
      };
    }
  }

  return { isAdmin: isAdmin, roleLabel: roleLabel, countries: countries };
}

function doGetInner_(email, token) {
  var result = computeDashboardCountries_(email);
  if (!result.countries) {
    return HtmlOutput_('No access configured', result.noAccessHtml);
  }
  return HtmlOutput_('Onboarding Status', renderShell_(result.countries, email, result.isAdmin, result.roleLabel, getLastSynced_(), token));
}

// ---- Sign-in: OAuth 2.0 "Sign in with Google" + a self-contained signed session token ----
// See the file header's SIGN-IN section for why this exists instead of
// Session.getActiveUser(). The token is stateless - email + expiry, HMAC-signed
// with a secret only this script knows - so the client can carry it (in the
// page URL, then in every google.script.run call) without this script needing
// to remember any session itself. 12 hours balances not re-prompting mid-shift
// against a lost/shared link going stale reasonably soon.

function signInPage_(execUrl, errorMessage) {
  var clientId = PropertiesService.getScriptProperties().getProperty('OAUTH_CLIENT_ID');
  var authUrl = 'https://accounts.google.com/o/oauth2/v2/auth'
    + '?client_id=' + encodeURIComponent(clientId)
    + '&redirect_uri=' + encodeURIComponent(execUrl)
    + '&response_type=code'
    + '&scope=' + encodeURIComponent('openid email')
    + '&prompt=select_account';
  var body = '' +
    '<div style="max-width:360px;margin:14vh auto 0;text-align:center;">' +
      '<h1 style="font-size:20px;margin:0 0 8px;">F&amp;B PT Onboarding Portal</h1>' +
      (errorMessage ? '<p style="color:#c0392b;font-size:13px;">' + escapeHtml_(errorMessage) + '</p>' : '') +
      '<p class="muted" style="margin-bottom:22px;">Sign in with your work Google account to continue.</p>' +
      '<a href="' + authUrl + '" target="_blank" style="display:inline-block;background:#1c1c1c;color:#fff;text-decoration:none;padding:10px 24px;border-radius:24px;font-size:14px;">Sign in with Google</a>' +
    '</div>';
  return HtmlOutput_('Sign in', body);
}

// Exchanges the OAuth code Google just redirected back with for the signed-in
// user's email - a server-to-server call using this project's own "Portal
// Sign-In" OAuth client (never the visitor's own credentials), so it runs
// under Execute-as-Me's authorization only, exactly like pushData/UrlFetchApp
// elsewhere in this file - no visitor ever grants this script anything.
function exchangeCodeForEmail_(code, execUrl) {
  var props = PropertiesService.getScriptProperties();
  var clientId = props.getProperty('OAUTH_CLIENT_ID');
  var clientSecret = props.getProperty('OAUTH_CLIENT_SECRET');
  if (!clientId || !clientSecret) throw new Error('OAUTH_CLIENT_ID/OAUTH_CLIENT_SECRET not configured.');

  var tokenResp = UrlFetchApp.fetch('https://oauth2.googleapis.com/token', {
    method: 'post',
    payload: {
      code: code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: execUrl,
      grant_type: 'authorization_code'
    },
    muteHttpExceptions: true
  });
  var tokenRaw = tokenResp.getContentText();
  var tokenData;
  try {
    tokenData = JSON.parse(tokenRaw);
  } catch (parseErr) {
    throw new Error('Token endpoint returned a non-JSON response (HTTP ' + tokenResp.getResponseCode() + ').');
  }
  if (!tokenData.access_token) {
    Logger.log('Token endpoint HTTP ' + tokenResp.getResponseCode() + ' redirect_uri=' + execUrl + ' body=' + tokenRaw);
    throw new Error('Token exchange failed: ' + (tokenData.error_description || tokenData.error || 'unknown error'));
  }

  var userResp = UrlFetchApp.fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: 'Bearer ' + tokenData.access_token },
    muteHttpExceptions: true
  });
  var userData = JSON.parse(userResp.getContentText());
  if (!userData.email || userData.email_verified === false) {
    throw new Error('Could not verify a Google account email.');
  }
  return userData.email;
}

// Generated on first use and persisted - never hardcoded, never shared with the
// Fetcher project (unlike PUSH_SECRET, this one has nothing to match against).
function getSessionSecret_() {
  var props = PropertiesService.getScriptProperties();
  var secret = props.getProperty('SESSION_SECRET');
  if (!secret) {
    secret = Utilities.getUuid() + Utilities.getUuid();
    props.setProperty('SESSION_SECRET', secret);
  }
  return secret;
}

function hmacHex_(payload) {
  return Utilities.computeHmacSha256Signature(payload, getSessionSecret_())
    .map(function (b) { return ('0' + (b & 0xFF).toString(16)).slice(-2); })
    .join('');
}

function signSession_(email) {
  var expiry = Math.floor(Date.now() / 1000) + 12 * 3600;
  var payload = email + '|' + expiry;
  return Utilities.base64EncodeWebSafe(payload) + '.' + hmacHex_(payload);
}

// Returns the email the token was signed for, or null if missing, malformed,
// expired, or tampered with (bad signature).
function verifySession_(token) {
  if (!token) return null;
  var parts = String(token).split('.');
  if (parts.length !== 2) return null;
  var payload;
  try {
    payload = Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0])).getDataAsString();
  } catch (e) {
    return null;
  }
  var pieces = payload.split('|');
  if (pieces.length !== 2) return null;
  var email = pieces[0];
  var expiry = Number(pieces[1]);
  if (!email || !expiry || Math.floor(Date.now() / 1000) > expiry) return null;
  if (hmacHex_(payload) !== parts[1]) return null;
  return email;
}

// When the Fetcher last successfully pushed data, so the dashboard can show PICs
// that this isn't a static snapshot - see the "Refreshes every minute" header line.
function getLastSynced_() {
  return CacheService.getScriptCache().get('clickup_last_synced');
}

function ClickUpError_(message, detail) {
  this.message = message;
  this.detail = detail || '';
  this.isClickUpError = true;
}
ClickUpError_.prototype = Object.create(Error.prototype);

// Receives the ClickUp Fetcher project's periodic push (see file header comment) and
// writes it into this project's own cache. Called as a Library function, not over
// HTTP: this Workspace domain's web app deployments (tried both "Anyone with a Google
// account" and "Only myself") reject every server-to-server call regardless of what
// Authorization token the Fetcher sends - neither ScriptApp.getOAuthToken() nor
// getIdentityToken() satisfies the platform's own sign-in gate, so a doPost-based
// webhook simply cannot work here. A Library call sidesteps that gate entirely: it's
// an in-process function call, not an HTTP request, so there's no sign-in check to
// fail. Guarded by a shared secret rather than by who's signed in - the Fetcher calls
// this as itself, not as any particular viewer, and this project intentionally has no
// other way to tell "the Fetcher" apart from anyone else who might get hold of this
// project's Script ID and add it as a library.
function pushData(secret, data) {
  var expected = PropertiesService.getScriptProperties().getProperty('PUSH_SECRET');
  if (!expected || secret !== expected) {
    throw new Error('Forbidden');
  }
  var cache = CacheService.getScriptCache();
  COUNTRIES.forEach(function (c) {
    if (data && data.tasks && data.tasks[c.code]) {
      cache.put('clickup_tasks_' + c.code, JSON.stringify(data.tasks[c.code]), 21600);
    }
    if (data && data.outlets && data.outlets[c.code]) {
      cache.put('clickup_outlets_' + c.code, JSON.stringify(data.outlets[c.code]), 21600);
    }
  });
  cache.put('clickup_last_synced', new Date().toISOString(), 21600);
  return 'OK';
}

// Request-path read: the dashboard's onboarding rows, from the cache the Fetcher project
// keeps warm via pushData - never a live ClickUp call. See file header comment for why.
function getClickUpTasks_(country) {
  var raw = CacheService.getScriptCache().get('clickup_tasks_' + country.code);
  if (!raw) {
    throw new ClickUpError_('Onboarding data is still loading. Please try again in a few minutes.',
      'Cache empty for ' + country.code + ' - the Fetcher project may not have pushed yet.');
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

// ADMINS entries are {email, scope} objects, scope one of ADMIN_SCOPES. Older data
// (from before the Super/Country Admin split) stored plain email strings - those are
// normalized to {email, scope:'super'} on every read so existing admins keep full
// access with no manual migration step; the next save persists the new shape.
function getAdmins_() {
  var raw = PropertiesService.getScriptProperties().getProperty('ADMINS');
  var list = raw ? JSON.parse(raw) : [];
  return list.map(function (a) {
    return typeof a === 'string' ? { email: a, scope: 'super' } : a;
  });
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
  return getAdminCountryScope_(email) !== null;
}

function isSuperAdmin_(email) {
  return getAdminCountryScope_(email) === 'super';
}

// Returns 'super' | 'SG' | 'MY' | null - null meaning this email isn't an Admin at all.
function getAdminCountryScope_(email) {
  var target = String(email || '').trim().toLowerCase();
  var match = getAdmins_().filter(function (a) { return String(a.email || '').trim().toLowerCase() === target; })[0];
  return match ? match.scope : null;
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

// For endpoints any signed-in visitor may call (Admin, Viewer, or plain PIC
// alike) - just proves there's still a valid session, no role check.
function requireSession_(token) {
  var email = verifySession_(token);
  if (!email) throw new Error('Your session has expired. Please sign in again.');
  return email;
}

function requireAdmin_(token) {
  var email = verifySession_(token);
  if (!email || !isAdmin_(email)) throw new Error('Not authorized.');
  return email;
}

function requireSuperAdmin_(token) {
  var email = verifySession_(token);
  if (!email || !isSuperAdmin_(email)) throw new Error('Not authorized.');
  return email;
}

// A Super Admin can act for any country; a country-scoped Admin only for their own.
function requireCountryAdmin_(token, countryCode) {
  var email = verifySession_(token);
  var scope = email ? getAdminCountryScope_(email) : null;
  if (!scope || (scope !== 'super' && scope !== countryCode)) throw new Error('Not authorized.');
  return email;
}

// True if a country-scoped Admin (callerScope 'SG'/'MY') may grant/revoke/see the
// given Viewer scope: their own plain country scope, or any of their own
// country's four "<their country>_<category>" compound scopes (e.g. an SG Admin
// may grant "SG_fnb" but never "MY_fnb" or the cross-country "fnb"). Not consulted
// for a Super Admin caller, who is always allowed regardless (checked separately
// by every caller of this before falling back to it).
function viewerScopeAllowedForCountryAdmin_(callerScope, scope) {
  if (callerScope === scope) return true;
  var us = scope.indexOf('_');
  return us !== -1 && scope.slice(0, us) === callerScope;
}

// Gates granting/revoking a Viewer scope. A Super Admin can grant any scope. A
// country-scoped Admin can only grant/revoke their own plain country scope
// ("SG Viewer"/"MY Viewer") or their own country's compound scopes ("SG F&B
// only" etc, see viewerScopeAllowedForCountryAdmin_) - never the cross-country
// 'all' or plain category scopes (fnb/salon/others/group_management), which
// stay Super-Admin-only since they can expose the other country's outlets.
function requireViewerScopePermission_(token, scope) {
  var email = verifySession_(token);
  var callerScope = email ? getAdminCountryScope_(email) : null;
  if (!callerScope) throw new Error('Not authorized.');
  if (callerScope === 'super') return email;
  if (viewerScopeAllowedForCountryAdmin_(callerScope, scope)) return email;
  throw new Error('Not authorized.');
}

function isValidEmail_(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim());
}

// A country-scoped Admin only ever gets their own country's slice back - they have no
// business seeing the Admins list, the other country's PICs, or a Viewer scoped to
// the other country / spanning both (only "their" SG-or-MY Viewer scope). A Super
// Admin gets everything; outlet categories live on their own page now (see
// listOutletCategories), not here.
function listAccess(token) {
  var email = requireAdmin_(token);
  var scope = getAdminCountryScope_(email);
  if (scope === 'super') {
    return { scope: 'super', admins: getAdmins_(), viewers: getViewers_(), mappings: getMappings_() };
  }
  return {
    scope: scope,
    viewers: getViewers_().filter(function (v) { return viewerScopeAllowedForCountryAdmin_(scope, v.scope); }),
    mappings: getMappings_().filter(function (m) { return m.country === scope; })
  };
}

function addAdmin(token, email, scope) {
  requireSuperAdmin_(token);
  email = String(email || '').trim();
  if (!isValidEmail_(email)) throw new Error('Enter a valid email address.');
  if (ADMIN_SCOPES.indexOf(scope) === -1) throw new Error('Unknown admin scope.');
  var admins = getAdmins_();
  var target = email.toLowerCase();
  if (admins.some(function (a) { return a.email.toLowerCase() === target; })) {
    throw new Error(email + ' is already an admin.');
  }
  admins.push({ email: email, scope: scope });
  saveAdmins_(admins);
  return listAccess(token);
}

function removeAdmin(token, email) {
  requireSuperAdmin_(token);
  var target = String(email || '').trim().toLowerCase();
  var admins = getAdmins_();
  var remaining = admins.filter(function (a) { return a.email.toLowerCase() !== target; });
  if (remaining.length === admins.length) return listAccess(token);
  if (!remaining.some(function (a) { return a.scope === 'super'; })) {
    throw new Error('Cannot remove the last Super Admin.');
  }
  saveAdmins_(remaining);
  return listAccess(token);
}

function addViewer(token, email, scope) {
  if (VALID_SCOPES.indexOf(scope) === -1) throw new Error('Unknown scope.');
  requireViewerScopePermission_(token, scope);
  email = String(email || '').trim();
  if (!isValidEmail_(email)) throw new Error('Enter a valid email address.');
  var emailLower = email.toLowerCase();
  // Upsert: re-adding an existing Viewer just changes their scope, rather than erroring -
  // unlike Admins/PICs, "already exists" isn't a mistake worth blocking here. A country
  // Admin re-tagging someone else's viewer entry into a scope outside their own country
  // is still blocked above, before this ever runs.
  var viewers = getViewers_().filter(function (v) { return v.email.toLowerCase() !== emailLower; });
  viewers.push({ email: email, scope: scope });
  saveViewers_(viewers);
  return listAccess(token);
}

function removeViewer(token, email) {
  var caller = requireAdmin_(token);
  var callerScope = getAdminCountryScope_(caller);
  var emailLower = String(email || '').trim().toLowerCase();
  var viewers = getViewers_();
  var target = viewers.filter(function (v) { return v.email.toLowerCase() === emailLower; })[0];
  if (!target) return listAccess(token);
  if (callerScope !== 'super' && !viewerScopeAllowedForCountryAdmin_(callerScope, target.scope)) throw new Error('Not authorized.');
  var remaining = viewers.filter(function (v) { return v.email.toLowerCase() !== emailLower; });
  saveViewers_(remaining);
  return listAccess(token);
}

function addPicMapping(token, countryCode, email, outlet) {
  requireCountryAdmin_(token, countryCode);
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
  return listAccess(token);
}

function removePicMapping(token, countryCode, email, outlet) {
  requireCountryAdmin_(token, countryCode);
  var emailLower = String(email || '').trim().toLowerCase();
  var outletLower = String(outlet || '').trim().toLowerCase();
  var mappings = getMappings_().filter(function (m) {
    return !(m.country === countryCode && m.email.toLowerCase() === emailLower && m.outlet.toLowerCase() === outletLower);
  });
  saveMappings_(mappings);
  return listAccess(token);
}

// Read by the separate Manage Outlet Categories panel - Super Admin only, unlike
// listAccess which any Admin can call.
function listOutletCategories(token) {
  requireSuperAdmin_(token);
  return {
    categories: getOutletCategories_(),
    countries: COUNTRIES.map(function (c) {
      return { code: c.code, label: c.label, outlets: getOutletOptionsForCountry_(c) };
    })
  };
}

function addOutletCategory(token, countryCode, outlet, category) {
  requireSuperAdmin_(token);
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
  return listOutletCategories(token);
}

function removeOutletCategory(token, countryCode, outlet) {
  requireSuperAdmin_(token);
  var outletLower = String(outlet || '').trim().toLowerCase();
  var categories = getOutletCategories_().filter(function (c) {
    return !(c.country === countryCode && String(c.outlet || '').trim().toLowerCase() === outletLower);
  });
  saveOutletCategories_(categories);
  return listOutletCategories(token);
}

// ---- Page shell: header + country toggle + filter select + empty client-rendered dashboard ----

// Converts server-side country/row objects (which may hold real Date objects)
// into the plain, JSON-safe shape the client-side engine expects - shared by
// the initial page render and getDashboardData's in-page Refresh response.
function clientCountries_(countries) {
  return countries.map(function (c) {
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
}

// Lets the client re-fetch fresh rows/outlets for its already-signed-in session
// without a full page reload - see the file header's SIGN-IN note on why a real
// reload (which resends this tab's original, already-consumed OAuth code) can't
// be used for this instead.
function getDashboardData(token) {
  var email = requireSession_(token);
  var result = computeDashboardCountries_(email);
  if (!result.countries) {
    throw new Error(result.noAccessMessage);
  }
  return {
    countries: clientCountries_(result.countries),
    lastSynced: getLastSynced_()
  };
}

function renderShell_(countries, email, isAdmin, roleLabel, lastSynced, token) {
  var clientCountries = clientCountries_(countries);
  var countriesJson = JSON.stringify(clientCountries).replace(/</g, '\\u003c');

  return '' +
    '<div class="header">' +
      '<div>' +
        '<h1>Onboarding Status</h1>' +
        '<div class="muted" id="headerLabel">' + escapeHtml_(countries[0].outletsLabel) + '</div>' +
        '<div class="muted" id="syncLabel" style="font-size:12px;"></div>' +
      '</div>' +
      '<div style="display:flex;align-items:center;gap:12px;">' +
        '<button class="manage-btn" id="refreshBtn" onclick="doRefresh()">Refresh</button>' +
        (isAdmin ? '<button class="manage-btn" onclick="openAccessPanel()">Manage Access</button>' : '') +
        '<div class="muted">' + escapeHtml_(email) + (roleLabel ? ' \u00B7 ' + escapeHtml_(roleLabel) : '') + '</div>' +
      '</div>' +
    '</div>' +
    '<div id="filter-bar"></div>' +
    '<div id="dashboard-body"></div>' +
    '<div id="accessModal" class="modal-overlay" style="display:none;"><div class="modal" id="accessModalContent"></div></div>' +
    '<div id="categoriesModal" class="modal-overlay" style="display:none;"><div class="modal" id="categoriesModalContent"></div></div>' +
    '<script>' + clientEngine_() +
      '\nvar SESSION_TOKEN=' + JSON.stringify(token || '') + ';' +
      '\nvar COUNTRIES=' + countriesJson + ';' +
      '\nvar CURRENT=COUNTRIES[0].code;' +
      '\nvar LAST_SYNCED=' + JSON.stringify(lastSynced || null) + ';' +
      '\ndocument.getElementById("syncLabel").textContent="Refreshes automatically every minute"+(LAST_SYNCED?(" \u00B7 Last updated "+fmtTime(LAST_SYNCED)):"");' +
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
    'function fmtTime(iso){if(!iso)return "";var d=new Date(iso);return d.toLocaleTimeString("en-GB",{hour:"2-digit",minute:"2-digit"});}' +
    'function toTitleCase(v){return String(v==null?"":v).toLowerCase().replace(/(^|[\\s\\-\\(\\/])([a-z])/g,function(m,sep,ch){return sep+ch.toUpperCase();});}' +
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
          'body+="<tr><td>"+esc(r.outlet)+"</td><td>"+esc(toTitleCase(r.name))+"</td><td>"+esc(r.position)+"</td><td>"+esc(fmtDate(r.dueDate))+"</td><td class=\\"muted\\">"+esc(fmtDate(r.lastUpdated))+"</td></tr>";' +
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
    'function doRefresh(){' +
      'var btn=document.getElementById("refreshBtn");' +
      'if(btn){btn.disabled=true;btn.textContent="Refreshing\\u2026";}' +
      'google.script.run.withSuccessHandler(applyRefresh).withFailureHandler(refreshError).getDashboardData(SESSION_TOKEN);' +
    '}' +
    'function applyRefresh(data){' +
      'COUNTRIES=data.countries;' +
      'LAST_SYNCED=data.lastSynced;' +
      'var stillExists=false;' +
      'for(var i=0;i<COUNTRIES.length;i++){if(COUNTRIES[i].code===CURRENT)stillExists=true;}' +
      'if(!stillExists)CURRENT=COUNTRIES[0].code;' +
      'var lbl=document.getElementById("headerLabel");' +
      'if(lbl)lbl.textContent=findCountry(CURRENT).outletsLabel;' +
      'document.getElementById("syncLabel").textContent="Refreshes automatically every minute"+(LAST_SYNCED?(" \\u00B7 Last updated "+fmtTime(LAST_SYNCED)):"");' +
      'renderFilterBar();' +
      'render("");' +
      'var btn=document.getElementById("refreshBtn");' +
      'if(btn){btn.disabled=false;btn.textContent="Refresh";}' +
    '}' +
    'function refreshError(err){' +
      'var btn=document.getElementById("refreshBtn");' +
      'if(btn){btn.disabled=false;btn.textContent="Refresh";}' +
      'alert("Couldn\\u2019t refresh: "+(err&&err.message?err.message:String(err)));' +
    '}' +
    'var LAST_ACCESS_DATA=null;' +
    'var SCOPE_LABELS={all:"Super Viewer",SG:"SG Viewer",MY:"MY Viewer",fnb:"F&B only",salon:"Salon only",others:"Others only",group_management:"Group Management only",' +
      'SG_fnb:"SG F&B only",SG_salon:"SG Salon only",SG_others:"SG Others only",SG_group_management:"SG Group Management only",' +
      'MY_fnb:"MY F&B only",MY_salon:"MY Salon only",MY_others:"MY Others only",MY_group_management:"MY Group Management only"};' +
    'function viewerScopeOptionsFor(dataScope){' +
      'var keys=dataScope==="super"?Object.keys(SCOPE_LABELS):[dataScope,dataScope+"_fnb",dataScope+"_salon",dataScope+"_others",dataScope+"_group_management"];' +
      'return keys.map(function(k){return "<option value=\\""+k+"\\">"+esc(SCOPE_LABELS[k])+"</option>";}).join("");' +
    '}' +
    'var ADMIN_ROLE_LABELS={super:"Super Admin",SG:"SG Admin",MY:"MY Admin"};' +
    'var ADMIN_SCOPE_OPTIONS=Object.keys(ADMIN_ROLE_LABELS).map(function(k){return "<option value=\\""+k+"\\">"+esc(ADMIN_ROLE_LABELS[k])+"</option>";}).join("");' +
    'function openAccessPanel(){' +
      'document.getElementById("accessModal").style.display="flex";' +
      'document.getElementById("accessModalContent").innerHTML="<p class=\\"muted\\">Loading\\u2026</p>";' +
      'google.script.run.withSuccessHandler(renderAccessPanel).withFailureHandler(accessPanelError).listAccess(SESSION_TOKEN);' +
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
      'if(data.scope==="super"){' +
        'html+="<div class=\\"access-section\\"><div class=\\"section-title\\">Admins</div>";' +
        'data.admins.forEach(function(a,i){' +
          'html+="<div class=\\"access-row\\"><span>"+esc(a.email)+"</span><span style=\\"display:flex;align-items:center;gap:8px;\\"><span class=\\"muted\\">"+esc(ADMIN_ROLE_LABELS[a.scope]||a.scope)+"</span><button class=\\"remove-btn\\" onclick=\\"armConfirm(this,function(){doRemoveAdmin("+i+")})\\">Remove</button></span></div>";' +
        '});' +
        'html+="<div class=\\"add-form\\"><input type=\\"email\\" id=\\"newAdminEmail\\" placeholder=\\"name@company.com\\"/>"+' +
          '"<select id=\\"newAdminScope\\">"+ADMIN_SCOPE_OPTIONS+"</select>"+' +
          '"<button class=\\"add-btn\\" onclick=\\"doAddAdmin()\\">Add admin</button></div>";' +
        'html+="<div class=\\"access-error\\" id=\\"adminError\\"></div>";' +
        'html+="</div>";' +
      '}' +
      'if(data.viewers){' +
        'html+="<div class=\\"access-section\\"><div class=\\"section-title\\">Viewers (read-only)</div>";' +
        'data.viewers.forEach(function(v,i){' +
          'html+="<div class=\\"access-row\\"><span>"+esc(v.email)+"</span><span style=\\"display:flex;align-items:center;gap:8px;\\"><span class=\\"muted\\">"+esc(SCOPE_LABELS[v.scope]||v.scope)+"</span><button class=\\"remove-btn\\" onclick=\\"armConfirm(this,function(){doRemoveViewer("+i+")})\\">Remove</button></span></div>";' +
        '});' +
        'if(data.viewers.length===0)html+="<div class=\\"muted\\" style=\\"padding:6px 0;\\">No viewers yet.</div>";' +
        'html+="<div class=\\"add-form\\"><input type=\\"email\\" id=\\"newViewerEmail\\" placeholder=\\"name@company.com\\"/>"+' +
          '"<select id=\\"newViewerScope\\">"+viewerScopeOptionsFor(data.scope)+"</select>"+' +
          '"<button class=\\"add-btn\\" onclick=\\"doAddViewer()\\">Add viewer</button></div>";' +
        'html+="<div class=\\"access-error\\" id=\\"viewerError\\"></div>";' +
        'html+="</div>";' +
      '}' +
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
      'if(data.scope==="super"){' +
        'html+="<div class=\\"access-section\\"><button class=\\"manage-btn\\" onclick=\\"openCategoriesPanel()\\">Manage Outlet Categories \\u2192</button></div>";' +
      '}' +
      'document.getElementById("accessModalContent").innerHTML=html;' +
    '}' +
    'function withAccessField(prevData,field,value){' +
      'return {scope:prevData.scope,admins:field==="admins"?value:prevData.admins,viewers:field==="viewers"?value:prevData.viewers,mappings:field==="mappings"?value:prevData.mappings};' +
    '}' +
    'function doAddAdmin(){' +
      'var el=document.getElementById("newAdminEmail");' +
      'var scopeEl=document.getElementById("newAdminScope");' +
      'var email=el.value.trim();' +
      'var scope=scopeEl.value;' +
      'var errBox=document.getElementById("adminError");' +
      'if(errBox)errBox.textContent="";' +
      'if(!email){if(errBox)errBox.textContent="Enter an email address.";return;}' +
      'var prevData=LAST_ACCESS_DATA;' +
      'var optimistic=prevData.admins.concat([{email:email,scope:scope}]);' +
      'renderAccessPanel(withAccessField(prevData,"admins",optimistic));' +
      'el.value="";' +
      'google.script.run.withSuccessHandler(renderAccessPanel).withFailureHandler(function(err){renderAccessPanel(prevData);var e=document.getElementById("adminError");if(e)e.textContent=err&&err.message?err.message:String(err);}).addAdmin(SESSION_TOKEN,email,scope);' +
    '}' +
    'function doRemoveAdmin(i){' +
      'if(!LAST_ACCESS_DATA||!LAST_ACCESS_DATA.admins[i])return;' +
      'var email=LAST_ACCESS_DATA.admins[i].email;' +
      'var errBox=document.getElementById("topAccessError");' +
      'if(errBox)errBox.textContent="";' +
      'var prevData=LAST_ACCESS_DATA;' +
      'var optimistic=prevData.admins.filter(function(a,idx){return idx!==i;});' +
      'renderAccessPanel(withAccessField(prevData,"admins",optimistic));' +
      'google.script.run.withSuccessHandler(renderAccessPanel).withFailureHandler(function(err){renderAccessPanel(prevData);var e=document.getElementById("topAccessError");if(e)e.textContent=err&&err.message?err.message:String(err);}).removeAdmin(SESSION_TOKEN,email);' +
    '}' +
    'function doAddViewer(){' +
      'var emailEl=document.getElementById("newViewerEmail");' +
      'var scopeEl=document.getElementById("newViewerScope");' +
      'var email=emailEl.value.trim();' +
      'var scope=scopeEl.value;' +
      'var errBox=document.getElementById("viewerError");' +
      'if(errBox)errBox.textContent="";' +
      'if(!email){if(errBox)errBox.textContent="Enter an email address.";return;}' +
      'var prevData=LAST_ACCESS_DATA;' +
      'var emailLower=email.toLowerCase();' +
      'var optimistic=prevData.viewers.filter(function(v){return v.email.toLowerCase()!==emailLower;}).concat([{email:email,scope:scope}]);' +
      'renderAccessPanel(withAccessField(prevData,"viewers",optimistic));' +
      'emailEl.value="";' +
      'google.script.run.withSuccessHandler(renderAccessPanel).withFailureHandler(function(err){renderAccessPanel(prevData);var e=document.getElementById("viewerError");if(e)e.textContent=err&&err.message?err.message:String(err);}).addViewer(SESSION_TOKEN,email,scope);' +
    '}' +
    'function doRemoveViewer(i){' +
      'if(!LAST_ACCESS_DATA||!LAST_ACCESS_DATA.viewers[i])return;' +
      'var email=LAST_ACCESS_DATA.viewers[i].email;' +
      'var errBox=document.getElementById("topAccessError");' +
      'if(errBox)errBox.textContent="";' +
      'var prevData=LAST_ACCESS_DATA;' +
      'var optimistic=prevData.viewers.filter(function(v,idx){return idx!==i;});' +
      'renderAccessPanel(withAccessField(prevData,"viewers",optimistic));' +
      'google.script.run.withSuccessHandler(renderAccessPanel).withFailureHandler(function(err){renderAccessPanel(prevData);var e=document.getElementById("topAccessError");if(e)e.textContent=err&&err.message?err.message:String(err);}).removeViewer(SESSION_TOKEN,email);' +
    '}' +
    'function doAddMapping(countryCode){' +
      'var emailEl=document.getElementById("newPicEmail_"+countryCode);' +
      'var outletEl=document.getElementById("newPicOutlet_"+countryCode);' +
      'var email=emailEl.value.trim();' +
      'var outlet=outletEl.value;' +
      'var errBox=document.getElementById("mappingError_"+countryCode);' +
      'if(errBox)errBox.textContent="";' +
      'if(!outlet){if(errBox)errBox.textContent="Choose an outlet.";return;}' +
      'if(!email){if(errBox)errBox.textContent="Enter an email address.";return;}' +
      'var prevData=LAST_ACCESS_DATA;' +
      'var optimistic=prevData.mappings.concat([{country:countryCode,email:email,outlet:outlet}]);' +
      'renderAccessPanel(withAccessField(prevData,"mappings",optimistic));' +
      'emailEl.value="";outletEl.value="";' +
      'google.script.run.withSuccessHandler(renderAccessPanel).withFailureHandler(function(err){renderAccessPanel(prevData);var e=document.getElementById("mappingError_"+countryCode);if(e)e.textContent=err&&err.message?err.message:String(err);}).addPicMapping(SESSION_TOKEN,countryCode,email,outlet);' +
    '}' +
    'function doRemoveMapping(idx){' +
      'if(!LAST_ACCESS_DATA||!LAST_ACCESS_DATA.mappings[idx])return;' +
      'var m=LAST_ACCESS_DATA.mappings[idx];' +
      'var errBox=document.getElementById("topAccessError");' +
      'if(errBox)errBox.textContent="";' +
      'var prevData=LAST_ACCESS_DATA;' +
      'var optimistic=prevData.mappings.filter(function(x,i){return i!==idx;});' +
      'renderAccessPanel(withAccessField(prevData,"mappings",optimistic));' +
      'google.script.run.withSuccessHandler(renderAccessPanel).withFailureHandler(function(err){renderAccessPanel(prevData);var e=document.getElementById("topAccessError");if(e)e.textContent=err&&err.message?err.message:String(err);}).removePicMapping(SESSION_TOKEN,m.country,m.email,m.outlet);' +
    '}' +
    'var LAST_CATEGORY_DATA=null;' +
    'var OUTLET_CATEGORY_LABELS={fnb:"F&B",salon:"Salon",others:"Others",group_management:"Group Management"};' +
    'var OUTLET_CATEGORY_OPTIONS=Object.keys(OUTLET_CATEGORY_LABELS).map(function(k){return "<option value=\\""+k+"\\">"+esc(OUTLET_CATEGORY_LABELS[k])+"</option>";}).join("");' +
    'function openCategoriesPanel(){' +
      'document.getElementById("categoriesModal").style.display="flex";' +
      'document.getElementById("categoriesModalContent").innerHTML="<p class=\\"muted\\">Loading\\u2026</p>";' +
      'google.script.run.withSuccessHandler(renderCategoriesPanel).withFailureHandler(categoriesPanelError).listOutletCategories(SESSION_TOKEN);' +
    '}' +
    'function closeCategoriesPanel(){' +
      'document.getElementById("categoriesModal").style.display="none";' +
      'document.getElementById("accessModal").style.display="none";' +
    '}' +
    'function categoriesPanelError(err){' +
      'var msg=err&&err.message?err.message:String(err);' +
      'var box=document.getElementById("categoriesModalContent");' +
      'if(box)box.innerHTML="<button class=\\"modal-close\\" onclick=\\"closeCategoriesPanel()\\">&times;</button><h2>Manage Outlet Categories</h2><div class=\\"access-error\\">"+esc(msg)+"</div>";' +
    '}' +
    'function renderCategoriesPanel(data){' +
      'LAST_CATEGORY_DATA=data;' +
      'var html="<button class=\\"modal-close\\" onclick=\\"closeCategoriesPanel()\\">&times;</button>";' +
      'html+="<h2>Manage Outlet Categories</h2><div class=\\"muted\\" style=\\"margin-bottom:8px;\\">Super Admin only \\u00b7 used to filter what scoped Viewers see.</div>";' +
      'html+="<div class=\\"access-error\\" id=\\"topCategoryError\\"></div>";' +
      'data.countries.forEach(function(c){' +
        'html+="<div class=\\"access-section\\"><div class=\\"section-title\\">"+esc(c.label)+" outlet categories</div>";' +
        'var any=false;' +
        'data.categories.forEach(function(cat,idx){' +
          'if(cat.country!==c.code)return;' +
          'any=true;' +
          'html+="<div class=\\"access-row\\"><span>"+esc(cat.outlet)+" \\u2192 "+esc(OUTLET_CATEGORY_LABELS[cat.category]||cat.category)+"</span><button class=\\"remove-btn\\" onclick=\\"armConfirm(this,function(){doRemoveCategory("+idx+")})\\">Remove</button></div>";' +
        '});' +
        'if(!any)html+="<div class=\\"muted\\" style=\\"padding:6px 0;\\">No outlets tagged yet.</div>";' +
        'var opts=(c.outlets||[]).map(function(o){return "<option value=\\""+esc(o)+"\\">"+esc(o)+"</option>";}).join("");' +
        'html+="<div class=\\"add-form\\">"+' +
          '"<select id=\\"newCatOutlet_"+c.code+"\\"><option value=\\"\\">Select outlet</option>"+opts+"</select>"+' +
          '"<select id=\\"newCatCategory_"+c.code+"\\">"+OUTLET_CATEGORY_OPTIONS+"</select>"+' +
          '"<button class=\\"add-btn\\" onclick=\\"doAddCategory(\'"+c.code+"\')\\">Tag outlet</button></div>";' +
        'html+="<div class=\\"access-error\\" id=\\"categoryError_"+c.code+"\\"></div>";' +
        'html+="</div>";' +
      '});' +
      'document.getElementById("categoriesModalContent").innerHTML=html;' +
    '}' +
    'function doAddCategory(countryCode){' +
      'var outletEl=document.getElementById("newCatOutlet_"+countryCode);' +
      'var categoryEl=document.getElementById("newCatCategory_"+countryCode);' +
      'var outlet=outletEl.value;' +
      'var category=categoryEl.value;' +
      'var errBox=document.getElementById("categoryError_"+countryCode);' +
      'if(errBox)errBox.textContent="";' +
      'if(!outlet){if(errBox)errBox.textContent="Choose an outlet.";return;}' +
      'var prevData=LAST_CATEGORY_DATA;' +
      'var optimistic=prevData.categories.filter(function(c){return !(c.country===countryCode&&c.outlet===outlet);});' +
      'optimistic.push({country:countryCode,outlet:outlet,category:category});' +
      'renderCategoriesPanel({countries:prevData.countries,categories:optimistic});' +
      'google.script.run.withSuccessHandler(renderCategoriesPanel).withFailureHandler(function(err){renderCategoriesPanel(prevData);var e=document.getElementById("categoryError_"+countryCode);if(e)e.textContent=err&&err.message?err.message:String(err);}).addOutletCategory(SESSION_TOKEN,countryCode,outlet,category);' +
    '}' +
    'function doRemoveCategory(idx){' +
      'if(!LAST_CATEGORY_DATA||!LAST_CATEGORY_DATA.categories[idx])return;' +
      'var cat=LAST_CATEGORY_DATA.categories[idx];' +
      'var prevData=LAST_CATEGORY_DATA;' +
      'var optimistic=prevData.categories.filter(function(c,i){return i!==idx;});' +
      'renderCategoriesPanel({countries:prevData.countries,categories:optimistic});' +
      'google.script.run.withSuccessHandler(renderCategoriesPanel).withFailureHandler(function(err){renderCategoriesPanel(prevData);var e=document.getElementById("topCategoryError");if(e)e.textContent=err&&err.message?err.message:String(err);}).removeOutletCategory(SESSION_TOKEN,cat.country,cat.outlet);' +
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
      '.manage-btn:disabled{opacity:0.5;cursor:default;}' +
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
