/**
 * P-file Creation
 *
 * Port of services/pfile_creation_service.py and the Drive-side helpers it
 * uses from connectors/personal_google_drive.py. Creates (or finds) an
 * employee's Google Drive P-file folder from the P-file template, and
 * files their Typeform-submitted identity documents plus generated
 * Application/Bank response PDFs into its "04. PERSONAL INFORMATION"
 * subfolder. A matched Bank Form is optional and may be added on a rerun.
 *
 * Uses the Advanced Drive Service (v3) rather than DriveApp because
 * appProperties (the duplicate-protection key/value tags on a P-file root
 * folder) aren't exposed by DriveApp -- enable it via
 * src/appsscript.json's enabledAdvancedServices before this will run.
 *
 * Unlike the Python app, there's no separate OAuth connector: Apps Script
 * runs every call as the signed-in colleague, so as long as they have
 * access to the template/destination Drive folders and the Application
 * Form response sheet, this just works.
 */

var FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';
var PERSONAL_INFORMATION_FOLDER_NAME = '04. PERSONAL INFORMATION';
var IGNORED_TEMPLATE_NAMES = { '.DS_Store': true };
var HR_FIELD_DEFAULTS = { passType: 'xxx', department: 'xxx' };
var PFILE_TOKEN_PROPERTY_PREFIX = 'employee_pfile_folder:';

// Confirmed live against the Mastersheet's own "SG EMPLOYEE ID" legend (see
// the "SOP_MUST READ" tab): SGFT/SGPT/SGIT/SGFL are Full Time/Part
// Time/Intern/Freelance under SG Payroll. Placeholder pattern is 4 X's,
// uppercase -- matches what the P-file dialog auto-fills into the Employee
// ID field once an Employment Type is picked, so the two stay consistent
// whether or not the colleague ever looks at the folder-name preview.
var EMPLOYEE_ID_PLACEHOLDER_BY_EMPLOYMENT_TYPE = { PT: 'SGPTXXXX', FT: 'SGFTXXXX', Intern: 'SGITXXXX', Freelance: 'SGFLXXXX' };
var MIME_EXTENSION_MAP = {
  'application/pdf': '.pdf',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/heic': '.heic',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
};

// ---------------------------------------------------------------------
// Typeform reading
// ---------------------------------------------------------------------

/**
 * Every Application Form row shaped for P-file creation -- port of
 * connectors/personal_google_drive.py::read_typeform_rows(). Stable header
 * names are used rather than hard-coded column letters, since Typeform can
 * insert/reorder questions.
 */
function readTypeformApplicantRows_() {
  var sheet = SpreadsheetApp.openById(CONFIG.APPLICATION_FORM_SPREADSHEET_ID).getSheetByName(CONFIG.APPLICATION_FORM_SHEET_NAME);
  if (!sheet) {
    throw new Error('Sheet "' + CONFIG.APPLICATION_FORM_SHEET_NAME + '" was not found.');
  }
  var values = sheet.getDataRange().getDisplayValues();
  if (!values.length) return [];
  var headers = values[0].map(function (header) { return String(header).trim(); });

  function cellFor(row, header) {
    var index = headers.indexOf(header);
    return (index !== -1 && index < row.length) ? String(row[index]).trim() : '';
  }

  var rows = [];
  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    var responses = [];
    var attachments = [];
    for (var c = 0; c < headers.length; c++) {
      var header = headers[c];
      var answer = c < row.length ? String(row[c]).trim() : '';
      if (!header || !answer) continue;
      responses.push({ question: header, answer: answer });
      if (/^https?:\/\//.test(answer) && answer.indexOf('typeform.com/responses/files/') !== -1) {
        attachments.push({ question: header, url: answer });
      }
    }
    rows.push({
      rowNumber: r + 1,
      positionApplied: cellFor(row, 'Position Applied For'),
      fullName: cellFor(row, 'Full Name (as shown in NRIC/Passport )'),
      surname: cellFor(row, 'Surname ( Family Name/Last Name ):'),
      nickname: cellFor(row, 'Nickname ( English Name ):'),
      submittedAt: cellFor(row, 'Submitted At'),
      token: cellFor(row, 'Token'),
      responses: responses,
      attachments: attachments,
    });
  }
  return rows;
}

/** Port of PFileCreationService.list_applicants(): newest submission first. */
function listApplicantsForPfile_() {
  var rows = readTypeformApplicantRows_().filter(function (row) { return row.fullName; });
  rows.reverse();
  return rows;
}

