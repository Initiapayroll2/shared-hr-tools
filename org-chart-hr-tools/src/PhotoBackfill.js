/**
 * Photo Sync -- Backfill
 *
 * Pulls each employee's submitted photo (a Typeform-hosted file URL, from
 * either application form -- see PhotoMatching.gs for the exact columns)
 * into the Mastersheet/Archive_Resignees "EMPLOYEE"S PHOTO" column (CB) as a
 * real embedded image (SpreadsheetApp's "image in cell" value type, built
 * via SpreadsheetApp.newCellImage() -- NOT sheet.insertImage(), which
 * floats a picture over the grid instead of living inside the cell's value
 * and would NOT survive moveResignees_60days_headerBased_toExternalArchive()'s
 * getValues()/setValues()/deleteRow() row-moving in
 * legacy-employee-id-and-archiving/EmployeeIdAndArchiving.gs).
 *
 * Two-phase, both wired into the existing "HR Tools" menu (see onOpen() in
 * EmployeeIdAndArchiving.gs):
 *
 *   1. scanAndMatchEmployeePhotos() -- read-mostly. Any Mastersheet/Archive
 *      row whose NRIC/FIN/Passport No. exactly matches exactly one Typeform
 *      response's ID gets its photo written immediately (NRIC-class numbers
 *      are effectively unique, confirmed acceptable with Chris on
 *      2026-09-16). Every weaker (name+DOB-only, or an ambiguous multi-ID
 *      hit) match is logged to the "Photo Match Review" tab instead --
 *      NEVER auto-applied -- because a wrong match here means the wrong
 *      person's photo on someone's row, not just a wrong text value.
 *   2. applyApprovedPhotoMatches() -- run after a human ticks "Approve" on
 *      the rows they've checked in the review tab.
 *
 * Both scan for candidates across CONFIG.APPLICATION_FORM_SPREADSHEET_ID
 * (new form) AND CONFIG.OLD_APPLICATION_FORM_SPREADSHEET_ID (old form) --
 * either can supply a photo for either an active Mastersheet row or an
 * already-archived resignee.
 *
 * Depends on ARCHIVE_SPREADSHEET_ID / ARCHIVE_SHEET_NAME, both top-level
 * `const`s declared in legacy-employee-id-and-archiving/
 * EmployeeIdAndArchiving.gs -- Apps Script shares one global scope across
 * every .gs file in a project (no per-file imports), so those are already
 * visible here without redeclaring them; redeclaring would just be the
 * "defined in two places, easy to update one and forget the other" trap
 * this project's own README already flags elsewhere.
 */

var PHOTO_SYNC_HEADER_ROW = 3; // Row 3 on both MASTERSHEET and Archive_Resignees -- mirrors HEADER_ROW/ARCHIVE_HEADER_ROW in EmployeeIdAndArchiving.gs.
var PHOTO_SYNC_TIME_BUDGET_MS = 4.5 * 60 * 1000; // Apps Script's execution cap is ~6 min; stop with margin and let a re-run pick up where this left off.

var PHOTO_REVIEW_HEADERS = [
  'Approve', 'Status', 'Source Sheet', 'Source Row', 'Employee ID', 'Full Name', 'Nick Name',
  'Matched Form', 'Matched Row', 'Matched Name', 'Matched NRIC/FIN/Passport', 'Matched DOB',
  'Score', 'Why', 'Photo URL', 'Applied At',
];

