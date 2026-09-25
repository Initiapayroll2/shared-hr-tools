/**
 * P-file creation and Mastersheet sync -- server API called from the HTML
 * dialogs (SyncDialog.html, PfileDialog.html) via google.script.run. Every
 * function below is intentionally thin -- the actual logic lives in
 * MastersheetSync.js / MastersheetMapping.js / PfileCreation.js /
 * PfileNaming.js, each a close port of the matching Python service in the
 * main ChrisHR-AI app (see each file's header comment for which one).
 *
 * Deliberately NOT named Code.js: this Mastersheet already has its own
 * production Apps Script project (resignee archiving, Employee ID
 * assignment/registry) living in Code.js, predating this project. This
 * file adds alongside it, not instead of it -- see Code.js's onOpen() for
 * where this project's two menu items were merged into the existing "HR
 * Tools" menu (Apps Script allows only one onOpen() per project, so ours
 * could not be a second, separate function).
 */

function showSyncDialog() {
  var html = HtmlService.createHtmlOutputFromFile('SyncDialog').setWidth(900).setHeight(650);
  SpreadsheetApp.getUi().showModalDialog(html, 'Sync New Hire to Mastersheet');
}

function showPfileDialog() {
  var html = HtmlService.createHtmlOutputFromFile('PfileDialog').setWidth(700).setHeight(650);
  SpreadsheetApp.getUi().showModalDialog(html, 'Create P-file');
}

/**
 * One-time manual authorization helper -- run this directly from the Apps
 * Script editor's Run button (select it from the function dropdown first),
 * not from the Sheet menu. onOpen() never asks for Drive/external-request
 * permission because it never calls anything Drive- or
 * UrlFetchApp-related; this function exists purely to force both consent
 * prompts by actually exercising each scope once, since Apps Script only
 * asks for a scope the first time code actually uses it. Safe to run
 * repeatedly -- it only reads the P-file template folder's name and fetches
 * a public page, no writes.
 *
 * Deliberately no trailing underscore (unlike this project's other
 * internal helpers) -- the Apps Script editor's manual "Run" function
 * picker hides any function whose name ends in "_", by convention, so a
 * trailing underscore here would make this impossible to select and run.
 */
function testDriveAuthorization() {
  var file = Drive.Files.get(CONFIG.TEMPLATE_FOLDER_ID, { fields: 'id,name,mimeType' });
  Logger.log('Drive access OK -- template folder: ' + file.name);

  // Downloading a Typeform attachment (driveDownloadTypeformFile_ in
  // PfileCreation.js) needs script.external_request -- exercised here with
  // a harmless public fetch, not a real attachment URL.
  var response = UrlFetchApp.fetch('https://www.google.com');
  Logger.log('External request access OK -- status ' + response.getResponseCode());

  // Letter generation (LetterSidebarServer.js's apiGenerateLetters()) opens
  // and edits copied template Docs via DocumentApp, which needs its own
  // "documents" scope separate from Drive -- exercised here by creating a
  // throwaway Doc and immediately trashing it, rather than depending on any
  // specific real template's continued existence.
  var testDoc = DocumentApp.create('ChrisHR-AI auth test -- safe to delete');
  testDoc.getBody().setText('This document was created only to trigger the Docs OAuth consent screen.');
  testDoc.saveAndClose();
  DriveApp.getFileById(testDoc.getId()).setTrashed(true);
  Logger.log('Documents access OK -- throwaway test doc created and trashed.');
}

/**
 * Diagnostic: shows exactly which row findNextEmptyRow_() would treat as
 * "the last real row" right now, and what's in its Employee ID/Employee
 * Status/Full Name cells -- for tracking down why a sync landed further
 * down the sheet than expected. A single blank-looking row does not mean
 * the whole gap above it is blank; this reports the actual row the
 * algorithm is anchoring on, so that row's three cells can be checked (or
 * cleared, if they turn out to be leftover junk) directly.
 */
