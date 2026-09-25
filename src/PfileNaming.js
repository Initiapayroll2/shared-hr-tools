/**
 * P-file Document Naming
 *
 * Port of services/typeform_pfile_document_service.py's naming logic
 * (attachment_label, document_filename, pass_document_type, safe_title).
 * Generated Application/Bank response PDFs are handled in PfileCreation.gs;
 * this file owns the names of the separately downloaded supporting files.
 */

var DOCUMENT_RULES = [
  [['resume'], 'Resume'],
  [['professional photo'], 'Professional Photo'],
  [['casual photo'], 'Casual Photo'],
  [['qualification', 'certificate'], 'Qualification Certificate'],
  [['other applicable certificate'], 'Other Certificate'],
  [['passport'], 'Passport'],
  [['ltvp'], 'LTVP'],
  [['ploc'], 'PLOC'],
  [['birth certificate'], 'Child Birth Certificate'],
];

/** Port of safe_title(): Drive-safe filename fragment, Title Cased. */
function safeTitle_(value) {
  var str = String(value === null || value === undefined ? '' : value);
  str = str.replace(/[\\/:*?"<>|\r\n]+/g, ' ');
  str = str.replace(/\s+/g, ' ').replace(/^[ .\-]+|[ .\-]+$/g, '');
  return titleCase_(str);
}

/** Port of pass_document_type(). */
function passDocumentType_(passType) {
  var value = String(passType || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (value === 'spr' || value === 'pr' || value.indexOf('permanent resident') !== -1) return 'SPR Identification';
  if (value.indexOf('ltvp') !== -1 || value.indexOf('long term visit pass') !== -1) return 'LTVP';
  if (value === 'ep' || value.indexOf('employment pass') !== -1) return 'Employment Pass';
  if (value === 's pass' || value === 'spass' || value.indexOf('s pass') !== -1) return 'S Pass';
  if (value === 'wp' || value.indexOf('work permit') !== -1) return 'Work Permit';
  if (value.indexOf('student pass') !== -1) return 'Student Pass';
  if (value.indexOf('citizen') !== -1 || value.indexOf('singaporean') !== -1) return 'NRIC';
  return 'Identity Document';
}

/** Port of attachment_label(). */
function attachmentLabel_(question, passType) {
  var lowered = String(question || '').toLowerCase();
  var side = lowered.indexOf('front') !== -1 ? 'Front' : (lowered.indexOf('back') !== -1 ? 'Back' : null);
  if (side && lowered.indexOf('nric') !== -1) {
    return passDocumentType_(passType) + ' ' + side;
  }
  if (side && ['wp/spass/ep', 'work pass', 'work permit', 'student pass'].some(function (marker) {
    return lowered.indexOf(marker) !== -1;
  })) {
    var documentType = passDocumentType_(passType);
    if (documentType === 'Identity Document') documentType = 'Work Pass';
    return documentType + ' ' + side;
  }
  for (var i = 0; i < DOCUMENT_RULES.length; i++) {
    var keywords = DOCUMENT_RULES[i][0], label = DOCUMENT_RULES[i][1];
    if (keywords.every(function (keyword) { return lowered.indexOf(keyword) !== -1; })) {
      return label;
    }
  }
  return 'Supporting Document';
}

/** Port of document_filename(). */
function documentFilename_(label, applicant, extension, sequence) {
  var identity = safeTitle_(applicant.fullName) + ' - ' + safeTitle_(applicant.nickname || applicant.fullName);
  var numbered = (sequence !== undefined && sequence !== null) ? ' ' + ('0' + sequence).slice(-2) : '';
  var ext = extension ? (String(extension).charAt(0) === '.' ? extension : '.' + extension) : '';
  return label + numbered + ' - ' + identity + ext.toLowerCase();
}