/** Menu entry point 1 -- see file docstring. */
function scanAndMatchEmployeePhotos() {
  var ui = SpreadsheetApp.getUi();
  var startTime = Date.now();

  var newFormRows = readSheetRows_(CONFIG.APPLICATION_FORM_SPREADSHEET_ID, CONFIG.APPLICATION_FORM_SHEET_NAME);
  var oldFormRows = readSheetRows_(CONFIG.OLD_APPLICATION_FORM_SPREADSHEET_ID, CONFIG.OLD_APPLICATION_FORM_SHEET_NAME);

  var candidates = newFormRows.map(function (row) { return buildFormPhotoIdentity_(row, NEW_FORM_PHOTO_FIELDS); })
    .concat(oldFormRows.map(function (row) { return buildFormPhotoIdentity_(row, OLD_FORM_PHOTO_FIELDS); }))
    .filter(function (identity) { return identity.photoUrl; });

  var idIndex = {};
  candidates.forEach(function (identity) {
    if (!identity.idNorm) return;
    (idIndex[identity.idNorm] = idIndex[identity.idNorm] || []).push(identity);
  });

  var reviewSheet = ensurePhotoReviewSheet_(SpreadsheetApp.getActiveSpreadsheet());
  var alreadyLogged = readLoggedPhotoReviewKeys_(reviewSheet);

  var sources = [
    { label: 'MASTERSHEET', spreadsheetId: CONFIG.MASTERSHEET_ID, sheetName: CONFIG.MASTERSHEET_TAB_NAME },
    { label: 'Archive_Resignees', spreadsheetId: ARCHIVE_SPREADSHEET_ID, sheetName: ARCHIVE_SHEET_NAME },
  ];

  var totals = { scanned: 0, autoApplied: 0, queuedForReview: 0, alreadyHadPhoto: 0, noMatch: 0 };
  var stoppedEarly = false;

  for (var s = 0; s < sources.length; s++) {
    if (processPhotoSource_(sources[s], candidates, idIndex, reviewSheet, alreadyLogged, totals, startTime)) {
      stoppedEarly = true;
      break;
    }
  }

  ui.alert(
    'Photo Backfill -- Scan & Match' + (stoppedEarly ? ' (stopped early -- re-run to continue)' : ' (done)'),
    'Scanned: ' + totals.scanned + '\n' +
      'Auto-applied (exact NRIC/FIN/Passport match): ' + totals.autoApplied + '\n' +
      'Queued for review (fuzzy match): ' + totals.queuedForReview + '\n' +
      'Already had a photo: ' + totals.alreadyHadPhoto + '\n' +
      'No candidate found: ' + totals.noMatch + '\n\n' +
      'Open the "' + CONFIG.PHOTO_MATCH_REVIEW_SHEET_NAME + '" tab, tick Approve for the rows you confirm, then run ' +
      '"Photo Backfill: Apply Approved Matches...".',
    ui.ButtonSet.OK
  );
}

/**
 * Scans one sheet's data rows (Mastersheet or Archive_Resignees) and either
 * writes an auto-applied photo or logs a review row for each. Returns true
 * if it stopped early on the time budget (caller should treat the overall
 * run as incomplete).
 */