function menuDiagnoseNextMastersheetRow() {
  var ui = SpreadsheetApp.getUi();
  var allValues = getAllValues_(CONFIG.MASTERSHEET_ID, CONFIG.MASTERSHEET_TAB_NAME);
  var headerRowNumber = findHeaderRow_(allValues, MASTERSHEET_HEADER_MARKER);
  var liveHeaders = allValues[headerRowNumber - 1];
  var identity = identityColumnIndexes_(liveHeaders);
  var targetRow = findNextEmptyRow_(allValues, headerRowNumber, identity.idCol, identity.statusCol, identity.nameCol);
  var lastRealRow = targetRow - 1;

  function cellAt(rowValues, col) {
    return (col !== null && col !== undefined && col < rowValues.length) ? rowValues[col] : '(column not found)';
  }

  var message;
  if (lastRealRow <= headerRowNumber) {
    message = 'No data rows found below the header (row ' + headerRowNumber + ') -- the next sync would write to row ' + targetRow + '.';
  } else {
    var lastRealRowValues = allValues[lastRealRow - 1];
    message =
      'Next sync/create will write to row ' + targetRow + '.\n\n' +
      'That is because row ' + lastRealRow + ' is the LAST row (scanning from the header down) with anything in ' +
      'Employee ID, Employee Status, or Full Name:\n\n' +
      '  Employee ID (col ' + (identity.idCol === null ? 'n/a' : columnLetter_(identity.idCol)) + '): "' + cellAt(lastRealRowValues, identity.idCol) + '"\n' +
      '  Employee Status (col ' + (identity.statusCol === null ? 'n/a' : columnLetter_(identity.statusCol)) + '): "' + cellAt(lastRealRowValues, identity.statusCol) + '"\n' +
      '  Full Name (col ' + columnLetter_(identity.nameCol) + '): "' + cellAt(lastRealRowValues, identity.nameCol) + '"\n\n' +
      'If those three look like leftover/stray data rather than a real employee record, clearing them (and re-running this check) will let the next sync land higher up.';
  }
  ui.alert('Next Mastersheet Row', message, ui.ButtonSet.OK);
}

/**
 * Diagnostic: reports the Mastersheet's active basic Filter (Data > Create
 * a filter), if any -- its range and which columns currently have a
 * hide-filter criteria applied. Read-only, makes no changes. Written to
 * answer "can a synced row land inside the filter's range instead of below
 * it" -- see menuDiagnoseNextMastersheetRow()'s sibling discussion; growing
 * a basic Filter's range means removing and recreating it (Apps Script's
 * Filter class has no setRange()), which is only worth doing once we know
 * whether real hide-criteria exist to preserve.
 */
function menuDiagnoseFilter() {
  var ui = SpreadsheetApp.getUi();
  var sheet = SpreadsheetApp.openById(CONFIG.MASTERSHEET_ID).getSheetByName(CONFIG.MASTERSHEET_TAB_NAME);
  var filter = sheet.getFilter();
  if (!filter) {
    ui.alert('Mastersheet Filter', 'No basic Filter (Data > Create a filter) is currently active on "' + CONFIG.MASTERSHEET_TAB_NAME + '".', ui.ButtonSet.OK);
    return;
  }
  var range = filter.getRange();
  var firstCol = range.getColumn();
  var lastCol = firstCol + range.getNumColumns() - 1;
  var firstRow = range.getRow();
  var lastRow = firstRow + range.getNumRows() - 1;
  var criteriaColumns = [];
  for (var col = firstCol; col <= lastCol; col++) {
    if (filter.getColumnFilterCriteria(col)) {
      criteriaColumns.push(columnLetter_(col - 1));
    }
  }
  var message =
    'Filter range: ' + range.getA1Notation() + ' (rows ' + firstRow + '-' + lastRow + ', columns ' +
    columnLetter_(firstCol - 1) + '-' + columnLetter_(lastCol - 1) + ').\n\n' +
    (criteriaColumns.length
      ? 'Columns with an active hide-filter criteria right now: ' + criteriaColumns.join(', ') +
        '.\n\nGrowing this filter\'s range means temporarily removing and recreating it -- ' +
        'these criteria would need to be read and reapplied afterward, or a colleague currently ' +
        'relying on them to hide rows would see everything unhidden for a moment.'
      : 'No column currently has an active hide-filter criteria -- growing this filter\'s range ' +
        '(remove + recreate over the wider range) would be low-risk right now, since there\'s ' +
        'nothing currently hidden to preserve.');
  ui.alert('Mastersheet Filter', message, ui.ButtonSet.OK);
}

/**
 * Admin one-off: grows the Mastersheet's Filter to cover every row
 * currently on the sheet, right now -- for closing an existing gap (rows
 * already written below the filter's old range, from before
 * addEmployeeRow_() started doing this automatically on every sync).
 * Ongoing syncs no longer need this -- see extendMastersheetFilterToRow_()
 * in MastersheetSync.js, called automatically after every write -- this is
 * only for catching up a gap that already exists.
 */