/** The specific Application Form row a colleague picked, re-fetched fresh by its 1-indexed sheet row number. */
function getApplicantByRowNumber_(rowNumber) {
  var rows = readTypeformApplicantRows_();
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].rowNumber === rowNumber) return rows[i];
  }
  throw new Error('Application Form row ' + rowNumber + ' was not found -- it may have been deleted or moved.');
}

/**
 * The official entity list for the P-file dialog's Entity dropdown AND the
 * Mastersheet sync dialog's Official Company dropdown -- read fresh from
 * CONFIG.ENTITY_REFERENCE_SHEET_NAME every call, the SAME list the
 * Mastersheet's own "OFFICIAL COMPANY" column is meant to use, so a
 * colleague can't introduce a spelling variant that the Mastersheet
 * doesn't already recognize.
 *
 * Deliberately NOT read from OFFICIAL COMPANY's own live per-cell dropdown
 * validation: confirmed live that column's validation is fragmented across
 * several different row ranges with slightly different lists (e.g. one
 * fragment has "WALKING ON SUNSHINE PTE. LTD.", another has "YOU ARE MY
 * SUNSHINE PTE. LTD." -- clearly drifted from each other over time), so
 * there is no single reliable "the column's dropdown list" to read. This
 * reference sheet is the cleaner, curated source of truth.
 */
function getOfficialEntityOptions_() {
  return readDedupedColumnValues_(CONFIG.MASTERSHEET_ID, CONFIG.ENTITY_REFERENCE_SHEET_NAME, CONFIG.ENTITY_REFERENCE_COLUMN, 2);
}

/**
 * Department options for the P-file dialog's Department dropdown -- reads
 * the same 'Costing Reference Table' sheet as getPositionOptions_() (in
 * MastersheetSync.js), but its column H (CONFIG.DEPARTMENT_REFERENCE_COLUMN,
 * the VLOOKUP's own result column) rather than the Mastersheet's own
 * DEPARTMENT column, which is a live formula output there -- see
 * CONFIG.DEPARTMENT_REFERENCE_COLUMN's comment. This is the complete list --
 * nothing is appended on top, so the dialog can't offer a department the
 * Mastersheet itself wouldn't recognize.
 */
function getDepartmentOptions_() {
  return readDedupedColumnValues_(CONFIG.MASTERSHEET_ID, CONFIG.POSITION_REFERENCE_SHEET_NAME, CONFIG.DEPARTMENT_REFERENCE_COLUMN, 2);
}

// ---------------------------------------------------------------------
// Folder naming
// ---------------------------------------------------------------------

/** Return a working identity without mutating the original Typeform row -- port of apply_identity_corrections(). */
function applyIdentityCorrections_(applicant, hrFields) {
  var correctedName = cleanNamePart_((hrFields || {}).correctedFullName);
  var copy = {};
  for (var key in applicant) copy[key] = applicant[key];
  if (correctedName) copy.fullName = correctedName;
  return copy;
}

/** Port of build_folder_name(). */
function buildFolderName_(applicant, hrFields) {
  hrFields = hrFields || {};
  // Prefer the explicit Employment Type (reliable -- an HR-made choice) over
  // guessing from the Typeform application's own free-text category; the
  // latter only kicks in for an early preview before Employment Type has
  // been picked yet.
  var applicationType = String(applicant.positionApplied || '').toLowerCase();
  var temporaryEmployeeId = EMPLOYEE_ID_PLACEHOLDER_BY_EMPLOYMENT_TYPE[hrFields.employmentType] ||
    (applicationType.indexOf('part time') !== -1 ? 'SGPTXXXX' : 'SGFTXXXX');
  var values = {
    entity: normalizeEntity_(hrFields.entity),
    employeeId: hrFields.employeeId || temporaryEmployeeId,
    fullName: applicant.fullName,
    nickname: applicant.nickname || applicant.fullName,
    passType: hrFields.passType || HR_FIELD_DEFAULTS.passType,
    department: hrFields.department || HR_FIELD_DEFAULTS.department,
    // Position Applied For is a broad Typeform application category (e.g.
    // "F&B Full Time Staff"), not the confirmed job title.
    position: hrFields.position || 'xxx',
  };
  var order = ['entity', 'employeeId', 'fullName', 'nickname', 'passType', 'department', 'position'];
  var missing = order.filter(function (key) { return !cleanNamePart_(values[key]); });
  if (missing.length) {
    var labels = missing.map(function (key) {
      return titleCase_(key.replace(/([A-Z])/g, ' $1'));
    });
    throw new Error('Complete these fields: ' + labels.join(', '));
  }
  return order.map(function (key) { return cleanNamePart_(values[key]).toUpperCase(); }).join(' - ');
}

