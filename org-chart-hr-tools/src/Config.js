/**
 * Single source of truth for spreadsheet/folder IDs, mirroring
 * config/pfile_creation.json and config/mastersheet_sync.json in the main
 * ChrisHR-AI Python app. Kept in sync by hand -- if Chris changes a
 * template/destination folder or a Typeform sheet name over there, update
 * it here too.
 */

var CONFIG = {
  // Typeform "Application form - New (SG)" responses.
  APPLICATION_FORM_SPREADSHEET_ID: '1ZxKlQ8zSQbAwvgMU9fKntMGBL0d1lUMsZdYsMaEWcKY',
  APPLICATION_FORM_SHEET_NAME: 'Application form - New (SG) - Chris Version (WIP)',

  // Old (pre-"Chris Version") Typeform application form responses -- lives in
  // a separate spreadsheet ("ATF SG 2022 - APPLICANT TRACKING FILE - Typeform
  // from Email"), which itself has multiple tabs; only this one tab carries
  // the fuller identity fields (Surname, Alias/Nick Name) and the applicant
  // photo (column AY). Confirmed live on 2026-09-16 via direct sheet
  // inspection -- see photo-sync/PhotoMatching.gs, which is the only feature
  // that reads this. Never confuse with the "Application form -old" tab in
  // the same spreadsheet (no photo, no nickname field -- a different, older
  // tracking sheet), nor the "Chris" tab.
  OLD_APPLICATION_FORM_SPREADSHEET_ID: '1yK3Aw_64wSc8uHVb0oi5uzOZaXGBcIKU6seJQTTfnr8',
  OLD_APPLICATION_FORM_SHEET_NAME: 'Application form - New (SG)',

  // Typeform "Bank Account Details" responses.
  BANK_FORM_SPREADSHEET_ID: '14MW2AHvhe0t4zJ2XkMyOH8fui5iJvv9QfPF0ou_xiMw',
  BANK_FORM_SHEET_NAME: 'Bank Account Details',

  // Employee Master Sheet.
  MASTERSHEET_ID: '1ljzjflbi18pcOZgXRzOXN9EdENMKBhENWGgQyMyApJs',
  MASTERSHEET_TAB_NAME: 'MASTERSHEET',

  // Official entity list ("SG ENTITIES", column D from row 2 down) lives in
  // this same spreadsheet's "SOP_MUST READ" tab -- despite the name, that
  // tab also doubles as the reference table for entity names/UENs and the
  // SG Employee ID prefix legend (SGFT/SGPT/SGIT/SGFL). Confirmed live in
  // the Mastersheet, not a guess.
  ENTITY_REFERENCE_SHEET_NAME: 'SOP_MUST READ',
  ENTITY_REFERENCE_COLUMN: 4, // column D

  // Position list for the Mastersheet's own POSITION column, and the
  // lookup table its DEPARTMENT column's formula depends on. Confirmed
  // live: Mastersheet!DEPARTMENT is =VLOOKUP(POSITION_CELL,'Costing
  // Reference Table'!$G$2:$H$200,2,0) -- column G ("POSITION [2]") is the
  // ONLY valid set of POSITION values (not column F, "POSITION [1]" --
  // that's a different, unrelated list on the same sheet); column H is
  // the Department rollup the formula returns. Never hardcode a Department
  // value from this project -- always let that formula compute it (see
  // MastersheetMapping.js's buildRowValues_()).
  POSITION_REFERENCE_SHEET_NAME: 'Costing Reference Table',
  POSITION_REFERENCE_COLUMN: 7, // column G ("POSITION [2]")
  DEPARTMENT_FORMULA_SHEET_RANGE: "'Costing Reference Table'!$G$2:$H$200",

  // Department options for the P-file dialog's Department dropdown -- same
  // 'Costing Reference Table' sheet, its column H (the VLOOKUP's own result
  // column, paired 1:1 with column G's Position list above). Deliberately
  // NOT the Mastersheet's own DEPARTMENT column (M) -- that's a live formula
  // output there (see DEPARTMENT_FORMULA_SHEET_RANGE above), not an
  // independently editable/validated list. This is the complete, exact list
  // -- nothing is appended on top, so the P-file dialog can never offer a
  // department the Mastersheet itself wouldn't recognize.
  DEPARTMENT_REFERENCE_COLUMN: 8, // column H ("Department" rollup)

  // P-file template in Drive -- every new P-file is copied from this folder,
  // regardless of employment type.
  TEMPLATE_FOLDER_ID: '1eD519SRx6gklcDi-cp6wqxXh5sCJbPJK',

  // P-file destination in Drive, by employment type -- Apps-Script-only
  // addition, not present in the Python app's single destination_folder_id
  // (see README's "Key differences" section). Keys match the values in the
  // P-file dialog's "Employment Type" dropdown exactly.
  DESTINATION_FOLDER_IDS: {
    'PT': '1MWPE3Ih2zHl0jZxsZacq4OYdhxHjer8l',
    'FT': '1IvVbwYFK6yY_yjiZ9ZAOcOA8hjQA1MQf',
    'Intern': '1tpi1HA6U0mT0V2Iyl3JEPZGHAC6vvBHA',
    'Freelance': '1FGadwP0t7kgfJA1SaHIV1ib0djc5k1vD',
  },

  // Letter template catalog -- a separate spreadsheet ("SG All Form"), tab
  // "SG ALL FORMS". Confirmed live on 2026-08-19: row 2 is the header, data
  // runs rows 3-60 (59 templates). Column E ("Link") is just a display chip
  // -- always read column F ("Raw Link") instead, which holds the actual
  // docs.google.com/drive.google.com URL. See LetterTemplateRegistry.js.
  LETTER_TEMPLATES_SHEET_ID: '1jvorjqplycrKsGvaC4sLLFCYuD8SszV3rNgwyorXssg',
  LETTER_TEMPLATES_TAB_NAME: 'SG ALL FORMS',
  LETTER_TEMPLATES_HEADER_ROW: 2,

  // Org chart web app (OrgChartServer.js / OrgChart.html), v2 -- outlet-by-
  // outlet, 3-layer (Area/GM, Outlet in-charge, ground staff). Two small
  // tabs this file creates automatically in the SAME Mastersheet spreadsheet
  // (never a separate file -- one less thing to share/manage): one row per
  // PERSON (their photo, role tag, and -- only for someone with no
  // Mastersheet row at all, e.g. top management tracked in a different
  // Mastersheet Chris doesn't have access to -- their whole manual profile),
  // and one row per (person, outlet) placement (which layer they sit at on
  // that outlet's page; a person can be placed on more than one outlet).
  // Everything else the org chart shows for a Mastersheet-sourced person
  // (name, position, status, entity, location, dates, ...) is read live
  // from MASTERSHEET_TAB_NAME above, never duplicated here.
  ORG_CHART_PEOPLE_SHEET_NAME: 'Org Chart People',
  ORG_CHART_PLACEMENTS_SHEET_NAME: 'Org Chart Placements',
  // Who can EDIT the org chart (add/move/remove people, upload photos,
  // Outlet Settings, etc.) -- added 2026-09-23, since the web app is shared
  // with "Anyone" (not restricted to one Workspace domain, since staff use
  // several email domains) and runs as whoever deployed it for every
  // visitor, so without this check anyone with the link could edit, not
  // just view. Everyone can still browse/view the org chart regardless of
  // this list. This is the PERMANENT admin list -- a deliberate code
  // change/deploy, never an in-app setting, specifically so it can never be
  // emptied out from within the app itself (a lockout safety net). Ordinary
  // day-to-day admin management (adding/removing colleagues) instead goes
  // through the in-app "Manage Access" screen (added 2026-09-24, per Chris),
  // backed by ORG_CHART_ADMINS_SHEET_NAME below -- isCurrentUserAdmin_()
  // checks BOTH lists, so anyone here always has access no matter what that
  // sheet says.
  ORG_CHART_ADMIN_EMAILS: ['payroll2@redzgroup.com'],
  // In-app-managed admin allowlist (see "Manage Access", 2026-09-24) -- one
  // email per row, auto-created empty and filled in by admins themselves.
  // Deliberately separate from ORG_CHART_ADMIN_EMAILS above, never the other
  // way around.
  ORG_CHART_ADMINS_SHEET_NAME: 'Org Chart Admins',
  // View-only allowlist (see "Manage Access", 2026-09-25, per Chris -- PDPA:
  // employee photos/names are sensitive, so the app can no longer be open to
  // anyone with the link at all). Same shape as ORG_CHART_ADMINS_SHEET_NAME,
  // one email per row. isAuthorizedVisitor_() (Admin OR Viewer) gates doGet
  // itself now -- being on neither list means an "Access restricted" page
  // instead of the org chart, not just being unable to edit.
  ORG_CHART_VIEWERS_SHEET_NAME: 'Org Chart Viewers',

  // "Sign in with Google" rebuild (2026-09-25, per Chris) -- Session.getActiveUser()
  // only ever reliably identified visitors in the SAME Google Workspace domain as
  // the deploying account (confirmed broken for a personal Gmail even while
  // genuinely signed in), so access is now checked via a real Google Identity
  // Services sign-in + server-side ID token verification instead (see apiSignIn
  // in OrgChartServer.js). This Client ID is a public identifier, not a secret --
  // safe to live in source. Created under Chris's own "Org Chart" GCP project.
  ORG_CHART_GOOGLE_CLIENT_ID: '987506613180-81u13m98o3d6juj25dm691prp8a00th6.apps.googleusercontent.com',
  // Hardcoded (not ScriptApp.getService().getUrl()) so the OAuth redirect_uri
  // is always identical regardless of how a visitor reached the page --
  // confirmed live 2026-09-25: a visitor signed into the redzgroup.com
  // Workspace gets served from https://script.google.com/a/redzgroup.com/
  // macros/s/.../exec (domain-prefixed), not the plain form below, which
  // otherwise caused a redirect_uri_mismatch against the one registered
  // Authorized redirect URI in Google Cloud Console. Update this if the
  // deployment ID ever changes (clasp deployments shows the current one).
  ORG_CHART_EXEC_URL: 'https://script.google.com/macros/s/AKfycbw17CniUTiGzPkZtM4-pR9PJkj3Y9L4lbDm1xWzl5vSkHRgb1iQM1cgtDeHT_ZkBvaeHg/exec',

  // Manual photo override for an Incoming Employees card, keyed by ClickUp
  // task id (these people have no employee id yet) -- for when the
  // auto-match-by-full-name against the Application Form sheet misses or
  // picks the wrong photo. Added 2026-09-25, per Chris.
  ORG_CHART_INCOMING_PHOTOS_SHEET_NAME: 'Org Chart Incoming Photos',
  ORG_CHART_INCOMING_PHOTOS_FOLDER_NAME: 'Org Chart - Incoming Employee Photos',

  // Full-time onboarding lists shown in the admin-only "Incoming Employees"
  // view. These are read directly from ClickUp; CLICKUP_TOKEN must be stored
  // in this Apps Script project's Script Properties (never in source code).
  ORG_CHART_INCOMING_INDUSTRIES: [
    { code: 'SG_mt', label: 'Management Trainees', listId: '1100670000000929', isManagementTraineeList: true },
    { code: 'SG_fnb', label: 'SG · F&B', listId: '901817849940' },
    { code: 'SG_beauty', label: 'SG · Beauty', listId: '901817849939' },
    { code: 'SG_officehq', label: 'SG · Office HQ', listId: '901817849941' },
  ],
  ORG_CHART_INCOMING_FULL_NAME_FIELD: 'Full Name',
  ORG_CHART_INCOMING_POSITION_FIELD: 'Position',
  ORG_CHART_INCOMING_OUTLET_FIELD: 'Outlet',
  ORG_CHART_INCOMING_DEPARTMENT_FIELD: 'Department',
  ORG_CHART_INCOMING_START_DATE_FIELD: 'Proposed Start Date',
  // Verified against the live Application Form response sheet on 2026-09-24.
  ORG_CHART_APPLICATION_NAME_COLUMN: 2,  // B
  ORG_CHART_APPLICATION_PHOTO_COLUMN: 68, // BP
  // One row per outlet/LOCATION -- an explicit admin override of its Role
  // Scheme (and, for the "department" scheme, its own department list),
  // added 2026-09-23 so Chris's team can correct/assign classification by
  // hand instead of relying only on getRoleSchemeForOutlet_'s heuristics
  // (which had been misclassifying some salon/back-office outlets as F&B).
  ORG_CHART_OUTLET_SETTINGS_SHEET_NAME: 'Org Chart Outlet Settings',

  // Subfolder name a photo gets uploaded into, inside an employee's P-file
  // (the same folder PfileCreation.js already files Typeform-submitted
  // "Most Recent Professional/Casual Photo" answers into during P-file
  // creation -- reusing it here rather than a separate photo store keeps
  // one photo location per employee).
  ORG_CHART_PHOTO_SUBFOLDER_NAME: '04. PERSONAL INFORMATION',

  // photo-sync/PhotoBackfill.gs's human-review queue for fuzzy (non-exact-ID)
  // photo matches -- lives as a new tab in the same Mastersheet spreadsheet,
  // created automatically on first use if missing.
  PHOTO_MATCH_REVIEW_SHEET_NAME: 'Photo Match Review',
};
