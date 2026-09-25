/**
 * Mastersheet Sync -- Orchestration
 *
 * Port of services/mastersheet_sync_service.py. Lists Application Form
 * responses, ranks candidate Bank Form submissions by name similarity
 * (never auto-matched -- a colleague always confirms explicitly), builds a
 * review-dialog preview via MastersheetMapping.js, and performs the one
 * actual write: adding a new Mastersheet row for a new employee.
 *
 * Unlike the Python app, there is no read-only-service-account vs.
 * personal-OAuth split here -- Apps Script runs every call as the signed-in
 * colleague using the menu, so as long as they have edit access to the
 * Mastersheet (and view access to the two Typeform response sheets), both
 * reads and the write just work.
 *
 * The Mastersheet's real header row is NOT row 1 (row 1 is a numbering
 * helper, row 2 an archive label) -- every method here locates the header
 * row by searching for a known marker, never by assuming a fixed position,
 * same as the Python original.
 *
 * Row placement: addEmployeeRow_() deliberately does NOT use
 * Sheet.appendRow() or insertRowAfter(). See the Python original's module
 * docstring for the full story -- in short, this Mastersheet has an active
 * Filter/FilterView whose range confuses append-style "find the table"
 * heuristics (silently overwriting the same row every time in live
 * testing), and a real row insertion risks breaking other spreadsheets
 * that reference this one by row number. Instead, this computes the true
 * next empty row itself (scanning Employee ID/Employee Status/Full Name
 * from the header down, tolerating "-"-placeholder rows) and writes
 * directly to it with setValues() -- never touching or shifting any other
 * row. A script-wide lock plus an immediate re-check right before writing
 * closes (not eliminates -- Sheets has no row-level lock) the window where
 * a concurrent colleague editing the same shared sheet could be
 * overwritten; if that happens, this aborts with a clear error instead.
 */

// Deliberately a literal, not a reference to MastersheetMapping.js's
// MASTERSHEET_FULL_NAME -- Apps Script doesn't guarantee cross-file
// top-level `var` initialization order the way Python's imports do, so a
// top-level reference to another file's `var` here would be a real risk,
// not just a style nitpick. The two constants must stay in sync by hand.
var MASTERSHEET_HEADER_MARKER = 'FULL NAME';

// Confirmed with Chris: the sheet's own font convention, applied to a
// newly-synced row so it visually matches the rest of the Mastersheet
// instead of whatever font Sheets' default happens to be.
var NEW_ROW_FONT_FAMILY = 'Barlow';
var NEW_ROW_FONT_SIZE = 10;
var MASTERSHEET_ROW_PROPERTY_PREFIX = 'mastersheet_row_for_typeform:';

/**
 * Raised when the computed target row is no longer blank immediately
 * before writing -- someone else (this is a shared, multi-editor sheet)
 * filled it in during the brief window between reading and writing. Never
 * silently overwritten; the caller must retry.
 */
function MastersheetRowConflictError_(message) {
  this.name = 'MastersheetRowConflictError';
  this.message = message;
}
MastersheetRowConflictError_.prototype = Object.create(Error.prototype);

/**
 * Header lookup tolerant of whitespace/line-break drift -- e.g. matches
 * "Date of Expiry \n" against "Date of Expiry" -- used only for the two
 * MOM Information reference columns (Date of Expiry, Passport Expiry) that
 * Work Visa/Passport Expiry link to, since those two are read fresh by
 * label rather than hardcoded as a project-wide MASTERSHEET_* constant.
 * Every other header lookup in this project still requires an exact match.
 */
function findHeaderIndexLoose_(headers, target) {
  var normalizedTarget = String(target).trim().replace(/\s+/g, ' ');
  for (var i = 0; i < headers.length; i++) {
    if (String(headers[i]).trim().replace(/\s+/g, ' ') === normalizedTarget) return i;
  }
  return -1;
}