function parsePfileFolderName_(folderName) {
  var parts = String(folderName || '').split(' - ');
  if (parts.length < 7) return null;
  return {
    entity: parts[0], employeeId: parts[1], fullName: parts[2], nickname: parts[3],
    passType: parts[4], department: parts[5], position: parts.slice(6).join(' - '),
  };
}

function isEmployeeIdPlaceholder_(value) {
  var normalized = String(value || '').trim().toUpperCase();
  return Object.keys(EMPLOYEE_ID_PLACEHOLDER_BY_EMPLOYMENT_TYPE).some(function (key) {
    return EMPLOYEE_ID_PLACEHOLDER_BY_EMPLOYMENT_TYPE[key] === normalized;
  });
}

/** Blank inputs preserve an existing folder-name segment on later reruns. */
function buildUpdatedFolderName_(existingName, applicant, hrFields) {
  var existing = parsePfileFolderName_(existingName);
  if (!existing) return existingName;
  hrFields = hrFields || {};
  var explicitEmployeeId = cleanNamePart_(hrFields.employeeId);
  var values = {
    entity: cleanNamePart_(hrFields.entity) ? normalizeEntity_(hrFields.entity) : existing.entity,
    employeeId: explicitEmployeeId && !isEmployeeIdPlaceholder_(explicitEmployeeId) ? explicitEmployeeId : existing.employeeId,
    fullName: cleanNamePart_(hrFields.correctedFullName) ? applicant.fullName : existing.fullName,
    nickname: existing.nickname,
    passType: cleanNamePart_(hrFields.passType) || existing.passType,
    department: cleanNamePart_(hrFields.department) || existing.department,
    position: cleanNamePart_(hrFields.position) || existing.position,
  };
  return ['entity', 'employeeId', 'fullName', 'nickname', 'passType', 'department', 'position']
    .map(function (key) { return cleanNamePart_(values[key]).toUpperCase(); }).join(' - ');
}

/** Port of PFileCreationService.preview(). */
function previewPfileFolderName_(applicant, hrFields) {
  return buildFolderName_(applyIdentityCorrections_(applicant, hrFields), hrFields);
}

/**
 * The destination Drive folder ID for `employmentType` ("PT" / "FT" /
 * "Intern" / "Freelance", matching CONFIG.DESTINATION_FOLDER_IDS's keys and
 * the P-file dialog's dropdown exactly) -- Apps-Script-only addition, not
 * present in the Python app (see README's "Key differences" section). Throws
 * with the valid options listed if `employmentType` is missing or doesn't
 * match one of them, rather than silently falling back to any one folder.
 */
function resolveDestinationFolderId_(employmentType) {
  var folderId = CONFIG.DESTINATION_FOLDER_IDS[employmentType];
  if (!folderId) {
    throw new Error('Select an Employment Type (' + Object.keys(CONFIG.DESTINATION_FOLDER_IDS).join(' / ') + ') before creating the P-file.');
  }
  return folderId;
}

// ---------------------------------------------------------------------
// Drive helpers (Advanced Drive Service v3)
// ---------------------------------------------------------------------