function processPhotoSource_(source, candidates, idIndex, reviewSheet, alreadyLogged, totals, startTime) {
  var sheet = SpreadsheetApp.openById(source.spreadsheetId).getSheetByName(source.sheetName);
  if (!sheet) throw new Error('Sheet "' + source.sheetName + '" not found (' + source.label + ').');

  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow <= PHOTO_SYNC_HEADER_ROW) return false;

  var headers = sheet.getRange(PHOTO_SYNC_HEADER_ROW, 1, 1, lastCol).getDisplayValues()[0];
  var photoCol = headers.indexOf(MASTERSHEET_EMPLOYEE_PHOTO_HEADER) + 1;
  var employeeIdCol = headers.indexOf(MASTERSHEET_EMPLOYEE_ID) + 1;
  if (!photoCol) {
    throw new Error('Column "' + MASTERSHEET_EMPLOYEE_PHOTO_HEADER + '" not found on "' + source.sheetName + '" (' + source.label + ').');
  }

  var numRows = lastRow - PHOTO_SYNC_HEADER_ROW;
  var displayValues = sheet.getRange(PHOTO_SYNC_HEADER_ROW + 1, 1, numRows, lastCol).getDisplayValues();
  var rawValues = sheet.getRange(PHOTO_SYNC_HEADER_ROW + 1, 1, numRows, lastCol).getValues();

  for (var i = 0; i < numRows; i++) {
    if (Date.now() - startTime > PHOTO_SYNC_TIME_BUDGET_MS) return true;

    var rowNumber = PHOTO_SYNC_HEADER_ROW + 1 + i;
    totals.scanned++;

    if (rawValues[i][photoCol - 1]) {
      totals.alreadyHadPhoto++;
      continue;
    }

    var reviewKey = source.label + '|' + rowNumber;
    if (alreadyLogged[reviewKey]) continue; // already queued or applied by an earlier scan

    var display = displayValues[i];
    var getCell = makePhotoRowCellGetter_(headers, display);

    var masterIdentity = buildMastersheetPhotoIdentity_(rowNumber, getCell);
    if (!masterIdentity.nameKey && !masterIdentity.idNorm) continue; // blank row inside the used range

    var employeeId = employeeIdCol ? getCell(MASTERSHEET_EMPLOYEE_ID) : '';
    var idHits = masterIdentity.idNorm ? (idIndex[masterIdentity.idNorm] || []) : [];
    var uniquePhotoUrls = uniquePhotoUrlsFrom_(idHits);

    if (uniquePhotoUrls.length === 1) {
      var applyResult = insertPhotoCellImage_(sheet, rowNumber, photoCol, uniquePhotoUrls[0]);
      appendPhotoReviewRow_(reviewSheet, {
        // approve stays true either way: a failed fetch here (dead URL,
        // transient network error) is still worth a retry via "Apply
        // Approved Matches" later without re-running the whole scan.
        approve: true,
        status: applyResult.ok ? 'Auto-Applied (exact ID match)' : 'Auto-apply failed: ' + applyResult.error,
        sourceLabel: source.label, sourceRow: rowNumber, employeeId: employeeId,
        fullName: masterIdentity.displayName, nickname: masterIdentity.nicknameNorm,
        matchedForm: idHits[0].source, matchedRow: idHits[0].rowNumber, matchedName: idHits[0].displayName,
        matchedId: idHits[0].idNorm, matchedDob: idHits[0].dobIso, score: 100,
        why: 'Exact NRIC/FIN/Passport No. match', photoUrl: uniquePhotoUrls[0],
        appliedAt: applyResult.ok ? new Date() : '',
      });
      if (applyResult.ok) totals.autoApplied++; else totals.queuedForReview++;
      continue;
    }

    // Fuzzy path -- also where an ambiguous multi-candidate exact-ID hit
    // (uniquePhotoUrls.length > 1) lands: never auto-applied, always a
    // human call, scored only against the tied ID candidates so the
    // reviewer sees exactly what's ambiguous.
    var pool = idHits.length > 1 ? idHits : candidates;
    var best = null;
    for (var c = 0; c < pool.length; c++) {
      var scored = scorePhotoCandidate_(masterIdentity, pool[c]);
      if (!best || scored.score > best.scored.score) best = { candidate: pool[c], scored: scored };
    }

    if (best && (best.scored.score >= PHOTO_MATCH_REVIEW_THRESHOLD || idHits.length > 1)) {
      appendPhotoReviewRow_(reviewSheet, {
        approve: false,
        status: idHits.length > 1 ? 'Needs review -- multiple exact ID matches' : 'Needs review',
        sourceLabel: source.label, sourceRow: rowNumber, employeeId: employeeId,
        fullName: masterIdentity.displayName, nickname: masterIdentity.nicknameNorm,
        matchedForm: best.candidate.source, matchedRow: best.candidate.rowNumber, matchedName: best.candidate.displayName,
        matchedId: best.candidate.idNorm, matchedDob: best.candidate.dobIso, score: best.scored.score,
        why: describePhotoMatchReason_(best.scored), photoUrl: best.candidate.photoUrl, appliedAt: '',
      });
      totals.queuedForReview++;
    } else {
      totals.noMatch++;
    }
  }

  return false;
}