/** 1-indexed row number of the first row containing `marker` (case-insensitive). */
function findHeaderRow_(allValues, marker) {
  var upperMarker = String(marker).toUpperCase();
  for (var index = 0; index < allValues.length; index++) {
    var row = allValues[index];
    for (var c = 0; c < row.length; c++) {
      if (String(row[c]).trim().toUpperCase() === upperMarker) {
        return index + 1;
      }
    }
  }
  throw new Error('Could not find a Mastersheet header row containing "' + marker + '".');
}

/**
 * {idCol, statusCol, nameCol} (0-indexed) -- whichever of Employee
 * ID/Employee Status aren't present resolve to null (a header genuinely
 * missing them shouldn't crash the sync); Full Name is always present,
 * since findHeaderRow_() already required it.
 */
function identityColumnIndexes_(liveHeaders) {
  var idIndex = liveHeaders.indexOf(MASTERSHEET_EMPLOYEE_ID);
  var statusIndex = liveHeaders.indexOf(MASTERSHEET_EMPLOYEE_STATUS);
  var nameIndex = liveHeaders.indexOf(MASTERSHEET_HEADER_MARKER);
  return {
    idCol: idIndex === -1 ? null : idIndex,
    statusCol: statusIndex === -1 ? null : statusIndex,
    nameCol: nameIndex,
  };
}

function rowHasIdentityData_(row, idCol, statusCol, nameCol) {
  function cellAt(col) {
    return (col !== null && col !== undefined && col < row.length) ? String(row[col]).trim() : '';
  }
  return !!(cellAt(idCol) || cellAt(statusCol) || cellAt(nameCol));
}

/**
 * 1-indexed row number of the first genuinely empty row after the header --
 * "empty" meaning blank Employee ID, Employee Status, AND Full Name. Scans
 * every row after the header rather than stopping at the first blank one
 * found, since this sheet has long stretches of "-"-placeholder rows
 * interspersed with real data historically.
 */
function findNextEmptyRow_(allValues, headerRowNumber, idCol, statusCol, nameCol) {
  var lastRealRow = headerRowNumber; // 1-indexed; the header itself if nothing follows
  for (var zeroIndex = headerRowNumber; zeroIndex < allValues.length; zeroIndex++) {
    if (rowHasIdentityData_(allValues[zeroIndex], idCol, statusCol, nameCol)) {
      lastRealRow = zeroIndex + 1;
    }
  }
  return lastRealRow + 1;
}

/**
 * Every Application Form response, newest submission first. No dedup
 * against the Mastersheet -- a deliberate simplification carried over from
 * the Python original; a colleague visually recognizes which ones are
 * already processed.
 *
 * `withinDays` (default 60) limits results to recent submissions. Pass
 * null to see everything. A response with an unparseable submitted-at date
 * is always kept, in either mode, rather than risked being silently
 * filtered out.
 */
function listApplicationResponses_(withinDays) {
  if (withinDays === undefined) withinDays = 60;
  var rows = readSheetRows_(CONFIG.APPLICATION_FORM_SPREADSHEET_ID, CONFIG.APPLICATION_FORM_SHEET_NAME);
  rows.forEach(function (row) {
    row.fullName = cell_(row, 'Full Name (as shown in NRIC/Passport )');
    row.submittedAt = cell_(row, 'Submitted At');
    row.token = cell_(row, 'Token');
  });
  rows = rows.filter(function (row) { return row.fullName; });
  rows.reverse();

  if (withinDays !== null) {
    var cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - withinDays);
    rows = rows.filter(function (row) {
      var parsed = parseSubmittedAt_(row.submittedAt);
      return parsed === null || parsed >= cutoff;
    });
  }

  return rows;
}

/** The specific Application Form row Apps Script's UI last showed, re-fetched fresh by its 1-indexed sheet row number. */
function getApplicationRowByNumber_(rowNumber) {
  var rows = readSheetRows_(CONFIG.APPLICATION_FORM_SPREADSHEET_ID, CONFIG.APPLICATION_FORM_SHEET_NAME);
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].rowNumber === rowNumber) return rows[i];
  }
  throw new Error('Application Form row ' + rowNumber + ' was not found -- it may have been deleted or moved.');
}

/**
 * Bank Form submissions ranked by name similarity to `fullName`, most
 * similar first -- NEVER auto-selected. A colleague always confirms the
 * match explicitly in the review dialog.
 */
