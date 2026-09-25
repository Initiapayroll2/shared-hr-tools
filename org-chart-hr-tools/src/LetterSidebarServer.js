/**
 * Server-side glue for the letter-generation sidebar (LetterSidebar.html).
 * Stage 1 only: employee context + live template search/pick. Document
 * generation (copy template, replace <<Merge Tag>> placeholders, save into
 * the employee's P-file folder) is a deliberate follow-up, once this
 * search/pick UX itself is confirmed to feel right live -- see the
 * "coming soon" message in LetterSidebar.html's onGenerateClick().
 */

var LETTER_SIDEBAR_ROW_PROPERTY = 'letterSidebarRowNumber';

/**
 * Employee context for the sidebar header AND for resolving letter
 * placeholders -- {rowNumber, employeeId, fullName, nickName,
 * officialCompany, department, position, commencementDate, confirmationDate,
 * lastWorkingDay, nric, pfileUrl}. pfileUrl is '' if column S has no link
 * yet. Date fields are display values straight from the sheet (whatever
 * format that cell is formatted as), not reformatted -- confirmed live they
 * already read like "23 Sep 2015", close enough to the templates' own
 * "<<DD Month YYYY>>"-style hints without extra logic.
 */
function getEmployeeLetterContext_(rowNumber) {
  var sheet = SpreadsheetApp.openById(CONFIG.MASTERSHEET_ID).getSheetByName(CONFIG.MASTERSHEET_TAB_NAME);
  if (!sheet) {
    throw new Error('Mastersheet tab "' + CONFIG.MASTERSHEET_TAB_NAME + '" was not found.');
  }
  var headers = loadMastersheetHeaders_();
  var rowValues = sheet.getRange(rowNumber, 1, 1, headers.length).getDisplayValues()[0];

  function cellByHeader(headerName) {
    var col = headers.indexOf(headerName);
    return col === -1 ? '' : String(rowValues[col] || '').trim();
  }

  var pfileCol = headers.indexOf(MASTERSHEET_PFILE_LINK);
  var pfileUrl = '';
  if (pfileCol !== -1) {
    pfileUrl = sheet.getRange(rowNumber, pfileCol + 1).getRichTextValue().getLinkUrl() || '';
  }

  return {
    rowNumber: rowNumber,
    employeeId: cellByHeader(MASTERSHEET_EMPLOYEE_ID),
    fullName: cellByHeader(MASTERSHEET_FULL_NAME),
    nickName: cellByHeader(MASTERSHEET_NICK_NAME),
    officialCompany: cellByHeader(MASTERSHEET_OFFICIAL_COMPANY),
    department: cellByHeader(MASTERSHEET_DEPARTMENT),
    position: cellByHeader(MASTERSHEET_POSITION),
    commencementDate: cellByHeader(MASTERSHEET_COMMENCEMENT_DATE),
    confirmationDate: cellByHeader(MASTERSHEET_CONFIRMATION),
    lastWorkingDay: cellByHeader(MASTERSHEET_LAST_WORKING_DAY),
    nric: cellByHeader(MASTERSHEET_IC),
    pfileUrl: pfileUrl,
  };
}

/**
 * Opens the letter-generation sidebar for a specific Mastersheet row. The
 * row number is stashed in the invoking user's own properties (not shared
 * across colleagues) so LetterSidebar.html's initial google.script.run call
 * knows which employee it's showing without needing the row threaded
 * through HtmlService's template params.
 */
function showLetterSidebarForRow_(rowNumber) {
  PropertiesService.getUserProperties().setProperty(LETTER_SIDEBAR_ROW_PROPERTY, String(rowNumber));
  var html = HtmlService.createHtmlOutputFromFile('LetterSidebar').setTitle('Generate letter');
  SpreadsheetApp.getUi().showSidebar(html);
}

/**
 * Menu-driven entry point -- the only way to open this sidebar. Reads
 * whichever row the active cell is currently on, regardless of column.
 *
 * There is deliberately no "click the Employee ID cell and it pops open"
 * trigger: onSelectionChange is NOT an installable trigger type in Apps
 * Script at all (confirmed live -- ScriptApp.newTrigger(...)
 * .forSpreadsheet(...).onSelectionChange is not a function; the installable
 * types for a spreadsheet are only onOpen/onEdit/onChange/onFormSubmit).
 * onSelectionChange only exists as a SIMPLE trigger, and simple triggers
 * can't reliably open a sidebar/dialog either -- Google blocks that
 * specifically, since a simple trigger can fire from any collaborator's
 * click, including someone who never authorized this script themselves.
 * So true click-to-open isn't achievable here; the menu item (select the
 * row, then click the menu) is the real mechanism, same as Sync/P-file.
 */