/** Menu entry point 2 -- see file docstring. */
function applyApprovedPhotoMatches() {
  var ui = SpreadsheetApp.getUi();
  var startTime = Date.now();

  var reviewSheet = ensurePhotoReviewSheet_(SpreadsheetApp.getActiveSpreadsheet());
  var lastRow = reviewSheet.getLastRow();
  if (lastRow < 2) {
    ui.alert('Photo Backfill', 'No rows in "' + CONFIG.PHOTO_MATCH_REVIEW_SHEET_NAME +
      '" yet -- run "Photo Backfill: Scan & Match..." first.', ui.ButtonSet.OK);
    return;
  }

  var col = {};
  PHOTO_REVIEW_HEADERS.forEach(function (header, index) { col[header] = index + 1; });

  var values = reviewSheet.getRange(2, 1, lastRow - 1, PHOTO_REVIEW_HEADERS.length).getValues();

  var sourceSheets = {
    MASTERSHEET: SpreadsheetApp.openById(CONFIG.MASTERSHEET_ID).getSheetByName(CONFIG.MASTERSHEET_TAB_NAME),
    Archive_Resignees: SpreadsheetApp.openById(ARCHIVE_SPREADSHEET_ID).getSheetByName(ARCHIVE_SHEET_NAME),
  };

  var applied = 0, skippedChanged = 0, failed = 0, stoppedEarly = false;

  for (var i = 0; i < values.length; i++) {
    if (Date.now() - startTime > PHOTO_SYNC_TIME_BUDGET_MS) { stoppedEarly = true; break; }

    var row = values[i];
    var approve = row[col['Approve'] - 1];
    var status = String(row[col['Status'] - 1] || '');
    // "Applied" (this function's own success label) and "Auto-Applied ..."
    // (scanAndMatchEmployeePhotos()'s success label, set the moment an
    // exact-ID match is found -- the photo is already written by then, not
    // a pending state waiting on this function) both mean the photo is
    // already sitting in the cell. Skip both, or a re-run here would
    // needlessly re-fetch an already-succeeded photo and could overwrite a
    // perfectly good "Auto-Applied" row with a false "failed" status if the
    // source URL merely happens to be unreachable at this later moment.
    if (!approve || status === 'Applied' || status.indexOf('Auto-Applied') === 0) continue;

    var targetSheet = sourceSheets[row[col['Source Sheet'] - 1]];
    var targetRow = row[col['Source Row'] - 1];
    if (!targetSheet || !targetRow) continue;

    // Re-verify the target row still belongs to the same employee before
    // writing. The review queue is meant to be sat on for a while (that's
    // the point of a human-approval step) -- in the meantime,
    // moveResignees_60days_headerBased_toExternalArchive() or a manual edit
    // could have shifted rows underneath this recorded row number. Never
    // trust a stale row number blindly for something as identity-sensitive
    // as a photo.
    var liveHeaders = targetSheet.getRange(PHOTO_SYNC_HEADER_ROW, 1, 1, targetSheet.getLastColumn()).getDisplayValues()[0];
    var liveIdCol = liveHeaders.indexOf(MASTERSHEET_EMPLOYEE_ID) + 1;
    var liveNameCol = liveHeaders.indexOf(MASTERSHEET_FULL_NAME) + 1;
    var livePhotoCol = liveHeaders.indexOf(MASTERSHEET_EMPLOYEE_PHOTO_HEADER) + 1;
    var liveRowValues = targetSheet.getRange(targetRow, 1, 1, targetSheet.getLastColumn()).getDisplayValues()[0];
    var liveEmployeeId = liveIdCol ? String(liveRowValues[liveIdCol - 1] || '').trim() : '';
    var liveFullName = liveNameCol ? String(liveRowValues[liveNameCol - 1] || '').trim() : '';
    var expectedEmployeeId = String(row[col['Employee ID'] - 1] || '').trim();
    var expectedFullName = String(row[col['Full Name'] - 1] || '').trim();

    var rowStillMatches = expectedEmployeeId ? (liveEmployeeId === expectedEmployeeId) : (liveFullName === expectedFullName);
    if (!rowStillMatches) {
      reviewSheet.getRange(i + 2, col['Status']).setValue(
        'Skipped -- row ' + targetRow + ' no longer matches "' + expectedFullName + '"; re-scan');
      skippedChanged++;
      continue;
    }
    if (!livePhotoCol) { failed++; continue; }

    var result = insertPhotoCellImage_(targetSheet, targetRow, livePhotoCol, String(row[col['Photo URL'] - 1] || ''));
    if (result.ok) {
      reviewSheet.getRange(i + 2, col['Status']).setValue('Applied');
      reviewSheet.getRange(i + 2, col['Applied At']).setValue(new Date());
      applied++;
    } else {
      reviewSheet.getRange(i + 2, col['Status']).setValue('Apply failed: ' + result.error);
      failed++;
    }
  }

  ui.alert(
    'Photo Backfill -- Apply Approved Matches' + (stoppedEarly ? ' (stopped early -- re-run to continue)' : ''),
    'Applied: ' + applied + '\nSkipped (row changed -- re-scan): ' + skippedChanged + '\nFailed: ' + failed,
    ui.ButtonSet.OK
  );
}