function findBankCandidates_(fullName, limit) {
  limit = limit || 5;
  var rows = readSheetRows_(CONFIG.BANK_FORM_SPREADSHEET_ID, CONFIG.BANK_FORM_SHEET_NAME);
  rows.forEach(function (row) {
    row.candidateName = cell_(row, 'Candidate Name (As per bank record):');
    row.submittedAt = cell_(row, 'Submitted At');
    row.similarity = sequenceMatcherRatio_(row.candidateName, fullName);
  });
  rows = rows.filter(function (row) { return row.candidateName; });
  rows.sort(function (a, b) { return b.similarity - a.similarity; });
  return rows.slice(0, limit);
}

/** The specific Bank Form row a colleague picked as the match, re-fetched fresh by its 1-indexed sheet row number. */
function getBankRowByNumber_(rowNumber) {
  var rows = readSheetRows_(CONFIG.BANK_FORM_SPREADSHEET_ID, CONFIG.BANK_FORM_SHEET_NAME);
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].rowNumber === rowNumber) return rows[i];
  }
  throw new Error('Bank Form row ' + rowNumber + ' was not found -- it may have been deleted or moved.');
}

/**
 * The Mastersheet's live header list. Safe to use for display only --
 * addEmployeeRow_() always re-fetches its own fresh copy immediately
 * before writing, regardless of what was passed to buildFieldDescriptors_().
 */
function loadMastersheetHeaders_() {
  var allValues = getAllValues_(CONFIG.MASTERSHEET_ID, CONFIG.MASTERSHEET_TAB_NAME);
  var headerRowNumber = findHeaderRow_(allValues, MASTERSHEET_HEADER_MARKER);
  return allValues[headerRowNumber - 1];
}

/**
 * Position options for the Mastersheet sync dialog's Position dropdown --
 * see CONFIG.POSITION_REFERENCE_SHEET_NAME/COLUMN's comment for why this
 * must be column G ("POSITION [2]") specifically, not the similarly-named
 * column F ("POSITION [1]") on the same reference sheet: G is the only set
 * of values the Mastersheet's own DEPARTMENT formula can look up.
 */
function getPositionOptions_() {
  return readDedupedColumnValues_(CONFIG.MASTERSHEET_ID, CONFIG.POSITION_REFERENCE_SHEET_NAME, CONFIG.POSITION_REFERENCE_COLUMN, 2);
}

/** Reads the Mastersheet's own dropdown validation so dialog choices never drift from the sheet. */
function getMastersheetDropdownOptions_(headerNames) {
  var sheet = SpreadsheetApp.openById(CONFIG.MASTERSHEET_ID).getSheetByName(CONFIG.MASTERSHEET_TAB_NAME);
  var values = sheet.getDataRange().getDisplayValues();
  var headerRowNumber = findHeaderRow_(values, MASTERSHEET_HEADER_MARKER);
  var headers = values[headerRowNumber - 1];
  var out = {};
  headerNames.forEach(function (headerName) {
    out[headerName] = [];
    var col = headers.indexOf(headerName);
    if (col === -1) return;
    var rowsToScan = Math.max(1, Math.min(500, sheet.getMaxRows() - headerRowNumber));
    var validations = sheet.getRange(headerRowNumber + 1, col + 1, rowsToScan, 1).getDataValidations();
    for (var r = 0; r < validations.length; r++) {
      var rule = validations[r][0];
      if (!rule) continue;
      var type = rule.getCriteriaType();
      var args = rule.getCriteriaValues();
      if (type === SpreadsheetApp.DataValidationCriteria.VALUE_IN_LIST) {
        out[headerName] = (args[0] || []).map(String).filter(Boolean);
      } else if (type === SpreadsheetApp.DataValidationCriteria.VALUE_IN_RANGE) {
        out[headerName] = args[0].getDisplayValues().reduce(function (all, row) {
          return all.concat(row);
        }, []).map(function (v) { return String(v).trim(); }).filter(Boolean);
      }
      if (out[headerName].length) break;
    }
    out[headerName] = out[headerName].filter(function (value, index, all) {
      return all.indexOf(value) === index;
    });
  });
  return out;
}