function escapeDriveQueryValue_(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function shouldIgnoreTemplateItem_(name) {
  name = String(name || '');
  return !!IGNORED_TEMPLATE_NAMES[name] || name.indexOf('._') === 0;
}

function driveGetFile_(fileId) {
  return Drive.Files.get(fileId, { fields: 'id,name,mimeType,trashed,webViewLink' });
}

function driveFindPfileForToken_(parentId, token) {
  var safe = escapeDriveQueryValue_(token);
  var query = "'" + parentId + "' in parents and trashed = false and " +
    "appProperties has { key='chris_hr_type' and value='employee_pfile' } and " +
    "appProperties has { key='typeform_token' and value='" + safe + "' }";
  var result = Drive.Files.list({ q: query, fields: 'files(id,name,webViewLink)', pageSize: 10 });
  return result.files || [];
}

function driveFindPfilesAcrossDestinations_(token) {
  var byId = {};
  Object.keys(CONFIG.DESTINATION_FOLDER_IDS).forEach(function (employmentType) {
    var parentId = CONFIG.DESTINATION_FOLDER_IDS[employmentType];
    driveFindPfileForToken_(parentId, token).forEach(function (file) {
      if (!byId[file.id]) {
        file.employmentType = employmentType;
        file.parentId = parentId;
        byId[file.id] = file;
      }
    });
  });
  return Object.keys(byId).map(function (id) { return byId[id]; });
}

function pfilePropertyKey_(token) {
  return PFILE_TOKEN_PROPERTY_PREFIX + token;
}

function rememberPfileForToken_(token, folderId) {
  PropertiesService.getScriptProperties().setProperty(pfilePropertyKey_(token), folderId);
}

function findRememberedPfile_(token) {
  var properties = PropertiesService.getScriptProperties();
  var key = pfilePropertyKey_(token);
  var folderId = properties.getProperty(key);
  if (!folderId) return null;
  try {
    var file = driveGetFile_(folderId);
    if (!file.trashed && file.mimeType === FOLDER_MIME_TYPE) return file;
  } catch (ignored) {}
  properties.deleteProperty(key);
  return null;
}

function driveCreateFolder_(name, parentId, appProperties) {
  var folder = DriveApp.getFolderById(parentId).createFolder(name);
  return Drive.Files.get(folder.getId(), { fields: 'id,name,webViewLink' });
}

function driveCopyFolderContentsRecursive_(sourceFolderId, destinationFolderId) {
  var pageToken = null;
  do {
    var result = Drive.Files.list({
      q: "'" + sourceFolderId + "' in parents and trashed = false",
      fields: 'nextPageToken,files(id,name,mimeType)',
      pageSize: 1000,
      pageToken: pageToken || undefined,
    });
    var files = result.files || [];
    for (var i = 0; i < files.length; i++) {
      var item = files[i];
      if (shouldIgnoreTemplateItem_(item.name)) continue;
      if (item.mimeType === FOLDER_MIME_TYPE) {
        var child = driveCreateFolder_(item.name, destinationFolderId);
        driveCopyFolderContentsRecursive_(item.id, child.id);
      } else {
        Drive.Files.copy({ name: item.name, parents: [destinationFolderId] }, item.id);
      }
    }
    pageToken = result.nextPageToken;
  } while (pageToken);
}

function driveTrashFile_(fileId) {
  Drive.Files.update({ trashed: true }, fileId);
}

function driveRenameFile_(fileId, name) {
  // This Advanced Drive binding treats the third argument as mediaData,
  // not optional fields. Rename with metadata only, then fetch the result.
  Drive.Files.update({ name: name }, fileId);
  return Drive.Files.get(fileId, { fields: 'id,name,webViewLink' });
}

function driveFindChildFolder_(parentId, name) {
  var safe = escapeDriveQueryValue_(name);
  var query = "'" + parentId + "' in parents and trashed = false and mimeType = '" + FOLDER_MIME_TYPE + "' and name = '" + safe + "'";
  var result = Drive.Files.list({ q: query, fields: 'files(id,name,webViewLink)', pageSize: 10 });
  var files = result.files || [];
  return files.length ? files[0] : null;
}

function driveFindFileByName_(parentId, name) {
  var safe = escapeDriveQueryValue_(name);
  var query = "'" + parentId + "' in parents and trashed = false and name = '" + safe + "'";
  var result = Drive.Files.list({ q: query, fields: 'files(id,name,webViewLink,mimeType)', pageSize: 10 });
  var files = result.files || [];
  return files.length ? files[0] : null;
}

function findApplicationFormPdfInPfile_(pfileRootId, fullName) {
  var personal = driveFindChildFolder_(pfileRootId, PERSONAL_INFORMATION_FOLDER_NAME);
  if (!personal) return null;
  return driveFindFileByName_(personal.id, 'Application Form - ' + safeTitle_(fullName) + '.pdf');
}

function driveUploadBytes_(parentId, name, blob) {
  blob.setName(name);
  var file = DriveApp.getFolderById(parentId).createFile(blob);
  return {
    id: file.getId(),
    name: file.getName(),
    webViewLink: file.getUrl(),
    mimeType: file.getMimeType(),
  };
}

function driveReplaceGeneratedFile_(parentId, name, blob) {
  var existing = driveFindFileByName_(parentId, name);
  var temporaryName = name + '.generating';
  var staleTemporary = driveFindFileByName_(parentId, temporaryName);
  if (staleTemporary) driveTrashFile_(staleTemporary.id);
  var created = driveUploadBytes_(parentId, temporaryName, blob);
  if (existing) driveTrashFile_(existing.id);
  driveRenameFile_(created.id, name);
  return existing ? 'updated' : 'uploaded';
}

function guessExtensionFromMimeType_(mimeType) {
  return MIME_EXTENSION_MAP[mimeType] || '';
}

/** Port of connectors/personal_google_drive.py::download_typeform_file(). */
function driveDownloadTypeformFile_(url) {
  var response = UrlFetchApp.fetch(url);
  var blob = response.getBlob();
  var headers = response.getHeaders();
  var contentType = (headers['Content-Type'] || headers['content-type'] || blob.getContentType() || 'application/octet-stream')
    .split(';')[0].trim();
  var pathOnly = url.split('?')[0];
  var suffixMatch = /\.[a-zA-Z0-9]+$/.exec(pathOnly);
  var extension = (suffixMatch ? suffixMatch[0] : '') || guessExtensionFromMimeType_(contentType) || '';
  return { blob: blob, mimeType: contentType, extension: extension.toLowerCase() };
}

function htmlEscape_(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function typeformUploadFilename_(url) {
  var path = String(url || '').split('?')[0];
  try { path = decodeURIComponent(path); } catch (ignored) {}
  return path.substring(path.lastIndexOf('/') + 1) || 'Uploaded file';
}

function responsePairsFromSheetRow_(row) {
  var pairs = [];
  var headers = row.headers || [];
  var values = row.values || [];
  for (var i = 0; i < headers.length; i++) {
    var question = String(headers[i] || '').trim();
    var answer = i < values.length ? String(values[i] || '').trim() : '';
    if (!question || !answer) continue;
    pairs.push({ question: question, answer: answer });
  }
  return pairs;
}

function typeformQuestionKind_(question, answer) {
  var q = String(question || '').toLowerCase();
  if (/^https?:\/\//.test(answer) && answer.indexOf('typeform.com/responses/files/') !== -1) return 'upload';
  if (q.indexOf('date') !== -1 || q.indexOf('birth') !== -1) return 'date';
  if (q.indexOf('declare') !== -1 || q.indexOf('have you') !== -1 || q.indexOf('illness') !== -1 || q.indexOf('disability') !== -1 || q.indexOf('gender') !== -1 || q.indexOf('status') !== -1) return 'choice';
  if (q.indexOf('response id') !== -1 || q.indexOf('token') !== -1) return 'hidden';
  return 'text';
}

function applicationSectionForQuestion_(question) {
  var q = String(question || '').toLowerCase();
  if (q.indexOf('position applied') !== -1) return 'Position Applied For';
  if (q.indexOf('full name') !== -1) return 'Personal Information';
  if (q.indexOf('race') !== -1) return 'Personal Information Part 2';
  if (q.indexOf('mobile') !== -1 || q.indexOf('email address') !== -1) return 'Contact Information';
  if (q.indexOf('front of your nric') !== -1 || q.indexOf('back of your nric') !== -1) return 'Uploading of documents for Local Applicant';
  if (q.indexOf('nric no') !== -1 || q.indexOf('residential address') !== -1 || q.indexOf('highest qualification') !== -1) return 'Local Job Applicant';
  if (q.indexOf('emergency contact') !== -1) return 'Emergency Contact Details';
  if (q.indexOf('have you ever') !== -1 || q.indexOf('illness') !== -1 || q.indexOf('mbti') !== -1) return 'Other Information';
  if (q.indexOf('children') !== -1) return 'Child Care Leave & Benefit Eligibility';
  if (q.indexOf('resume') !== -1 || q.indexOf('professional photo') !== -1 || q.indexOf('casual photo') !== -1 || q.indexOf('certificate') !== -1) return 'Uploading of all other documents';
  if (q.indexOf('declare') !== -1) return 'Declaration';
  if (q.indexOf('interview') !== -1) return "Interviewer's Information";
  if (q.indexOf('referred') !== -1) return 'Referrals';
  if (q === 'ending') return 'Ending';
  if (q.indexOf('response id') !== -1 || q === 'token') return 'Response ID';
  return '';
}

function renderTypeformResponsePdf_(title, submittedAt, pairs) {
  var activeSection = '';
  var rows = pairs.map(function (pair) {
    var kind = typeformQuestionKind_(pair.question, pair.answer);
    var answer = kind === 'upload' ? typeformUploadFilename_(pair.answer) : pair.answer;
    var glyph = kind === 'upload' ? '&#8679;' : (kind === 'date' ? '&#9634;' : (kind === 'choice' ? '&nbsp;' : (kind === 'hidden' ? '&#8709;' : '&#61;')));
    var answerClass = (kind === 'choice' || kind === 'upload') ? 'answer pill' : 'answer';
    var section = title === 'Application Form' ? applicationSectionForQuestion_(pair.question) : '';
    var sectionHtml = '';
    if (section && section !== activeSection) {
      activeSection = section;
      sectionHtml = '<div class="section"><span class="section-icon">&#9776;</span><strong>' + htmlEscape_(section) + '</strong></div>';
    }
    return sectionHtml + '<div class="question"><div class="qline"><span class="icon ' + kind + '">' + glyph + '</span><span>' +
      htmlEscape_(pair.question) + '</span></div><div class="' + answerClass + '">' + htmlEscape_(answer) + '</div></div>';
  }).join('');
  var html = '<!doctype html><html><head><meta charset="UTF-8"><style>' +
    '@page{size:A4;margin:15mm 14mm}*{box-sizing:border-box}body{font-family:Arial,sans-serif;color:#5f5b66;font-size:14px;line-height:1.4;margin:0}' +
    '.top{font-size:14px;margin:2px 0 18px 45px}.card{border-radius:10px}.section{display:flex;align-items:center;gap:10px;font-size:15px;padding:11px 0;border-top:1px solid #eee}' +
    '.section:first-child{border-top:0}.section-icon{background:#e4e3e6;border-radius:5px;padding:4px 7px;color:#3f3d43}.question{padding:7px 0 10px 42px;page-break-inside:avoid}' +
    '.qline{display:flex;align-items:flex-start;gap:10px;margin-left:-32px;line-height:1.35}.icon{width:23px;min-width:23px;text-align:center;border-radius:6px;padding:4px 2px;font-size:12px;font-weight:bold}' +
    '.text{background:#cce8ff;color:#255b78}.choice{background:#ddd2ff;color:#51427a}.date{background:#ffe09a;color:#775715}.upload{background:#ffe09a;color:#775715}.hidden{background:#e1dcf5;color:#574d7a}' +
    '.answer{margin:7px 0 0 0;color:#3f3b44;white-space:pre-wrap;overflow-wrap:anywhere}.pill{display:inline-block;border:1px solid #8e8992;border-radius:5px;padding:3px 8px;max-width:100%}' +
    '</style></head><body><div class="top">' + htmlEscape_(submittedAt || '') + '</div><div class="card"><div class="section"><span class="section-icon">&#9776;</span><strong>' +
    htmlEscape_(title) + '</strong></div>' + rows + '</div></body></html>';
  var converted = HtmlService.createHtmlOutput(html).getBlob().getAs(MimeType.PDF);
  // HtmlOutput's converted blob is accepted by some Apps Script services
  // but Advanced Drive's mediaData parameter requires a native Blob.
  return Utilities.newBlob(converted.getBytes(), MimeType.PDF, title + '.pdf');
}

function applicationPdfPairs_(applicant) {
  return (applicant.responses || []).map(function (entry) {
    return { question: entry.question, answer: entry.answer };
  });
}

function bankScreenshotAttachments_(bankRow) {
  return responsePairsFromSheetRow_(bankRow).filter(function (pair) {
    return /^https?:\/\//.test(pair.answer) && pair.answer.indexOf('typeform.com/responses/files/') !== -1 &&
      /bank account number details|supporting.*bank|screenshot.*bank/i.test(pair.question);
  });
}

function documentIdentity_(applicant) {
  return safeTitle_(applicant.fullName) + ' - ' + safeTitle_(applicant.nickname || applicant.fullName);
}

function populateGeneratedForms_(rootFolderId, applicant, bankRow) {
  var uploaded = [], skipped = [], failed = [];
  var personal = driveFindChildFolder_(rootFolderId, PERSONAL_INFORMATION_FOLDER_NAME);
  if (!personal) return { uploaded: uploaded, skipped: skipped, failed: ['04. PERSONAL INFORMATION folder was not found'] };
  var personalFolderId = personal.id;
  var applicationName = 'Application Form - ' + safeTitle_(applicant.fullName) + '.pdf';
  try {
    var applicationPdf = renderTypeformResponsePdf_('Application Form', applicant.submittedAt, applicationPdfPairs_(applicant));
    driveReplaceGeneratedFile_(personalFolderId, applicationName, applicationPdf);
    uploaded.push(applicationName);
  } catch (error) {
    failed.push(applicationName + ': ' + (error && error.message ? error.message : error));
  }

  if (!bankRow) return { uploaded: uploaded, skipped: skipped, failed: failed };

  var bankName = 'Bank Form - ' + documentIdentity_(applicant) + '.pdf';
  try {
    var bankPdf = renderTypeformResponsePdf_('Bank Giro Form', cell_(bankRow, 'Submitted At'), responsePairsFromSheetRow_(bankRow));
    driveReplaceGeneratedFile_(personalFolderId, bankName, bankPdf);
    uploaded.push(bankName);
  } catch (error) {
    failed.push(bankName + ': ' + (error && error.message ? error.message : error));
  }

  var screenshots = bankScreenshotAttachments_(bankRow);
  screenshots.forEach(function (item, index) {
    var provisional = 'Bank Details' + (screenshots.length > 1 ? ' ' + ('0' + (index + 1)).slice(-2) : '') + ' - ' + documentIdentity_(applicant);
    try {
      var downloaded = driveDownloadTypeformFile_(item.answer);
      var filename = provisional + downloaded.extension;
      if (driveFindFileByName_(personalFolderId, filename)) {
        skipped.push(filename);
      } else {
        driveUploadBytes_(personalFolderId, filename, downloaded.blob);
        uploaded.push(filename);
      }
    } catch (error) {
      failed.push(provisional + ': ' + (error && error.message ? error.message : error));
    }
  });
  if (!screenshots.length) failed.push('Bank Details: no supporting screenshot was found in the selected Bank Form response');
  return { uploaded: uploaded, skipped: skipped, failed: failed };
}

function mergeDocumentResults_(first, second) {
  return {
    uploaded: (first.uploaded || []).concat(second.uploaded || []),
    skipped: (first.skipped || []).concat(second.skipped || []),
    failed: (first.failed || []).concat(second.failed || []),
  };
}

// ---------------------------------------------------------------------
// P-file creation
// ---------------------------------------------------------------------

/**
 * Port of PFileCreationService._populate_personal_information(): downloads
 * every Typeform attachment on `applicant` and files it into the P-file's
 * "04. PERSONAL INFORMATION" subfolder under its business-meaningful name,
 * skipping anything already uploaded and renaming legacy generically-named
 * NRIC/work-pass files in place rather than duplicating them.
 */
function populatePersonalInformation_(rootFolderId, applicant) {
  var personal = driveFindChildFolder_(rootFolderId, PERSONAL_INFORMATION_FOLDER_NAME);
  if (!personal) {
    return { uploaded: [], skipped: [], failed: ['04. PERSONAL INFORMATION folder was not found'] };
  }

  var uploaded = [], skipped = [], failed = [];
  var attachments = applicant.attachments || [];
  var passType = applicant.hrPassType;

  var labelTotals = {};
  attachments.forEach(function (item) {
    var label = attachmentLabel_(item.question, passType);
    labelTotals[label] = (labelTotals[label] || 0) + 1;
  });
  var labelSeen = {};

  attachments.forEach(function (item) {
    var question = item.question;
    var label = attachmentLabel_(question, passType);
    labelSeen[label] = (labelSeen[label] || 0) + 1;
    var sequence = labelTotals[label] > 1 ? labelSeen[label] : null;
    var provisionalName = documentFilename_(label, applicant, '', sequence);
    try {
      var downloaded = driveDownloadTypeformFile_(item.url);
      var name = documentFilename_(label, applicant, downloaded.extension, sequence);
      if (driveFindFileByName_(personal.id, name)) {
        skipped.push(name);
        return;
      }

      // Correct files created by the earlier generic NRIC/work-pass naming
      // without downloading or duplicating the attachment.
      var lowered = String(question || '').toLowerCase();
      var side = lowered.indexOf('front') !== -1 ? 'Front' : (lowered.indexOf('back') !== -1 ? 'Back' : null);
      var legacyLabel = null;
      if (side && lowered.indexOf('nric') !== -1) {
        legacyLabel = 'NRIC ' + side;
      } else if (side && ['wp/spass/ep', 'work pass', 'work permit', 'student pass'].some(function (marker) {
        return lowered.indexOf(marker) !== -1;
      })) {
        legacyLabel = 'Work Pass ' + side;
      }
      if (legacyLabel && legacyLabel !== label) {
        var legacyName = documentFilename_(legacyLabel, applicant, downloaded.extension, sequence);
        var legacy = driveFindFileByName_(personal.id, legacyName);
        if (legacy) {
          driveRenameFile_(legacy.id, name);
          uploaded.push(name);
          return;
        }
      }

      driveUploadBytes_(personal.id, name, downloaded.blob);
      uploaded.push(name);
    } catch (error) {
      failed.push(provisionalName + ': ' + (error && error.message ? error.message : error));
    }
  });

  return { uploaded: uploaded, skipped: skipped, failed: failed };
}

/**
 * Port of PFileCreationService.create(). Finds an existing P-file for this
 * applicant's Typeform token (renaming it if the computed name changed),
 * or creates a new one from the template -- then files their identity
 * documents either way.
 */
function createPfile_(applicant, hrFields, bankRow) {
  applicant = applyIdentityCorrections_(applicant, hrFields);
  applicant.hrPassType = cleanNamePart_((hrFields || {}).passType);
  var folderName = buildFolderName_(applicant, hrFields);
  var token = cleanNamePart_(applicant.token);
  if (!token) {
    throw new Error('The selected Typeform response has no token; creation was stopped to prevent duplicates.');
  }

  var destinationFolderId = resolveDestinationFolderId_((hrFields || {}).employmentType);
  var template = driveGetFile_(CONFIG.TEMPLATE_FOLDER_ID);
  var destination = driveGetFile_(destinationFolderId);
  if (template.trashed || template.mimeType !== FOLDER_MIME_TYPE) {
    throw new Error('The configured P-file template folder is unavailable.');
  }
  if (destination.trashed || destination.mimeType !== FOLDER_MIME_TYPE) {
    throw new Error('The configured Employee Working Files folder is unavailable.');
  }

  // Search every configured employment-type destination. The hidden
  // Typeform token remains stable even when HR renames the visible folder,
  // so a later rerun can add the Bank Form without creating another P-file.
  var remembered = findRememberedPfile_(token);
  var existing = remembered ? [remembered] : driveFindPfilesAcrossDestinations_(token);
  if (existing.length > 1) {
    throw new Error('More than one P-file already exists for this Application Form response. No new folder was created; resolve the duplicates in Drive first.');
  }
  if (existing.length) {
    var root = existing[0];
    rememberPfileForToken_(token, root.id);
    var updatedFolderName = buildUpdatedFolderName_(root.name, applicant, hrFields);
    if (root.name !== updatedFolderName) {
      root = driveRenameFile_(root.id, updatedFolderName);
    }
    var existingDocuments = mergeDocumentResults_(
      populatePersonalInformation_(root.id, applicant),
      populateGeneratedForms_(root.id, applicant, bankRow)
    );
    var existingApplicationPdf = findApplicationFormPdfInPfile_(root.id, applicant.fullName);
    try {
      updateMastersheetPfileLinkForToken_(token, root.webViewLink,
        existingApplicationPdf ? existingApplicationPdf.webViewLink : '');
    } catch (ignoredLinkUpdate) {}
    return {
      id: root.id, name: root.name, webViewLink: root.webViewLink, created: false,
      documents: existingDocuments,
    };
  }

  var newRoot = driveCreateFolder_(folderName, destination.id, {
    chris_hr_type: 'employee_pfile',
    typeform_token: token,
    typeform_row: String(applicant.rowNumber || ''),
  });
  rememberPfileForToken_(token, newRoot.id);
  try {
    driveCopyFolderContentsRecursive_(template.id, newRoot.id);
  } catch (copyError) {
    // This root was created by this operation and is not usable without
    // the complete template. Trash only that new partial root so a retry
    // is clean and duplicate protection remains truthful.
    driveTrashFile_(newRoot.id);
    throw copyError;
  }
  var newDocuments = mergeDocumentResults_(
    populatePersonalInformation_(newRoot.id, applicant),
    populateGeneratedForms_(newRoot.id, applicant, bankRow)
  );
  var newApplicationPdf = findApplicationFormPdfInPfile_(newRoot.id, applicant.fullName);
  try {
    updateMastersheetPfileLinkForToken_(token, newRoot.webViewLink,
      newApplicationPdf ? newApplicationPdf.webViewLink : '');
  } catch (ignoredLinkUpdate) {}
  return {
    id: newRoot.id, name: newRoot.name, webViewLink: newRoot.webViewLink, created: true,
    documents: newDocuments,
  };
}