/** Builds the "image in cell" value and writes it -- never sheet.insertImage() (see file docstring for why). */
function insertPhotoCellImage_(sheet, row, col, url) {
  try {
    var image = SpreadsheetApp.newCellImage().setSourceUrl(url).build();
    sheet.getRange(row, col).setValue(image);
    return { ok: true };
  } catch (err) {
    var rawMessage = String((err && err.message) || err);
    return { ok: false, error: diagnosePhotoFetchFailure_(url) + ' [Sheets error: ' + rawMessage + ']' };
  }
}

// Google Sheets' own "image in cell" area cap -- confirmed via Google's
// published docs (support.google.com/docs/answer/9224754, checked
// 2026-09-17): images over roughly 1024x1024 (1,048,576 px^2) get rejected.
// Sheets' own error for this ("Error retrieving image from URL or bad URL")
// is identical whether the real cause is oversized, a dead link, or the
// wrong file type entirely -- diagnosePhotoFetchFailure_() re-fetches the
// URL itself (only ever on the failure path, never during a normal
// successful insert) to tell those apart for the review sheet.
var PHOTO_MAX_CELL_IMAGE_PIXELS = 1048576;

/**
 * Best-effort human-readable reason a photo URL failed to embed. Never
 * throws -- any problem probing the URL just becomes part of the message,
 * since this only runs after insertPhotoCellImage_() has already failed and
 * must never itself block reporting that failure.
 */
function diagnosePhotoFetchFailure_(url) {
  if (!url) return 'No photo URL was recorded for this match';
  var response;
  try {
    response = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
  } catch (fetchError) {
    return 'Could not reach the source URL at all (' + String((fetchError && fetchError.message) || fetchError) + ')';
  }
  var status = response.getResponseCode();
  if (status !== 200) {
    return 'Source file no longer available (HTTP ' + status + ') -- likely deleted/expired on Typeform\'s side; needs a fresh photo from this person';
  }
  var blob = response.getBlob();
  var contentType = String(blob.getContentType() || '').toLowerCase();
  if (contentType.indexOf('image/') !== 0) {
    return 'The uploaded file is not an image (it\'s ' + (contentType || 'an unrecognized type') +
      ') -- wrong file was attached to the photo question; needs a fresh photo from this person';
  }
  var dimensions = null;
  try {
    var bytes = blob.getBytes();
    dimensions = contentType.indexOf('png') !== -1 ? getPngPixelDimensions_(bytes) : getJpegPixelDimensions_(bytes);
  } catch (dimensionError) {
    dimensions = null;
  }
  if (dimensions && dimensions.width && dimensions.height) {
    var pixels = dimensions.width * dimensions.height;
    if (pixels > PHOTO_MAX_CELL_IMAGE_PIXELS) {
      return 'Photo is ' + dimensions.width + 'x' + dimensions.height + ' px (' + (Math.round(pixels / 100000) / 10) +
        'MP) -- too large for Sheets\' image-in-cell limit (~1MP); needs to be resized down before it can be embedded';
    }
  }
  return 'Sheets rejected this image for an unrecognized reason (the file itself fetched fine' +
    (dimensions ? ', ' + dimensions.width + 'x' + dimensions.height + ' px' : '') + ')';
}