function menuGenerateLettersForSelectedRow() {
  var range = SpreadsheetApp.getActiveRange();
  var sheet = SpreadsheetApp.getActiveSheet();
  if (!range || sheet.getName() !== CONFIG.MASTERSHEET_TAB_NAME) {
    SpreadsheetApp.getUi().alert('Select a cell on an employee row in the Mastersheet tab first, then run this again.');
    return;
  }
  showLetterSidebarForRow_(range.getRow());
}

// ---------------------------------------------------------------------
// Server API called from LetterSidebar.html
// ---------------------------------------------------------------------

/** @return {Object} Employee context for the currently open sidebar (row number stashed by showLetterSidebarForRow_()). */
function apiGetLetterSidebarContext() {
  var stored = PropertiesService.getUserProperties().getProperty(LETTER_SIDEBAR_ROW_PROPERTY);
  if (!stored) {
    throw new Error('No employee row is associated with this sidebar -- close it and click an Employee ID cell again.');
  }
  return getEmployeeLetterContext_(parseInt(stored, 10));
}

/** @return {Array} Up to 8 matching letter templates for the search box -- see searchLetterTemplates_(). */
function apiSearchLetterTemplates(query) {
  return searchLetterTemplates_(query, 8);
}

/**
 * Scans each selected template's ACTUAL body text (never the filename --
 * see LetterPlaceholders.js's header comment for why that's unreliable) and
 * reports which placeholders need a manual value before generating.
 *
 * @param {Array<string>} selectedKeys Drive ids of the picked templates.
 * @return {Array} One entry per selected template:
 *   {key, letterType, content, isFolder, folderUrl,
 *    unresolvedFields: [{token, occurrenceIndex, occurrenceCount}]}
 *   isFolder entries (the NDA "folder of templates" catalog rows) have no
 *   unresolvedFields -- there's nothing to auto-generate, just a folder link
 *   to open manually.
 */
function apiPrepareLetterGeneration(selectedKeys) {
  return (selectedKeys || []).map(function (key) {
    var template = getLetterTemplateByDriveId_(key);
    if (template.isFolder) {
      return {
        key: key, letterType: template.letterType, content: template.content,
        isFolder: true, folderUrl: template.rawLink, unresolvedFields: [],
      };
    }
    var body = DocumentApp.openById(template.driveId).getBody();
    var tokens = extractPlaceholderTokens_(body.getText());
    var classified = classifyPlaceholderTokens_(tokens);
    return {
      key: key, letterType: template.letterType, content: template.content,
      isFolder: false, folderUrl: '', unresolvedFields: classified.unresolvedTokens,
    };
  });
}

/**
 * Generates the actual documents. Re-resolves every template and the
 * employee context fresh from the live sheets (never trusts anything the
 * client cached from an earlier call) -- copies each template into the
 * employee's P-file folder (parsed from their column-S link), replaces
 * every resolved field globally and every unresolved token at its exact
 * occurrence, and returns links to what was created.
 *
 * @param {Array} selections [{key, unresolvedValues: [{token, occurrenceIndex, value}]}]
 * @return {Array} One entry per selection:
 *   {key, letterType, content, manual, fileUrl, fileName} -- manual:true
 *   (isFolder templates) means nothing was generated, only folderUrl is set.
 */
function apiGenerateLetters(selections) {
  var stored = PropertiesService.getUserProperties().getProperty(LETTER_SIDEBAR_ROW_PROPERTY);
  if (!stored) {
    throw new Error('No employee row is associated with this sidebar -- close it and click an Employee ID cell again.');
  }
  var employeeContext = getEmployeeLetterContext_(parseInt(stored, 10));
  var destinationRef = extractDriveId_(employeeContext.pfileUrl);
  if (!destinationRef || !destinationRef.isFolder) {
    throw new Error('Column S ("Pfile [Link]") for this employee doesn\'t point at a Drive folder -- fix that link before generating letters.');
  }
  var destinationFolder = DriveApp.getFolderById(destinationRef.id);

  return (selections || []).map(function (selection) {
    var template = getLetterTemplateByDriveId_(selection.key);
    if (template.isFolder) {
      return {
        key: selection.key, letterType: template.letterType, content: template.content,
        manual: true, fileUrl: template.rawLink, fileName: '',
      };
    }

    var templateFile = DriveApp.getFileById(template.driveId);
    var body = DocumentApp.openById(template.driveId).getBody();
    var tokens = extractPlaceholderTokens_(body.getText());
    var classified = classifyPlaceholderTokens_(tokens);

    var newName = applyPlaceholderReplacementsToText_(templateFile.getName(), classified.resolvedFields, employeeContext);
    var copy = templateFile.makeCopy(newName, destinationFolder);

    var copyDoc = DocumentApp.openById(copy.getId());
    applyPlaceholderReplacements_(copyDoc.getBody(), classified.resolvedFields, employeeContext, selection.unresolvedValues);
    copyDoc.saveAndClose();

    return {
      key: selection.key, letterType: template.letterType, content: template.content,
      manual: false, fileUrl: copy.getUrl(), fileName: newName,
    };
  });
}
