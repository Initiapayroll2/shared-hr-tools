/**
 * Photo Sync -- Matching Logic
 *
 * Pure, no-I/O helpers for matching one Mastersheet/Archive employee row
 * against a Typeform "Application form" response row, so PhotoBackfill.gs can
 * pull each employee's submitted photo (a Typeform-hosted file URL, same
 * shape PfileCreation.js already downloads) into the Mastersheet's
 * "EMPLOYEE"S PHOTO" column (CB) as a real embedded image, never a link.
 *
 * Matching is deliberately NOT limited to an exact name match -- per Chris
 * (2026-09-16): applicants sometimes submit their name with a missing
 * surname, or in a different word order, so a name-only comparison has to be
 * fuzzy. NRIC/FIN/Passport No. is the one field treated as a strong,
 * effectively-unique identifier; everything else (name, nickname, date of
 * birth) is corroborating evidence for a human reviewer, never grounds for
 * an automatic write on its own. See PhotoBackfill.gs for how the resulting
 * score is actually used (auto-apply vs. review queue).
 */

// Column headers for the two Typeform "Application form" sources. NRIC/FIN/
// Passport and Date of birth happen to use byte-identical header text across
// both forms (confirmed live) -- only the name-family headers differ.
var NEW_FORM_PHOTO_FIELDS = {
  source: 'New Application Form',
  fullName: 'Full Name (as shown in NRIC/Passport )',
  lastName: 'Surname ( Family Name/Last Name ):',
  nickname: 'Nickname ( English Name ):',
  dob: 'Date of birth ( DAY / MONTH / YEAR ):',
  nric: 'NRIC No. ( for Singaporeans / PR ):',
  fin: 'FIN No. / WP No. ( if any ):',
  passport: 'Passport No. ( for foreigners ):',
  photo: 'Most Recent Professional Photo (No Mask) :',
};

// Confirmed live on 2026-09-16 directly against the "Application form - New
// (SG)" tab of the OLD application-form spreadsheet (CONFIG.
// OLD_APPLICATION_FORM_SPREADSHEET_ID) -- a different, older Typeform from
// the same "Application form - New (SG)" name pattern used by the new form's
// own tab, so never assume the two share a header row.
var OLD_FORM_PHOTO_FIELDS = {
  source: 'Old Application Form',
  fullName: '*Full Name* ( as shown in NRIC/Passport ):',
  lastName: 'Last Name ( Family Name ):',
  nickname: 'Alias / Nick Name ( English Name ):',
  dob: 'Date of birth ( DAY / MONTH / YEAR ):',
  nric: 'NRIC No. ( for Singaporeans / PR ):',
  fin: 'FIN No. / WP No. ( if any ):',
  passport: 'Passport No. ( for foreigners ):',
  photo: 'Most Recent (decent) Photo :',
};

// Confirmed live on 2026-09-16 against both MASTERSHEET and Archive_Resignees
// -- a literal straight double-quote, not an apostrophe (a typo baked into
// the header when Chris added the column), identical in both sheets. Do not
// "fix" this to an apostrophe without also renaming the live column header,
// or every lookup by this constant will silently stop matching.
var MASTERSHEET_EMPLOYEE_PHOTO_HEADER = 'EMPLOYEE"S PHOTO';

// A fuzzy (non-exact-ID) candidate needs at least this score to be worth a
// human's time in the review queue -- see scorePhotoCandidate_() for how the
// components add up. Chosen so that DOB-match-alone or a strong name-only
// match both clear it, but a coincidental single shared token does not.
var PHOTO_MATCH_REVIEW_THRESHOLD = 45;

/** Strips everything but letters/digits and uppercases -- for NRIC/FIN/Passport No. comparison. */
function normalizePhotoId_(rawValue) {
  return String(rawValue || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Lowercase alphabetic tokens only -- drops punctuation/numbers so "Tan, Wei-Ming" and "wei ming tan" tokenize the same way. */
function tokenizePhotoName_(rawValue) {
  var lower = String(rawValue || '').toLowerCase();
  var matches = lower.match(/[a-z]+/g);
  return matches || [];
}

/**
 * Combines every given name part into one order-independent, de-duplicated
 * key -- e.g. full name + surname + nickname all pooled together. Sorting
 * the tokens before joining is what makes "missing surname" and "different
 * name order" (both flagged by Chris as real submission errors) still score
 * a high similarity against a normally-ordered name, since
 * sequenceMatcherRatio_() then compares two same-order token strings rather
 * than two differently-ordered ones.
 */
function buildPhotoNameKey_(nameParts) {
  var seen = {};
  var tokens = [];
  nameParts.forEach(function (part) {
    tokenizePhotoName_(part).forEach(function (token) {
      if (!seen[token]) {
        seen[token] = true;
        tokens.push(token);
      }
    });
  });
  tokens.sort();
  return tokens.join(' ');
}

// Reuses MastersheetMapping.gs's own DATE_OF_BIRTH_INPUT_FORMATS/
// MONTH_ABBREVIATIONS/formatDateOfBirth_ (same Apps Script project, one
// shared global scope) rather than re-deriving date parsing rules -- see
// formatDateOfBirth_'s own comment for the exact formats it accepts.
var PHOTO_DOB_DISPLAY_FORMAT = /^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})$/;