function mastersheetRowPropertyKey_(token) {
  return MASTERSHEET_ROW_PROPERTY_PREFIX + String(token || '').trim();
}

function setLinkCell_(sheet, rowNumber, headers, headerName, url) {
  var col = headers.indexOf(headerName);
  if (col === -1 || !url) return;
  var richText = SpreadsheetApp.newRichTextValue().setText('Link').setLinkUrl(url).build();
  sheet.getRange(rowNumber, col + 1).setRichTextValue(richText);
}

/** Allows P-file creation to backfill both links even when Mastersheet sync happened first. */
function updateMastersheetPfileLinkForToken_(token, folderUrl, applicationFormUrl) {
  token = String(token || '').trim();
  if (!token || !folderUrl) return false;
  var storedRow = PropertiesService.getScriptProperties().getProperty(mastersheetRowPropertyKey_(token));
  if (!storedRow) return false;
  var sheet = SpreadsheetApp.openById(CONFIG.MASTERSHEET_ID).getSheetByName(CONFIG.MASTERSHEET_TAB_NAME);
  var values = sheet.getDataRange().getDisplayValues();
  var headerRowNumber = findHeaderRow_(values, MASTERSHEET_HEADER_MARKER);
  var headers = values[headerRowNumber - 1];
  var rowNumber = parseInt(storedRow, 10);
  setLinkCell_(sheet, rowNumber, headers, MASTERSHEET_PFILE_LINK, folderUrl);
  setLinkCell_(sheet, rowNumber, headers, MASTERSHEET_APPLICATION_FORM_LINK, applicationFormUrl);
  return true;
}

/**
 * The one write path -- see the module docstring above for why this
 * computes a row and calls setValues() directly rather than appendRow() or
 * any row-insertion operation.
 *
 * Re-fetches live Mastersheet headers AND all values fresh immediately
 * before writing. Throws MastersheetRowConflictError_, never overwrites,
 * if the computed target row was claimed by a concurrent edit in the brief
 * window between reading and writing.
 *
 * Returns {rowNumber, employeeId}. employeeId is usually "" (the sheet's
 * own bound Apps Script sets it only once a colleague clicks into the
 * row) -- that's expected, not a failure.
 */