/** Width/height from raw JPEG bytes (first SOFn marker) -- returns null rather than throwing if the format is unexpected. */
function getJpegPixelDimensions_(bytes) {
  var u = function (b) { return b < 0 ? b + 256 : b; };
  var i = 2;
  while (i + 8 < bytes.length) {
    if (u(bytes[i]) !== 0xFF) { i++; continue; }
    var marker = u(bytes[i + 1]);
    if (marker === 0xD8 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) { i += 2; continue; }
    if (marker === 0xD9 || marker === 0xDA) break; // EOI / start of scan -- no SOF found
    var blockLen = (u(bytes[i + 2]) << 8) + u(bytes[i + 3]);
    var isSof = marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC;
    if (isSof) {
      return {
        height: (u(bytes[i + 5]) << 8) + u(bytes[i + 6]),
        width: (u(bytes[i + 7]) << 8) + u(bytes[i + 8]),
      };
    }
    i += 2 + blockLen;
  }
  return null;
}

/** Width/height from raw PNG bytes (fixed IHDR offset) -- returns null rather than throwing if the format is unexpected. */
function getPngPixelDimensions_(bytes) {
  var u = function (b) { return b < 0 ? b + 256 : b; };
  if (bytes.length < 24) return null;
  return {
    width: (u(bytes[16]) << 24) | (u(bytes[17]) << 16) | (u(bytes[18]) << 8) | u(bytes[19]),
    height: (u(bytes[20]) << 24) | (u(bytes[21]) << 16) | (u(bytes[22]) << 8) | u(bytes[23]),
  };
}

/**
 * Menu entry point -- re-labels every already-failed row in "Photo Match
 * Review" with a specific, human reason (dead link / wrong file type / too
 * large / unknown) instead of Sheets' one generic error message. Diagnosis
 * only, never retries the embed itself -- run "Apply Approved Matches..."
 * again afterward for any of these worth retrying (a dead link or an
 * oversized photo won't succeed on retry alone; see each row's new Status
 * text for which).
 */
function diagnoseFailedPhotoMatches() {
  var ui = SpreadsheetApp.getUi();
  var startTime = Date.now();

  var reviewSheet = ensurePhotoReviewSheet_(SpreadsheetApp.getActiveSpreadsheet());
  var lastRow = reviewSheet.getLastRow();
  if (lastRow < 2) {
    ui.alert('Photo Backfill', 'No rows in "' + CONFIG.PHOTO_MATCH_REVIEW_SHEET_NAME + '" yet.', ui.ButtonSet.OK);
    return;
  }

  var col = {};
  PHOTO_REVIEW_HEADERS.forEach(function (header, index) { col[header] = index + 1; });

  var values = reviewSheet.getRange(2, 1, lastRow - 1, PHOTO_REVIEW_HEADERS.length).getValues();
  var diagnosed = 0, stoppedEarly = false;

  for (var i = 0; i < values.length; i++) {
    if (Date.now() - startTime > PHOTO_SYNC_TIME_BUDGET_MS) { stoppedEarly = true; break; }

    var status = String(values[i][col['Status'] - 1] || '');
    var isFailed = /^(Apply failed|Auto-apply failed):/.test(status);
    if (!isFailed) continue;

    var url = String(values[i][col['Photo URL'] - 1] || '');
    var prefix = /^Auto-apply failed/.test(status) ? 'Auto-apply failed: ' : 'Apply failed: ';
    reviewSheet.getRange(i + 2, col['Status']).setValue(prefix + diagnosePhotoFetchFailure_(url));
    diagnosed++;
  }

  ui.alert(
    'Photo Backfill -- Diagnose Failed Matches' + (stoppedEarly ? ' (stopped early -- re-run to continue)' : ''),
    'Re-labeled ' + diagnosed + ' failed row(s) with a specific reason.',
    ui.ButtonSet.OK
  );
}