/**
 * Any of: a raw Typeform DOB answer ("22/10/1997"), or the Mastersheet's own
 * DOB cell display value ("22 Oct 1997") -> a canonical "YYYY-MM-DD" string,
 * or "" if unparseable. Both sides of a match run through this same
 * function so the comparison never depends on which side used which format.
 */
function parsePhotoDobToIso_(rawValue) {
  var direct = String(rawValue || '').trim();
  var match = PHOTO_DOB_DISPLAY_FORMAT.exec(direct);
  if (!match) {
    // Not already "D MMM YYYY" -- try the Typeform D/M/Y-style formats via
    // the existing formatter, which normalizes into that same shape.
    var formatted = formatDateOfBirth_(direct);
    match = PHOTO_DOB_DISPLAY_FORMAT.exec(String(formatted || '').trim());
  }
  if (!match) return '';
  var day = parseInt(match[1], 10);
  var monthIndex = MONTH_ABBREVIATIONS.indexOf(match[2].charAt(0).toUpperCase() + match[2].slice(1).toLowerCase());
  var year = match[3];
  if (monthIndex === -1) return '';
  var monthStr = String(monthIndex + 1);
  if (monthStr.length < 2) monthStr = '0' + monthStr;
  var dayStr = String(day);
  if (dayStr.length < 2) dayStr = '0' + dayStr;
  return year + '-' + monthStr + '-' + dayStr;
}

/**
 * One Typeform response row -> {source, rowNumber, nameKey, nicknameNorm,
 * idNorm, dobIso, photoUrl}. `fields` is NEW_FORM_PHOTO_FIELDS or
 * OLD_FORM_PHOTO_FIELDS. Rows with no photo answer at all are still
 * returned (never filtered here) -- PhotoBackfill.gs decides what to do with
 * a photo-less row.
 */
function buildFormPhotoIdentity_(row, fields) {
  var fullName = cell_(row, fields.fullName, 0);
  var lastName = cell_(row, fields.lastName, 0);
  var nickname = cell_(row, fields.nickname, 0);
  var dobRaw = cell_(row, fields.dob, 0);
  var idRaw = coalesce_(row, [
    [fields.nric, 0],
    [fields.fin, 0],
    [fields.passport, 0],
  ]);

  return {
    source: fields.source,
    rowNumber: row.rowNumber,
    displayName: fullName || nickname || ('row ' + row.rowNumber),
    nameKey: buildPhotoNameKey_([fullName, lastName, nickname]),
    nicknameNorm: tokenizePhotoName_(nickname).join(' '),
    idNorm: normalizePhotoId_(idRaw),
    dobIso: parsePhotoDobToIso_(dobRaw),
    photoUrl: String(cell_(row, fields.photo, 0) || '').trim(),
  };
}

/**
 * One Mastersheet/Archive_Resignees data row -> the same identity shape as
 * buildFormPhotoIdentity_(), so both sides of a match compare like for like.
 * `getCell` is a (headerText) -> display-value-string lookup the caller
 * builds once per row (see PhotoBackfill.gs's makePhotoRowCellGetter_()).
 */
function buildMastersheetPhotoIdentity_(rowNumber, getCell) {
  var fullName = getCell(MASTERSHEET_FULL_NAME);
  var nickname = getCell(MASTERSHEET_NICK_NAME);
  return {
    rowNumber: rowNumber,
    displayName: fullName || nickname || ('row ' + rowNumber),
    nameKey: buildPhotoNameKey_([fullName, nickname]),
    nicknameNorm: tokenizePhotoName_(nickname).join(' '),
    idNorm: normalizePhotoId_(getCell(MASTERSHEET_IC)),
    dobIso: parsePhotoDobToIso_(getCell(MASTERSHEET_DATE_OF_BIRTH)),
  };
}

/**
 * {score, idExact, dobExact, nameRatio} for one Mastersheet identity against
 * one candidate (Typeform) identity. Only `idExact` is ever treated as
 * strong enough to auto-apply (see PhotoBackfill.gs) -- the rest inform the
 * score a human reviewer sees, never an automatic write on their own.
 */
function scorePhotoCandidate_(masterIdentity, candidate) {
  var idExact = !!(masterIdentity.idNorm && candidate.idNorm && masterIdentity.idNorm === candidate.idNorm);
  var dobExact = !!(masterIdentity.dobIso && candidate.dobIso && masterIdentity.dobIso === candidate.dobIso);
  var nicknameExact = !!(masterIdentity.nicknameNorm && candidate.nicknameNorm &&
    masterIdentity.nicknameNorm === candidate.nicknameNorm);
  var nameRatio = sequenceMatcherRatio_(masterIdentity.nameKey, candidate.nameKey);

  var score = 0;
  if (idExact) score += 100;
  if (dobExact) score += 50;
  if (nicknameExact) score += 20;
  score += Math.round(nameRatio * 40);

  return { score: score, idExact: idExact, dobExact: dobExact, nicknameExact: nicknameExact, nameRatio: nameRatio };
}