function addEmployeeRow_(fieldValues, applicationRow) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sheet = SpreadsheetApp.openById(CONFIG.MASTERSHEET_ID).getSheetByName(CONFIG.MASTERSHEET_TAB_NAME);
    if (!sheet) {
      throw new Error('Mastersheet tab "' + CONFIG.MASTERSHEET_TAB_NAME + '" was not found.');
    }
    var allValues = sheet.getDataRange().getDisplayValues();
    var headerRowNumber = findHeaderRow_(allValues, MASTERSHEET_HEADER_MARKER);
    var liveHeaders = allValues[headerRowNumber - 1];
    var identity = identityColumnIndexes_(liveHeaders);

    var targetRow = findNextEmptyRow_(allValues, headerRowNumber, identity.idCol, identity.statusCol, identity.nameCol);

    // Minimizes (does not eliminate -- Sheets has no row-level lock) the
    // window in which a concurrent editor's work could be overwritten: a
    // fresh read of just the target row, immediately before the write,
    // on top of the script-wide lock already held.
    var targetRange = sheet.getRange(targetRow, 1, 1, liveHeaders.length);
    var freshTargetRow = targetRange.getDisplayValues()[0];
    if (rowHasIdentityData_(freshTargetRow, identity.idCol, identity.statusCol, identity.nameCol)) {
      throw new MastersheetRowConflictError_(
        'Row ' + targetRow + ' was filled in by someone else just now -- please try again.'
      );
    }

    var rowValues = buildRowValues_(liveHeaders, fieldValues);

    var statusCol = liveHeaders.indexOf(MASTERSHEET_EMPLOYEE_STATUS);
    var commencementCol = liveHeaders.indexOf(MASTERSHEET_COMMENCEMENT_DATE);
    var confirmationCol = liveHeaders.indexOf(MASTERSHEET_CONFIRMATION);
    var probationCol = liveHeaders.indexOf(MASTERSHEET_PROBATION);
    var employeeStatus = statusCol === -1 ? '' : String(rowValues[statusCol] || '').trim().toUpperCase();
    var isFullTime = employeeStatus === 'F/T';
    var isNonFullTime = ['P/T', 'LONG TERM PT', 'PT ADMIN', 'P/T SUB', 'FREELANCE',
      'INTERN - SCHOOL', 'INTERN - NON SCHOOL'].indexOf(employeeStatus) !== -1;
    if (confirmationCol !== -1) {
      if (isFullTime && commencementCol !== -1) {
        rowValues[confirmationCol] = '=EDATE(' + columnLetter_(commencementCol) + targetRow + ',3)';
      } else if (isNonFullTime) {
        rowValues[confirmationCol] = 'NA';
      }
    }
    if (probationCol !== -1) {
      if (isFullTime && confirmationCol !== -1) {
        rowValues[probationCol] = '=IF(' + columnLetter_(confirmationCol) + targetRow + '>$J$2,"Probation","Confirmed")';
      } else if (isNonFullTime) {
        rowValues[probationCol] = 'NA';
      }
    }

    // Gross Total is a SUMIF over this row's own Basic Salary through Other
    // Allowance columns for every status except literal "P/T" -- confirmed
    // against the live Mastersheet's own convention (2026-09-16): P/T rows
    // hold a manually-typed hourly-rate description in this same cell
    // instead (e.g. "Weekdays: 20/hr Weekends: 25/hr"), which a formula
    // would clobber. Deliberately narrower than isNonFullTime above -- P/T
    // Admin, P/T Sub, Freelance, and Intern rows overwhelmingly DO carry
    // this formula live, unlike Confirmation/Probation/Visa fields, which
    // treat that whole group as "NA"/"-".
    var grossTotalCol = liveHeaders.indexOf(MASTERSHEET_GROSS_TOTAL);
    var basicSalaryCol = liveHeaders.indexOf(MASTERSHEET_BASIC_SALARY);
    var otherAllowanceCol = liveHeaders.indexOf(MASTERSHEET_OTHER_ALLOWANCE);
    if (grossTotalCol !== -1 && basicSalaryCol !== -1 && otherAllowanceCol !== -1 && employeeStatus !== 'P/T') {
      var basicSalaryRef = columnLetter_(basicSalaryCol) + targetRow;
      var otherAllowanceRef = columnLetter_(otherAllowanceCol) + targetRow;
      rowValues[grossTotalCol] = '=SUMIF(' + basicSalaryRef + ':' + otherAllowanceRef + ',"<>-",' +
        basicSalaryRef + ':' + otherAllowanceRef + ')';
    }

    var ageCol = liveHeaders.indexOf(MASTERSHEET_AGE);
    var birthDateCol = liveHeaders.indexOf(MASTERSHEET_DATE_OF_BIRTH);
    if (ageCol !== -1 && birthDateCol !== -1) {
      rowValues[ageCol] = '=DATEDIF(' + columnLetter_(birthDateCol) + targetRow + ',TODAY(),"Y")';
    }

    // Confirmed with Chris (2026-09-09): [Resign] Last working day/Transfer
    // date is a lookup against the "Full Timer Offboarding Checklist" tab
    // for full-timers only; "-" for P/T-like statuses; same as this row's
    // own Contract End Date for interns. Any other status (e.g. Transferred
    // Entity) is left alone -- same precedent as Confirmation/Probation
    // above, which also only handle isFullTime/isNonFullTime explicitly.
    var isPtOrFreelance = ['P/T', 'LONG TERM PT', 'PT ADMIN', 'P/T SUB', 'FREELANCE'].indexOf(employeeStatus) !== -1;
    var isIntern = ['INTERN - SCHOOL', 'INTERN - NON SCHOOL'].indexOf(employeeStatus) !== -1;
    var lwdCol = liveHeaders.indexOf(MASTERSHEET_LAST_WORKING_DAY);
    var fullNameCol = liveHeaders.indexOf(MASTERSHEET_FULL_NAME);
    var contractEndCol = liveHeaders.indexOf(MASTERSHEET_CONTRACT_END_DATE);
    if (lwdCol !== -1) {
      if (isFullTime && fullNameCol !== -1) {
        rowValues[lwdCol] = '=XLOOKUP(' + columnLetter_(fullNameCol) + targetRow +
          ',\'Full Timer Offboarding Checklist\'!$D$2:$D$1354,' +
          '\'Full Timer Offboarding Checklist\'!$N$2:$N$1354,"-",0)';
      } else if (isPtOrFreelance) {
        rowValues[lwdCol] = '-';
      } else if (isIntern && contractEndCol !== -1) {
        rowValues[lwdCol] = '=' + columnLetter_(contractEndCol) + targetRow;
      }
    }

    // Work Visa Expiry / Passport Expiry: "-" for P/T, Freelance, or Intern
    // (isNonFullTime, computed above -- already covers all three); every
    // other status (F/T, Transferred Entity) links live to the MOM
    // Information section's own "Date of Expiry" / "Passport Expiry"
    // columns further along this same row, rather than duplicating a value
    // a colleague would otherwise have to keep in sync by hand in two
    // places.
    var workVisaCol = liveHeaders.indexOf(MASTERSHEET_WORK_VISA_EXPIRY);
    var passportExpiryCol = liveHeaders.indexOf(MASTERSHEET_PASSPORT_EXPIRY);
    var momExpiryCol = findHeaderIndexLoose_(liveHeaders, 'Date of Expiry');
    var momPassportCol = findHeaderIndexLoose_(liveHeaders, 'Passport Expiry');
    if (workVisaCol !== -1) {
      if (isNonFullTime) {
        rowValues[workVisaCol] = '-';
      } else if (momExpiryCol !== -1) {
        rowValues[workVisaCol] = '=' + columnLetter_(momExpiryCol) + targetRow;
      }
    }
    if (passportExpiryCol !== -1) {
      if (isNonFullTime) {
        rowValues[passportExpiryCol] = '-';
      } else if (momPassportCol !== -1) {
        rowValues[passportExpiryCol] = '=' + columnLetter_(momPassportCol) + targetRow;
      }
    }

    targetRange.setValues([rowValues]);

    // A programmatic setValues() does not fire Google Sheets' onEdit
    // trigger. Invoke the existing status-edit assignment path directly
    // so a synced employee receives the same sequential SGFT/SGPT/SGIT/
    // SGFL ID immediately, including the normal ID Registry entry.
    if (statusCol !== -1 && identity.idCol !== null) {
      SpreadsheetApp.flush();
      autoAssignEmployeeIdOnStatusEdit_({
        range: sheet.getRange(targetRow, statusCol + 1),
      });
    }

    // Apply the requested display format to every date-related column in
    // this new row. Formula results and entered dates both display as
    // e.g. "03 Sep 2026" without changing their underlying date values.
    liveHeaders.forEach(function (header, index) {
      if (/DATE/i.test(String(header || '')) || header === MASTERSHEET_CONFIRMATION ||
        header === MASTERSHEET_WORK_VISA_EXPIRY || header === MASTERSHEET_PASSPORT_EXPIRY) {
        sheet.getRange(targetRow, index + 1).setNumberFormat('dd mmm yyyy');
      }
    });

    if (applicationRow) {
      var token = cell_(applicationRow, 'Token');
      if (token) {
        PropertiesService.getScriptProperties().setProperty(mastersheetRowPropertyKey_(token), String(targetRow));
        var pfile = findRememberedPfile_(token);
        if (!pfile) {
          var matches = driveFindPfilesAcrossDestinations_(token);
          pfile = matches.length === 1 ? matches[0] : null;
        }
        if (pfile) {
          setLinkCell_(sheet, targetRow, liveHeaders, MASTERSHEET_PFILE_LINK, pfile.webViewLink);
          var applicationPdf = findApplicationFormPdfInPfile_(pfile.id,
            cell_(applicationRow, 'Full Name (as shown in NRIC/Passport )'));
          if (applicationPdf) {
            setLinkCell_(sheet, targetRow, liveHeaders, MASTERSHEET_APPLICATION_FORM_LINK, applicationPdf.webViewLink);
          }
        }
      }

      // Photo -- this new hire's own applicationRow already IS the exact,
      // human-confirmed Typeform response for this sync (no name/NRIC
      // matching needed, unlike the historical backfill in
      // photo-sync/PhotoBackfill.gs, which has to guess which response row
      // belongs to an already-existing Mastersheet row). Written as a real
      // embedded image via insertPhotoCellImage_() (photo-sync/
      // PhotoBackfill.gs), never a link. Best-effort, same reasoning as the
      // font/filter-range steps below -- a dead/slow photo URL must never
      // make the sync itself look like it failed.
      var photoCol = liveHeaders.indexOf(MASTERSHEET_EMPLOYEE_PHOTO_HEADER);
      if (photoCol !== -1) {
        var photoUrl = cell_(applicationRow, NEW_FORM_PHOTO_FIELDS.photo, 0);
        if (photoUrl) {
          try {
            insertPhotoCellImage_(sheet, targetRow, photoCol + 1, photoUrl);
          } catch (photoError) {
            // Ignored deliberately -- see comment above.
          }
        }
      }
    }

    var employeeId = '';
    if (identity.idCol !== null) {
      var writtenRow = targetRange.getDisplayValues()[0];
      employeeId = identity.idCol < writtenRow.length ? String(writtenRow[identity.idCol]).trim() : '';
    }

    // Cosmetic, not data-correctness -- a formatting failure here must
    // never look like the sync itself failed, since the row was already
    // successfully written by this point.
    try {
      targetRange.setFontFamily(NEW_ROW_FONT_FAMILY).setFontSize(NEW_ROW_FONT_SIZE);
    } catch (formatError) {
      // Ignored deliberately -- see comment above.
    }

    // Same reasoning as the font formatting above -- keeps the new row
    // inside the sheet's own Filter range rather than dangling below it,
    // but a failure here must never look like the sync itself failed.
    try {
      extendMastersheetFilterToRow_(sheet, targetRow);
    } catch (filterError) {
      // Ignored deliberately -- see comment above.
    }

    return { rowNumber: targetRow, employeeId: employeeId };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Grows the Mastersheet's basic Filter (Data > Create a filter) so
 * `targetRow` falls inside it, if it doesn't already -- confirmed live
 * that a plain setValues() write (what addEmployeeRow_() does, deliberately
 * instead of appendRow() -- see this file's module docstring) does NOT
 * auto-extend an existing Filter's range the way typing into the very next
 * row by hand does, which is why synced rows kept landing visibly below
 * the filtered area instead of inside it.
 *
 * No-ops if there's no Filter, or targetRow is already covered.
 * Apps Script's Filter class has no setRange() -- growing it means
 * removing and recreating it over the wider range, so any column's
 * existing hide-filter criteria is read first and reapplied afterward
 * rather than silently lost. Not atomic: if this throws between remove()
 * and createFilter(), the sheet is left with no filter at all rather than
 * a partially-grown one -- acceptable here since the caller only ever
 * treats this as a best-effort cosmetic step, never something a sync's
 * success depends on.
 */
function extendMastersheetFilterToRow_(sheet, targetRow) {
  var filter = sheet.getFilter();
  if (!filter) return;

  var range = filter.getRange();
  var firstRow = range.getRow();
  var firstCol = range.getColumn();
  var numCols = range.getNumColumns();
  var lastFilterRow = firstRow + range.getNumRows() - 1;
  if (targetRow <= lastFilterRow) return;

  var criteriaByColumn = {};
  for (var col = firstCol; col < firstCol + numCols; col++) {
    var criteria = filter.getColumnFilterCriteria(col);
    if (criteria) criteriaByColumn[col] = criteria;
  }

  var newRange = sheet.getRange(firstRow, firstCol, targetRow - firstRow + 1, numCols);
  filter.remove();
  var newFilter = newRange.createFilter();
  Object.keys(criteriaByColumn).forEach(function (col) {
    newFilter.setColumnFilterCriteria(parseInt(col, 10), criteriaByColumn[col]);
  });
}
