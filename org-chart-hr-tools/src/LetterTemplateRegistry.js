/**
 * Letter template catalog -- reads the "SG All Form" spreadsheet's
 * "SG ALL FORMS" tab live at call time, never hardcoded, same pattern as
 * getOfficialEntityOptions_()/getPositionOptions_() elsewhere in this
 * project. Confirmed live on 2026-08-19: row CONFIG.LETTER_TEMPLATES_HEADER_ROW
 * (2) is the header, data runs to row 60 (59 templates). Columns:
 *   A Letter Type      B Field       C Content
 *   D Active Templates (checkbox)    E Link (display chip -- do not read,
 *                                       it's just a filename label)
 *   F Raw Link (the actual docs.google.com/drive.google.com URL)
 */

var LETTER_TEMPLATE_COLUMNS = {
  LETTER_TYPE: 0,
  FIELD: 1,
  CONTENT: 2,
  ACTIVE: 3,
  DISPLAY_LINK: 4,
  RAW_LINK: 5,
};

/**
 * Drive file/folder id parsed out of a docs.google.com/drive.google.com
 * URL, or null if unrecognized. A couple of catalog rows (the NDA ones)
 * point at a folder of templates rather than a single document -- isFolder
 * flags that case so a later generation step can decide what to do with it
 * instead of silently mis-treating a folder as a single template doc.
 */
function extractDriveId_(url) {
  var text = String(url || '');
  var match = /\/(?:document|file)\/d\/([a-zA-Z0-9_-]+)/.exec(text);
  if (match) return { id: match[1], isFolder: false };
  match = /\/folders\/([a-zA-Z0-9_-]+)/.exec(text);
  if (match) return { id: match[1], isFolder: true };
  return null;
}

/**
 * The full live catalog, active templates only, each entry:
 * {letterType, field, content, rawLink, driveId, isFolder}. A row is
 * skipped (not an error) if it's blank, not marked Active, or its Raw Link
 * doesn't parse to a recognizable Drive URL -- keeps one malformed catalog
 * row from breaking the whole sidebar.
 */
function getLetterTemplateCatalog_() {
  var sheet = SpreadsheetApp.openById(CONFIG.LETTER_TEMPLATES_SHEET_ID).getSheetByName(CONFIG.LETTER_TEMPLATES_TAB_NAME);
  if (!sheet) {
    throw new Error('Sheet "' + CONFIG.LETTER_TEMPLATES_TAB_NAME + '" was not found in the letter template spreadsheet.');
  }
  var startRow = CONFIG.LETTER_TEMPLATES_HEADER_ROW + 1;
  var lastRow = sheet.getLastRow();
  if (lastRow < startRow) return [];
  var values = sheet.getRange(startRow, 1, lastRow - startRow + 1, 6).getValues();

  var catalog = [];
  values.forEach(function (row) {
    var letterType = String(row[LETTER_TEMPLATE_COLUMNS.LETTER_TYPE] || '').trim();
    var content = String(row[LETTER_TEMPLATE_COLUMNS.CONTENT] || '').trim();
    if (!letterType && !content) return; // blank spacer row
    var active = row[LETTER_TEMPLATE_COLUMNS.ACTIVE] === true;
    if (!active) return;
    var rawLink = String(row[LETTER_TEMPLATE_COLUMNS.RAW_LINK] || '').trim();
    var driveRef = extractDriveId_(rawLink);
    if (!driveRef) return;
    catalog.push({
      letterType: letterType,
      field: String(row[LETTER_TEMPLATE_COLUMNS.FIELD] || '').trim(),
      content: content,
      rawLink: rawLink,
      driveId: driveRef.id,
      isFolder: driveRef.isFolder,
    });
  });
  return catalog;
}

/**
 * Case-insensitive substring search across Letter Type + Field + Content,
 * active templates only -- backs the sidebar's search-as-you-type box (see
 * LetterSidebar.html). Capped at `maxResults` so the result dropdown never
 * grows back into the "59-item wall" the search box was built to avoid.
 * Each result's `key` is the template's Drive id -- stable across searches,
 * used by the client to track picked chips and (later) to re-resolve the
 * real catalog entry server-side at generation time rather than trusting
 * anything the client cached.
 */
function searchLetterTemplates_(query, maxResults) {
  maxResults = maxResults || 8;
  var trimmed = String(query || '').trim().toLowerCase();
  if (!trimmed) return [];
  var catalog = getLetterTemplateCatalog_();
  var matches = catalog.filter(function (entry) {
    var haystack = (entry.letterType + ' ' + entry.field + ' ' + entry.content).toLowerCase();
    return haystack.indexOf(trimmed) !== -1;
  });
  return matches.slice(0, maxResults).map(function (entry) {
    return { key: entry.driveId, letterType: entry.letterType, field: entry.field, content: entry.content };
  });
}

/**
 * A single catalog entry by its stable key (Drive id), re-fetched fresh
 * from the live catalog -- never trust a client-cached copy of a
 * template's metadata when it's about to be used to generate a real
 * document. Throws if the key no longer resolves (template deactivated or
 * removed from the catalog since the sidebar loaded).
 */
function getLetterTemplateByDriveId_(driveId) {
  var catalog = getLetterTemplateCatalog_();
  for (var i = 0; i < catalog.length; i++) {
    if (catalog[i].driveId === driveId) return catalog[i];
  }
  throw new Error('That letter template is no longer available -- it may have been deactivated. Please search and pick it again.');
}