function menuGrowMastersheetFilterRange() {
  var ui = SpreadsheetApp.getUi();
  var sheet = SpreadsheetApp.openById(CONFIG.MASTERSHEET_ID).getSheetByName(CONFIG.MASTERSHEET_TAB_NAME);
  var filter = sheet.getFilter();
  if (!filter) {
    ui.alert('Grow Mastersheet Filter', 'No basic Filter (Data > Create a filter) is currently active -- nothing to grow.', ui.ButtonSet.OK);
    return;
  }
  var beforeRange = filter.getRange();
  var lastRow = sheet.getLastRow();
  extendMastersheetFilterToRow_(sheet, lastRow);
  var afterFilter = sheet.getFilter();
  var afterRange = afterFilter ? afterFilter.getRange().getA1Notation() : '(filter is gone -- something went wrong)';
  ui.alert('Grow Mastersheet Filter', 'Filter range was ' + beforeRange.getA1Notation() + ', now ' + afterRange + '.', ui.ButtonSet.OK);
}

/**
 * Diagnostic: lists EVERY row from a given starting row down (not just the
 * last one, unlike menuDiagnoseNextMastersheetRow()) that has anything in
 * Employee ID, Employee Status, or Full Name. For seeing the full picture
 * of what's occupying a gap between where a colleague expects the "next
 * row" to be and where the tool actually computed it -- a single last-row
 * report can't distinguish "one stray row far down" from "a contiguous
 * block of real rows starting earlier than expected." Read-only.
 */
function menuListNonBlankRowsFrom() {
  var ui = SpreadsheetApp.getUi();
  var response = ui.prompt(
    'List Non-Blank Rows',
    'Show every row (from the header down) with data in Employee ID, Employee Status, or Full Name, starting at which row number?',
    ui.ButtonSet.OK_CANCEL
  );
  if (response.getSelectedButton() !== ui.Button.OK) return;
  var startRow = parseInt(response.getResponseText(), 10);
  if (!startRow) {
    ui.alert('Enter a valid row number.');
    return;
  }

  var allValues = getAllValues_(CONFIG.MASTERSHEET_ID, CONFIG.MASTERSHEET_TAB_NAME);
  var headerRowNumber = findHeaderRow_(allValues, MASTERSHEET_HEADER_MARKER);
  var liveHeaders = allValues[headerRowNumber - 1];
  var identity = identityColumnIndexes_(liveHeaders);

  var scanFrom = Math.max(startRow, headerRowNumber + 1);
  var found = [];
  for (var rowNum = scanFrom; rowNum <= allValues.length; rowNum++) {
    var rowValues = allValues[rowNum - 1];
    if (rowHasIdentityData_(rowValues, identity.idCol, identity.statusCol, identity.nameCol)) {
      var idVal = identity.idCol !== null ? rowValues[identity.idCol] : '';
      var statusVal = identity.statusCol !== null ? rowValues[identity.statusCol] : '';
      var nameVal = rowValues[identity.nameCol];
      found.push('Row ' + rowNum + ': ID="' + idVal + '" Status="' + statusVal + '" Name="' + nameVal + '"');
    }
  }

  var message = found.length ? found.join('\n') : 'No rows with identity data found from row ' + startRow + ' onward.';
  if (message.length > 3500) {
    message = message.slice(0, 3500) + '\n\n... (truncated -- ' + found.length + ' matching rows total)';
  }
  ui.alert('Non-Blank Rows From ' + startRow, message, ui.ButtonSet.OK);
}

// ---------------------------------------------------------------------
// Mastersheet sync -- server API
// ---------------------------------------------------------------------

/** @return {Array} Lightweight applicant list for the picker -- {rowNumber, fullName, submittedAt, token}. */
function apiListApplicationResponses(showAll) {
  var rows = listApplicationResponses_(showAll ? null : 60);
  return rows.map(function (row) {
    return { rowNumber: row.rowNumber, fullName: row.fullName, submittedAt: row.submittedAt, token: row.token };
  });
}

/** @return {Array} Bank Form candidates ranked by name similarity -- {rowNumber, candidateName, submittedAt, similarity}. */
function apiFindBankCandidates(fullName) {
  var rows = findBankCandidates_(fullName, 5);
  return rows.map(function (row) {
    return { rowNumber: row.rowNumber, candidateName: row.candidateName, submittedAt: row.submittedAt, similarity: row.similarity };
  });
}

/**
 * @return {Object} {descriptors} -- the editable field list for the review
 * step, built from a fresh read of the Application Form row, the optional
 * matched Bank Form row, and the Mastersheet's live headers.
 */