function makePhotoRowCellGetter_(headers, displayRow) {
  return function (header) {
    var index = headers.indexOf(header);
    return index === -1 ? '' : String(displayRow[index] || '').trim();
  };
}

function uniquePhotoUrlsFrom_(identities) {
  var seen = {};
  var urls = [];
  identities.forEach(function (identity) {
    if (identity.photoUrl && !seen[identity.photoUrl]) {
      seen[identity.photoUrl] = true;
      urls.push(identity.photoUrl);
    }
  });
  return urls;
}

function describePhotoMatchReason_(scored) {
  var parts = [];
  if (scored.dobExact) parts.push('DOB match');
  if (scored.nicknameExact) parts.push('nickname match');
  parts.push('name similarity ' + Math.round(scored.nameRatio * 100) + '%');
  return parts.join(', ');
}

function ensurePhotoReviewSheet_(ss) {
  var sheet = ss.getSheetByName(CONFIG.PHOTO_MATCH_REVIEW_SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(CONFIG.PHOTO_MATCH_REVIEW_SHEET_NAME);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, PHOTO_REVIEW_HEADERS.length).setValues([PHOTO_REVIEW_HEADERS]);
    sheet.getRange(1, 1, 1, PHOTO_REVIEW_HEADERS.length).setFontWeight('bold');
    sheet.setFrozenRows(1);
    // Deliberately NOT pre-applying checkbox validation down the sheet's
    // ~1000 default blank rows here -- confirmed live (2026-09-16) that
    // doing so makes Sheets treat every one of those still-empty rows as
    // "has content" for appendRow()'s purposes, so real review rows only
    // started appending after row 1000. Each row gets its own checkbox
    // validation individually, in appendPhotoReviewRow_(), right when it's
    // actually written.
  }
  return sheet;
}

function readLoggedPhotoReviewKeys_(reviewSheet) {
  var lastRow = reviewSheet.getLastRow();
  var keys = {};
  if (lastRow < 2) return keys;
  var sourceIndex = PHOTO_REVIEW_HEADERS.indexOf('Source Sheet');
  var rowIndex = PHOTO_REVIEW_HEADERS.indexOf('Source Row');
  var values = reviewSheet.getRange(2, 1, lastRow - 1, PHOTO_REVIEW_HEADERS.length).getDisplayValues();
  values.forEach(function (row) {
    keys[row[sourceIndex] + '|' + row[rowIndex]] = true;
  });
  return keys;
}

function appendPhotoReviewRow_(reviewSheet, data) {
  reviewSheet.appendRow([
    data.approve, data.status, data.sourceLabel, data.sourceRow, data.employeeId, data.fullName, data.nickname,
    data.matchedForm, data.matchedRow, data.matchedName, data.matchedId, data.matchedDob,
    data.score, data.why, data.photoUrl, data.appliedAt,
  ]);
  var approveCol = PHOTO_REVIEW_HEADERS.indexOf('Approve') + 1;
  var rule = SpreadsheetApp.newDataValidation().requireCheckbox().build();
  reviewSheet.getRange(reviewSheet.getLastRow(), approveCol).setDataValidation(rule);
}
