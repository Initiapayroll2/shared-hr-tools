/**
 * Small, dependency-free helpers shared by the Mastersheet sync and P-file
 * creation features. Each one ports a specific Python helper from the main
 * ChrisHR-AI app -- see the comment above each function for its source.
 */

/** Port of services/pfile_creation_service.py::clean_name_part(). */
function cleanNamePart_(value) {
  var str = String(value === null || value === undefined ? '' : value);
  str = str.replace(/[\\:*?"<>|\r\n]+/g, ' ');
  str = str.replace(/\s+/g, ' ');
  return str.replace(/^[ .\-]+|[ .\-]+$/g, '');
}

/** Port of services/pfile_creation_service.py::normalize_entity(). */
function normalizeEntity_(value) {
  var entity = cleanNamePart_(value || 'XXX').toUpperCase();
  // No trailing period on ' PTE. LTD' -- cleanNamePart_() above already
  // strips a trailing period (it strips trailing " .-" characters), so the
  // real Mastersheet entity names ("INITIA INTERNATIONAL PTE. LTD.") have
  // already lost theirs by the time this check runs. A suffix ending in
  // "." here would never match and this would double-suffix every real
  // entity name into "... PTE. LTD P/L" instead of cleanly stripping it.
  var suffixes = [' P/L', ' PTE LTD', ' PTE. LTD'];
  for (var i = 0; i < suffixes.length; i++) {
    var suffix = suffixes[i];
    if (entity.slice(-suffix.length) === suffix) {
      entity = entity.slice(0, -suffix.length).trim();
      break;
    }
  }
  return entity + ' P/L';
}

/**
 * Port of Python's str.title(): capitalizes the first letter of every
 * maximal run of letters and lowercases the rest -- e.g. "mcdonald's farm"
 * -> "Mcdonald'S Farm" (an apostrophe breaks the "word" the same way it
 * does in Python, this is a known/accepted quirk carried over from
 * services/mastersheet_sync_mapping_service.py::_title_case()).
 */
function titleCase_(value) {
  if (!value) return value;
  return String(value).replace(/[A-Za-z]+/g, function (word) {
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  });
}

/** Port of services/mastersheet_sync_service.py::_column_letter(). 0-indexed column number -> A1-style letter. */
function columnLetter_(index) {
  var letters = '';
  index += 1;
  while (index > 0) {
    var remainder = (index - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    index = Math.floor((index - 1) / 26);
  }
  return letters;
}

/**
 * Port of services/mastersheet_sync_service.py::_parse_submitted_at().
 * Typeform's "Submitted At" format is "M/D/YYYY H:MM:SS" (e.g.
 * "8/7/2026 6:50:40"). Returns null if it doesn't parse -- every caller
 * treats an unparseable date as "recent" (kept, not filtered out), same
 * convention as the Python original.
 */
function parseSubmittedAt_(value) {
  var match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})$/.exec(String(value || '').trim());
  if (!match) return null;
  var date = new Date(
    parseInt(match[3], 10), parseInt(match[1], 10) - 1, parseInt(match[2], 10),
    parseInt(match[4], 10), parseInt(match[5], 10), parseInt(match[6], 10)
  );
  return isNaN(date.getTime()) ? null : date;
}

/**
 * Ratcliff/Obershelp string similarity, 0..1 -- the same algorithm behind
 * Python's difflib.SequenceMatcher.ratio(), used by
 * services/mastersheet_sync_service.py::_name_similarity() to RANK Bank
 * Form candidates by name similarity. This is a from-scratch port (no
 * "junk" handling, which only matters for very long strings anyway) --
 * good enough for its one job here: ranking short human names for a
 * colleague to visually confirm, never an auto-match.
 */
function sequenceMatcherRatio_(a, b) {
  a = String(a || '').trim().toLowerCase();
  b = String(b || '').trim().toLowerCase();
  if (!a.length && !b.length) return 1.0;
  var matched = totalMatchingCharacters_(a, b);
  return (2.0 * matched) / (a.length + b.length);
}

function findLongestMatch_(a, aLo, aHi, b, bLo, bHi) {
  var b2j = {};
  for (var j = bLo; j < bHi; j++) {
    var ch = b[j];
    if (!b2j[ch]) b2j[ch] = [];
    b2j[ch].push(j);
  }
  var besti = aLo, bestj = bLo, bestsize = 0;
  var j2len = {};
  for (var i = aLo; i < aHi; i++) {
    var newj2len = {};
    var indices = b2j[a[i]] || [];
    for (var k = 0; k < indices.length; k++) {
      var jIndex = indices[k];
      var k2 = (j2len[jIndex - 1] || 0) + 1;
      newj2len[jIndex] = k2;
      if (k2 > bestsize) {
        besti = i - k2 + 1;
        bestj = jIndex - k2 + 1;
        bestsize = k2;
      }
    }
    j2len = newj2len;
  }
  return { i: besti, j: bestj, size: bestsize };
}

function totalMatchingCharacters_(a, b) {
  function recurse(aLo, aHi, bLo, bHi) {
    if (aLo >= aHi || bLo >= bHi) return 0;
    var match = findLongestMatch_(a, aLo, aHi, b, bLo, bHi);
    if (match.size === 0) return 0;
    var total = match.size;
    total += recurse(aLo, match.i, bLo, match.j);
    total += recurse(match.i + match.size, aHi, match.j + match.size, bHi);
    return total;
  }
  return recurse(0, a.length, 0, b.length);
}

/**
 * De-duplicated, non-blank display values from one column of `sheetName`,
 * `startRow` down to the sheet's last used row -- shared by every dropdown
 * this project sources from a live reference table (P-file Entity,
 * Mastersheet sync's Official Company/Position), so each one always
 * reflects the sheet's own current list rather than a hand-copied
 * snapshot. Tolerates blank rows in the middle of the range rather than
 * stopping at the first one (confirmed live: the entity reference list has
 * exactly such a gap).
 */
function readDedupedColumnValues_(spreadsheetId, sheetName, columnNumber, startRow) {
  var sheet = SpreadsheetApp.openById(spreadsheetId).getSheetByName(sheetName);
  if (!sheet) {
    throw new Error('Sheet "' + sheetName + '" was not found.');
  }
  var lastRow = sheet.getLastRow();
  if (lastRow < startRow) return [];
  var values = sheet.getRange(startRow, columnNumber, lastRow - startRow + 1, 1).getDisplayValues();
  var seen = {};
  var options = [];
  values.forEach(function (row) {
    var value = String(row[0] || '').trim();
    if (value && !seen[value]) {
      seen[value] = true;
      options.push(value);
    }
  });
  return options;
}

/**
 * The full 2D grid of `sheetName`'s display values (row 1 included) --
 * mirrors gspread's Worksheet.get_all_values(). Uses getDisplayValues()
 * rather than getValues() so numbers/dates come back as the same display
 * strings the Python side worked with (e.g. a date column reads
 * "22/10/1997", not a Date object).
 */
function getAllValues_(spreadsheetId, sheetName) {
  var sheet = SpreadsheetApp.openById(spreadsheetId).getSheetByName(sheetName);
  if (!sheet) {
    throw new Error('Sheet "' + sheetName + '" was not found in spreadsheet ' + spreadsheetId);
  }
  return sheet.getDataRange().getDisplayValues();
}

/**
 * Every data row of `sheetName` as {headers, values, rowNumber} (rowNumber
 * is the 1-indexed live sheet row) -- mirrors
 * services/mastersheet_sync_service.py::_read_sheet_rows().
 */
function readSheetRows_(spreadsheetId, sheetName) {
  var values = getAllValues_(spreadsheetId, sheetName);
  if (!values.length) return [];
  var headers = values[0];
  var rows = [];
  for (var i = 1; i < values.length; i++) {
    rows.push({ headers: headers, values: values[i], rowNumber: i + 1 });
  }
  return rows;
}