function apiGetMastersheetPreview(applicationRowNumber, bankRowNumber) {
  var applicationRow = getApplicationRowByNumber_(applicationRowNumber);
  var bankRow = bankRowNumber ? getBankRowByNumber_(bankRowNumber) : null;
  var headers = loadMastersheetHeaders_();
  var descriptors = buildFieldDescriptors_(headers, applicationRow, bankRow);

  // Both read from a live reference sheet, not hand-copied lists -- see
  // getOfficialEntityOptions_() and getPositionOptions_() for why each one
  // uses the specific source it does. Department is never given options
  // here -- it's rendered as computed/non-editable (see
  // MastersheetMapping.js's buildFieldDescriptors_()) and the actual
  // formula gets written server-side in addEmployeeRow_().
  var entityOptions = getOfficialEntityOptions_();
  var positionOptions = getPositionOptions_();
  var dropdownHeaders = [MASTERSHEET_PASS, MASTERSHEET_BONUS_TYPE,
    MASTERSHEET_BONUS_PAYROLL_MONTH, MASTERSHEET_BONUS_PAYROLL_YEAR,
    MASTERSHEET_LOCATION, MASTERSHEET_DEPARTMENT,
    MASTERSHEET_WORKING_DAYS, MASTERSHEET_OFF_DAYS, MASTERSHEET_INSURANCE_TYPE,
    MASTERSHEET_CONTRACT_PERIOD];
  var dropdownOptions = getMastersheetDropdownOptions_(dropdownHeaders);
  descriptors.forEach(function (d) {
    if (d.mastersheetHeader === MASTERSHEET_OFFICIAL_COMPANY && entityOptions.length) d.options = entityOptions;
    if (d.mastersheetHeader === MASTERSHEET_POSITION && positionOptions.length) d.options = positionOptions;
    if (dropdownOptions[d.mastersheetHeader] && dropdownOptions[d.mastersheetHeader].length) {
      d.options = dropdownOptions[d.mastersheetHeader];
    }
  });

  return { descriptors: descriptors };
}

/**
 * The one write call. `fieldValues` is {fieldKey_(header, occurrence): value}
 * built from whatever the review dialog shows (edited or not).
 * @return {Object} {rowNumber, employeeId}
 */
function apiSubmitMastersheetRow(fieldValues, applicationRowNumber) {
  try {
    var applicationRow = getApplicationRowByNumber_(applicationRowNumber);
    return addEmployeeRow_(fieldValues, applicationRow);
  } catch (error) {
    // Re-thrown as a plain Error -- google.script.run's failure handler
    // only reliably receives a standard Error's .message across the
    // client/server boundary, not a custom prototype's .name.
    throw new Error(error && error.message ? error.message : String(error));
  }
}

// ---------------------------------------------------------------------
// P-file creation -- server API
// ---------------------------------------------------------------------

/** @return {Array<string>} Official entity names for the Entity dropdown, read fresh from the Mastersheet's own reference list. */
function apiGetEntityOptions() {
  return getOfficialEntityOptions_();
}

/** @return {Array<string>} Valid Position values for the P-file dialog's Position field -- same reference list the Mastersheet sync dialog's Position dropdown uses. */
function apiGetPositionOptions() {
  return getPositionOptions_();
}

/** @return {Array<string>} Pass Type options for the P-file dialog, read fresh from the Mastersheet's own PASS column dropdown validation. */
function apiGetPassTypeOptions() {
  return getMastersheetDropdownOptions_([MASTERSHEET_PASS])[MASTERSHEET_PASS] || [];
}

/** @return {Array<string>} Department options for the P-file dialog -- see getDepartmentOptions_() for why this isn't sourced from the Mastersheet's own (formula-driven) DEPARTMENT column. */
function apiGetDepartmentOptions() {
  return getDepartmentOptions_();
}

/** @return {Array} Lightweight applicant list for the picker -- {rowNumber, fullName, nickname, positionApplied, submittedAt, attachmentCount}. */
function apiListApplicantsForPfile() {
  var rows = listApplicantsForPfile_();
  return rows.map(function (row) {
    return {
      rowNumber: row.rowNumber,
      fullName: row.fullName,
      nickname: row.nickname,
      positionApplied: row.positionApplied,
      submittedAt: row.submittedAt,
      attachmentCount: (row.attachments || []).length,
    };
  });
}

/** @return {string} The computed folder name for the current HR field inputs, without creating anything. */
function apiPreviewPfileFolderName(applicationRowNumber, hrFields) {
  var applicant = getApplicantByRowNumber_(applicationRowNumber);
  try {
    return previewPfileFolderName_(applicant, hrFields || {});
  } catch (error) {
    throw new Error(error && error.message ? error.message : String(error));
  }
}

/** @return {Object} {id, name, webViewLink, created, documents: {uploaded, skipped, failed}} */
function apiCreatePfile(applicationRowNumber, bankRowNumber, hrFields) {
  var applicant = getApplicantByRowNumber_(applicationRowNumber);
  var bankRow = bankRowNumber ? getBankRowByNumber_(bankRowNumber) : null;
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    return createPfile_(applicant, hrFields || {}, bankRow);
  } catch (error) {
    throw new Error(error && error.message ? error.message : String(error));
  } finally {
    lock.releaseLock();
  }
}
