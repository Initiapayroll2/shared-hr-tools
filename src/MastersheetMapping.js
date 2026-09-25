/**
 * Mastersheet Sync Mapping
 *
 * Direct port of services/mastersheet_sync_mapping_service.py from the main
 * ChrisHR-AI app. Pure, no-I/O mapping logic for the "New Hire -> Mastersheet"
 * sync: given one Application Form response row and an optional matched Bank
 * Form response row, build the ordered list of field descriptors the review
 * dialog renders -- one entry per Mastersheet column, each carrying which
 * value (if any) a Typeform source suggests, and whether it's a
 * Typeform-sourced value, a Bank Form value, or a field only a human can
 * fill in (job-offer terms, ongoing-employment tracking).
 *
 * Every value here is a *suggestion*, never final -- the review dialog
 * renders every field as editable regardless of source. See the Python
 * original's module docstring for the full reasoning behind the
 * (header_text, occurrence) keying scheme (several Mastersheet/Application
 * Form headers repeat) and the emergency-contact/education-level/gender
 * mapping decisions below -- all of it is preserved as-is here.
 */

var MASTERSHEET_FULL_NAME = 'FULL NAME';
var MASTERSHEET_NICK_NAME = 'NICK NAME';
var MASTERSHEET_DATE_OF_BIRTH = 'DATE OF BIRTH';
var MASTERSHEET_GENDER = 'GENDER';
var MASTERSHEET_IC = 'IC ( NRIC, FIN)';
var MASTERSHEET_NATIONALITY = 'NATIONALITY';
var MASTERSHEET_EDUCATION_LEVEL = 'EDUCATION LEVEL';
var MASTERSHEET_MARITAL_STATUS = 'Marital Status';
var MASTERSHEET_RELIGION = 'Religion';
var MASTERSHEET_RACE = 'RACE';
var MASTERSHEET_PHONE = 'PERSONAL \nPHONE No.';
var MASTERSHEET_EMAIL = 'PERSONAL E- MAIL';
var MASTERSHEET_ADDRESS = 'HOME ADDRESS';
var MASTERSHEET_BANK_NAME = 'BANK NAME';
var MASTERSHEET_ACCOUNT_NO = 'ACCOUNT NO.';
var MASTERSHEET_EMERGENCY_NAME = 'NAME';
var MASTERSHEET_EMERGENCY_PHONE = 'PHONE No.';
var MASTERSHEET_EMERGENCY_RELATIONSHIP = 'RELATIONSHIP';
var MASTERSHEET_EMPLOYEE_ID = 'EMPLOYEE ID';
var MASTERSHEET_EMPLOYEE_STATUS = 'EMPLOYEE STATUS';
var MASTERSHEET_OFFICIAL_COMPANY = 'OFFICIAL COMPANY';
var MASTERSHEET_DEPARTMENT = 'DEPARTMENT';
var MASTERSHEET_POSITION = 'POSITION';
// P-file Drive link, column S -- confirmed live on 2026-08-19: the cell
// holds the plain text "LINK" with a hyperlink annotation, not a formula,
// so reading it needs getRichTextValue().getLinkUrl(), not getValue()/
// getFormula() (see LetterSidebarServer.js's getEmployeeLetterContext_()).
var MASTERSHEET_PFILE_LINK = 'Pfile [Link]';
var MASTERSHEET_APPLICATION_FORM_LINK = 'Application Form Link';
// Column CB, confirmed live 2026-09-17: the header text literally contains an
// embedded double quote ("EMPLOYEE"S PHOTO", not a typo). The cells under it
// carry no text/formula/native "image in cell" value at all -- every photo is
// a floating image pasted OVER the cell, invisible to both values.get() and a
// full getGridData() call. Only SpreadsheetApp.Sheet#getImages() can see
// these -- see OrgChartServer.js's getMastersheetPhotoMap_().
var MASTERSHEET_EMPLOYEE_PHOTO_HEADER = 'EMPLOYEE"S PHOTO';

// Letter-generation field mappings, confirmed byte-exact live on 2026-08-19
// via a read-only diagnostic run from the Apps Script editor (never trust a
// screenshot for these -- G's header has a real embedded line break that
// isn't visually obvious). Column G's header literally contains "\n " (a
// newline THEN a space) before "[JOINING DATE]".
var MASTERSHEET_COMMENCEMENT_DATE = 'COMMENCEMENT DATE\n [JOINING DATE]';
var MASTERSHEET_CONFIRMATION = 'CONFIRMATION';
var MASTERSHEET_PROBATION = 'PROBATION?';
var MASTERSHEET_PASS = 'PASS';
var MASTERSHEET_BONUS_TYPE = 'BONUS \nTYPE';
var MASTERSHEET_BONUS_PAYROLL_MONTH = 'BONUS\nPAYROLL MONTH';
var MASTERSHEET_BONUS_PAYROLL_YEAR = 'BONUS\nPAYROLL YEAR';
var MASTERSHEET_AGE = 'Age';
var MASTERSHEET_LOCATION = 'LOCATION';
// Matches the exact string the Mastersheet's own pre-existing Code.js
// already uses for this column (its LWD_HEADER constant) -- cross-confirmed,
// not just diagnosed independently.
var MASTERSHEET_LAST_WORKING_DAY = '[Resign] Last working day/ Transfer date';

// Confirmed live on 2026-09-09 via direct DOM inspection of the header row
// (screenshots/formula-bar previews silently truncate at the first embedded
// line break, which several of these headers have -- never trust either for
// exact header text). Each embeds a real "\n", not just visual wrapping:
//   WORK_VISA_EXPIRY has none; PASSPORT_EXPIRY, CONTRACT_END_DATE,
//   WORKING_DAYS, OFF_DAYS each split across two lines exactly as written.
var MASTERSHEET_WORK_VISA_EXPIRY = 'WORK VISA EXPIRY';
var MASTERSHEET_PASSPORT_EXPIRY = 'PASSPORT \nEXPIRY';
var MASTERSHEET_CONTRACT_END_DATE = 'CONTRACT \nEND DATE';
var MASTERSHEET_WORKING_DAYS = 'WORKING \nDAYS/WEEK';
var MASTERSHEET_OFF_DAYS = 'OFF   \nDAYS/WEEK';
var MASTERSHEET_INSURANCE_TYPE = 'INSURANCE TYPE';

// Confirmed live on 2026-09-17 -- column W. Real Sheets dropdown validation
// (PERMANENT, 3 MONTHS, 6 MONTHS, 1 YEAR, 2 YEARS, 3 YEARS), read fresh via
// getMastersheetDropdownOptions_() in DialogServerApi.gs's dropdownHeaders,
// same as Pass/Bonus Type/Working Days/Off Days/Insurance Type -- never
// hardcoded here, so the dialog can't drift from whatever the sheet's own
// validation actually says.
var MASTERSHEET_CONTRACT_PERIOD = 'CONTRACT PERIOD';

// Confirmed live on 2026-09-16 via direct xlsx export of the Mastersheet
// (never trust a screenshot/formula-bar preview for exact header text --
// see the block above). Basic Salary and Other Allowance are column
// boundaries only, used to build the Gross Total SUMIF range dynamically in
// addEmployeeRow_() -- the five columns between them (O/T, Weekend Bonus,
// Fixed Incentive/Allowance, Transportation Allowance, Housing Allowance)
// don't need their own constants since nothing else in this project reads
// them individually.
var MASTERSHEET_BASIC_SALARY = 'BASIC SALARY/ HR Rate [1]';
var MASTERSHEET_OTHER_ALLOWANCE = 'OTHER ALLOWANCE / FIXED TRAINNING ALLOWANCE [7]';
var MASTERSHEET_GROSS_TOTAL = 'GROSS TOTAL[1]+[2]+[3]+[4]+[5]+[6]+[7]';

// Fields whose dropdown (options already assigned elsewhere -- see
// apiGetMastersheetPreview()'s dropdownHeaders) should render as a
// search-as-you-type combo box in the review dialog instead of a plain
// <select>, restricted to the live list (no freeform entry) -- confirmed
// with Chris: Official Company, Location, Department, Position, Pass,
// Bonus Type, Bonus Payroll Month, Bonus Payroll Year specifically.
var SYNC_SEARCHABLE_HEADERS = [
  MASTERSHEET_OFFICIAL_COMPANY, MASTERSHEET_LOCATION, MASTERSHEET_DEPARTMENT,
  MASTERSHEET_POSITION, MASTERSHEET_PASS, MASTERSHEET_BONUS_TYPE,
  MASTERSHEET_BONUS_PAYROLL_MONTH, MASTERSHEET_BONUS_PAYROLL_YEAR,
];

// Confirmed live against the real Mastersheet (see MASTER_SHEET_DATA_DICTIONARY.md
// in the main repo) -- rendered as a dropdown, not free text, because Employee
// Status is what the sheet's own bound Apps Script reads (alongside Full Name)
// to decide the Employee ID prefix -- a typo here breaks that script's matching
// silently.
var EMPLOYEE_STATUS_OPTIONS = [
  'F/T', 'P/T', 'Intern - School', 'Intern - non school',
  'PT Admin', 'Transferred Entity', 'PT Sub', 'Freelance',
];

// Confirmed with Chris: the Mastersheet's GENDER column is a dropdown of
// exactly these two values -- the Application Form's own "Gender" question
// answers with the full word, so this maps it.
var GENDER_OPTIONS = ['F', 'M'];
var GENDER_VALUE_MAP = { female: 'F', male: 'M', f: 'F', m: 'M' };

/**
 * An unrecognized value normalizes to blank, never passed through --
 * buildFieldDescriptors_() renders this field as a dropdown seeded with
 * [""] + GENDER_OPTIONS, so blank just means "pick one," rather than a
 * stray unmatched string sitting in a dropdown that doesn't contain it.
 */
function normalizeGender_(rawValue) {
  if (!rawValue) return rawValue;
  var key = String(rawValue).trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(GENDER_VALUE_MAP, key) ? GENDER_VALUE_MAP[key] : '';
}

// Confirmed live with Chris: the Mastersheet's EDUCATION LEVEL column is a
// dropdown of exactly these 9 values. The Application Form's own "Highest
// Qualification" question is a DIFFERENT, shorter closed set that doesn't
// share any exact text with these -- this is a considered many-to-one
// mapping (e.g. both "Master's Degree" and "Doctorate" collapse to the
// sheet's one combined bucket), confirmed with Chris rather than guessed.
// Typeform's "Other" answer has no sensible bucket and is left blank.
var EDUCATION_LEVEL_OPTIONS = [
  "NO FORMAL QUALIFICATION/PRE-PRIMARY/LOWER PRIMARY",
  'LOWER SECONDARY',
  'SECONDARY (O-LEVEL/N-LEVEL/SPM)',
  'POST SECONDARY (NON-TERTIARY; NITEC); GENERAL & VOCATIONAL',
  'POLYTECHNIC DIPLOMA',
  'PROFESSIONAL QUALIFICATION AND OTHER DIPLOMA',
  "BACHELOR'S OR EQUIVALENT",
  "POSTGRADUATE DIPLOMA/CERTIFICATE (EXCLUDING MASTER'S AND DOCTORATE)",
  "MASTER's AND DOCTORATE OR EQUIVALENT",
];
var EDUCATION_LEVEL_VALUE_MAP = {
  'primary education': 'NO FORMAL QUALIFICATION/PRE-PRIMARY/LOWER PRIMARY',
  'secondary education (high school or equivalent)': 'SECONDARY (O-LEVEL/N-LEVEL/SPM)',
  'vocational / technical certificate': 'POST SECONDARY (NON-TERTIARY; NITEC); GENERAL & VOCATIONAL',
  'diploma / associate degree': 'POLYTECHNIC DIPLOMA',
  "bachelor's degree": "BACHELOR'S OR EQUIVALENT",
  "master's degree": "MASTER's AND DOCTORATE OR EQUIVALENT",
  'doctorate (phd or equivalent)': "MASTER's AND DOCTORATE OR EQUIVALENT",
};

/** Same blank-on-unrecognized convention as normalizeGender_(). */
function normalizeEducationLevel_(rawValue) {
  if (!rawValue) return rawValue;
  var key = String(rawValue).trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(EDUCATION_LEVEL_VALUE_MAP, key) ? EDUCATION_LEVEL_VALUE_MAP[key] : '';
}

var DATE_OF_BIRTH_INPUT_FORMATS = [
  /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/,   // D/M/Y
  /^(\d{1,2})-(\d{1,2})-(\d{4})$/,     // D-M-Y
  /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/,   // D.M.Y
];
var MONTH_ABBREVIATIONS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * "22/10/1997" (the Application Form's own "DAY / MONTH / YEAR" order) ->
 * "22 Oct 1997". An unparseable value is left unchanged rather than
 * guessed or blanked -- same convention as every other field here.
 */
function formatDateOfBirth_(rawValue) {
  if (!rawValue) return rawValue;
  var stripped = String(rawValue).trim();
  for (var i = 0; i < DATE_OF_BIRTH_INPUT_FORMATS.length; i++) {
    var match = DATE_OF_BIRTH_INPUT_FORMATS[i].exec(stripped);
    if (!match) continue;
    var day = parseInt(match[1], 10), month = parseInt(match[2], 10), year = parseInt(match[3], 10);
    if (month < 1 || month > 12 || day < 1 || day > 31) continue;
    return day + ' ' + MONTH_ABBREVIATIONS[month - 1] + ' ' + year;
  }
  return rawValue;
}

/**
 * The value at the `occurrence`-th column whose header exactly matches
 * `headerText` (0 = first). Returns "" if the header doesn't appear that
 * many times, or the row has no value there. `row` is {headers, values}.
 */
function cell_(row, headerText, occurrence) {
  occurrence = occurrence || 0;
  var headers = row.headers, values = row.values;
  var seen = 0;
  for (var index = 0; index < headers.length; index++) {
    if (headers[index] === headerText) {
      if (seen === occurrence) {
        return index < values.length ? String(values[index]).trim() : '';
      }
      seen += 1;
    }
  }
  return '';
}

/**
 * The first non-blank, non-"-" value across an ordered list of [headerText,
 * occurrence] pairs -- used where a respondent only fills ONE of several
 * conditional-branch columns (local vs. foreign path).
 */
function coalesce_(row, headerOccurrences) {
  for (var i = 0; i < headerOccurrences.length; i++) {
    var value = cell_(row, headerOccurrences[i][0], headerOccurrences[i][1]);
    if (value && value !== '-') return value;
  }
  return '';
}

/**
 * The stable identity of one Mastersheet column, robust to a repeated
 * header name -- e.g. fieldKey_("NAME", 1) is specifically the 2nd column
 * literally named "NAME". Used as the review dialog's field key and the
 * write-time lookup key -- never the bare header text, which several real
 * columns share.
 */
function fieldKey_(headerText, occurrence) {
  // Separator chosen to avoid collisions between two different
  // (header, occurrence) pairs -- e.g. header "FOO 1" occurrence 0 vs.
  // header "FOO" occurrence 1 -- mirrors the null-byte key used by the
  // Python original.
  return headerText + '::' + occurrence;
}

/** Yield {index, header, occurrence} for every column, where `occurrence` counts repeats of the same header text seen so far. */
function iterHeadersWithOccurrence_(mastersheetHeaders) {
  var seenCounts = {};
  var out = [];
  for (var index = 0; index < mastersheetHeaders.length; index++) {
    var header = mastersheetHeaders[index];
    var occurrence = seenCounts[header] || 0;
    seenCounts[header] = occurrence + 1;
    out.push({ index: index, header: header, occurrence: occurrence });
  }
  return out;
}

/**
 * {"header occurrence": [label, source, value]} for every column a
 * Typeform/Bank source can suggest a value for. Everything not listed here
 * is a manual, blank field -- job-offer terms and ongoing-employment
 * tracking (Position, Department, Entity, salary, Work Pass dates, ...)
 * are never sourced from either form.
 */
function buildOverrides_(applicationRow, bankRow) {
  var overrides = {};

  overrides[fieldKey_(MASTERSHEET_FULL_NAME, 0)] = ['Full Name', 'typeform',
    titleCase_(cell_(applicationRow, 'Full Name (as shown in NRIC/Passport )'))];
  overrides[fieldKey_(MASTERSHEET_NICK_NAME, 0)] = ['Nickname', 'typeform',
    titleCase_(cell_(applicationRow, 'Nickname ( English Name ):'))];
  overrides[fieldKey_(MASTERSHEET_DATE_OF_BIRTH, 0)] = ['Date of Birth', 'typeform',
    formatDateOfBirth_(cell_(applicationRow, 'Date of birth ( DAY / MONTH / YEAR ):'))];
  overrides[fieldKey_(MASTERSHEET_GENDER, 0)] = ['Gender', 'typeform',
    normalizeGender_(cell_(applicationRow, 'Gender'))];
  overrides[fieldKey_(MASTERSHEET_IC, 0)] = ['NRIC / FIN / Passport No.', 'typeform', coalesce_(applicationRow, [
    ['NRIC No. ( for Singaporeans / PR ):', 0],
    ['FIN No. / WP No. ( if any ):', 0],
    ['Passport No. ( for foreigners ):', 0],
  ])];
  overrides[fieldKey_(MASTERSHEET_NATIONALITY, 0)] = ['Nationality', 'typeform',
    titleCase_(cell_(applicationRow, 'Nationality:'))];
  overrides[fieldKey_(MASTERSHEET_EDUCATION_LEVEL, 0)] = ['Education Level', 'typeform',
    normalizeEducationLevel_(coalesce_(applicationRow, [
      ['Highest Qualification', 0],
      ['Highest Qualification', 1],
    ]))];
  overrides[fieldKey_(MASTERSHEET_MARITAL_STATUS, 0)] = ['Marital Status', 'typeform',
    titleCase_(cell_(applicationRow, 'Marital Status:'))];
  overrides[fieldKey_(MASTERSHEET_RELIGION, 0)] = ['Religion', 'typeform',
    titleCase_(cell_(applicationRow, 'Religion:'))];
  overrides[fieldKey_(MASTERSHEET_RACE, 0)] = ['Race', 'typeform',
    titleCase_(cell_(applicationRow, 'Race:'))];
  overrides[fieldKey_(MASTERSHEET_PHONE, 0)] = ['Mobile Number', 'typeform',
    cell_(applicationRow, 'Mobile No:')];
  overrides[fieldKey_(MASTERSHEET_EMAIL, 0)] = ['Email', 'typeform',
    cell_(applicationRow, 'Email address ( prefer gmail ):')];
  overrides[fieldKey_(MASTERSHEET_ADDRESS, 0)] = ['Address', 'typeform', titleCase_(coalesce_(applicationRow, [
    ['Singapore Residential Address (Include Unit Number and Postal Code ):', 0],
    ['Foreign Address ( for Non -Singapore Citizen / PR ):', 0],
    ['Singapore Address ( if any ):', 0],
  ]))];

  // Both emergency contacts map directly, one per Mastersheet block --
  // confirmed live the sheet has two full NAME/PHONE No./RELATIONSHIP
  // blocks, not one, so no either/or choice is needed.
  overrides[fieldKey_(MASTERSHEET_EMERGENCY_NAME, 0)] = ['Emergency Contact 1 Name', 'typeform',
    titleCase_(cell_(applicationRow, 'Emergency Contact Name ( 1 ):'))];
  overrides[fieldKey_(MASTERSHEET_EMERGENCY_PHONE, 0)] = ['Emergency Contact 1 Phone', 'typeform',
    cell_(applicationRow, 'Emergency Contact Number ( 1 ):')];
  overrides[fieldKey_(MASTERSHEET_EMERGENCY_RELATIONSHIP, 0)] = ['Emergency Contact 1 Relationship', 'typeform',
    titleCase_(cell_(applicationRow, 'Emergency Contact Relationship ( 1 ):'))];
  overrides[fieldKey_(MASTERSHEET_EMERGENCY_NAME, 1)] = ['Emergency Contact 2 Name', 'typeform',
    titleCase_(cell_(applicationRow, 'Emergency Contact Name ( 2 ):'))];
  overrides[fieldKey_(MASTERSHEET_EMERGENCY_PHONE, 1)] = ['Emergency Contact 2 Phone', 'typeform',
    cell_(applicationRow, 'Emergency Contact Number ( 2 ):')];
  overrides[fieldKey_(MASTERSHEET_EMERGENCY_RELATIONSHIP, 1)] = ['Emergency Contact 2 Relationship', 'typeform',
    titleCase_(cell_(applicationRow, 'Emergency Contact Relationship ( 2 ):'))];

  if (bankRow) {
    overrides[fieldKey_(MASTERSHEET_BANK_NAME, 0)] = ['Bank Name', 'bank',
      String(cell_(bankRow, 'Bank Name:') || '').toUpperCase()];
    overrides[fieldKey_(MASTERSHEET_ACCOUNT_NO, 0)] = ['Account No.', 'bank',
      cell_(bankRow, 'Account Number _*(NOT CARD NUMBER)*_:').replace(/-/g, '')];
  }

  return overrides;
}

/**
 * The ordered list of field descriptors for the review dialog -- one per
 * Mastersheet column, in the Mastersheet's own live column order.
 * `mastersheetHeaders` must be a freshly fetched live header list, since
 * this is also what decides the final column order the row gets written
 * in.
 *
 * Every descriptor's "key" is fieldKey_(header, occurrence) -- use it as
 * the review dialog's field key and pass the resulting
 * {key: editedValue} straight to buildRowValues_(), never a plain
 * {header: value} object.
 */
function buildFieldDescriptors_(mastersheetHeaders, applicationRow, bankRow) {
  var overrides = buildOverrides_(applicationRow, bankRow);
  var entries = iterHeadersWithOccurrence_(mastersheetHeaders);
  var descriptors = [];

  for (var i = 0; i < entries.length; i++) {
    var header = entries[i].header, occurrence = entries[i].occurrence;
    var key = fieldKey_(header, occurrence);
    var label, source, value;
    if (Object.prototype.hasOwnProperty.call(overrides, key)) {
      label = overrides[key][0]; source = overrides[key][1]; value = overrides[key][2];
    } else {
      label = header; source = 'manual'; value = '';
    }

    var options = null;
    if (source === 'manual' && header === MASTERSHEET_EMPLOYEE_STATUS && occurrence === 0) {
      options = EMPLOYEE_STATUS_OPTIONS;
    } else if (header === MASTERSHEET_GENDER && occurrence === 0) {
      options = GENDER_OPTIONS;
    } else if (header === MASTERSHEET_EDUCATION_LEVEL && occurrence === 0) {
      options = EDUCATION_LEVEL_OPTIONS;
    }
    if (source === 'manual' && header === MASTERSHEET_EMPLOYEE_ID && occurrence === 0) {
      label = 'Employee ID (leave blank to generate automatically from Employee Status; enter only if already assigned)';
    }

    if (source === 'manual' && header === MASTERSHEET_CONFIRMATION && occurrence === 0) {
      source = 'computed';
      label = 'Confirmation Date (3 months after Commencement Date for full-time staff; NA otherwise)';
    }
    if (source === 'manual' && header === MASTERSHEET_PROBATION && occurrence === 0) {
      source = 'computed';
      label = 'Probation (auto-computed for full-time staff; NA otherwise)';
    }
    if (source === 'manual' && (header === MASTERSHEET_PFILE_LINK || header === MASTERSHEET_APPLICATION_FORM_LINK) && occurrence === 0) {
      source = 'computed';
      label = header + ' (inserted automatically)';
    }
    if (source === 'manual' && header === MASTERSHEET_AGE && occurrence === 0) {
      source = 'computed';
      label = 'Age (auto-computed from Date of Birth)';
    }
    if (source === 'manual' && header === MASTERSHEET_LAST_WORKING_DAY && occurrence === 0) {
      source = 'computed';
      label = '[Resign] Last working day/ Transfer date (auto-computed: F/T = Offboarding Checklist lookup; ' +
        'P/T, PT Admin, PT Sub, Freelance = "-"; Intern = same as Contract End Date)';
    }
    if (source === 'manual' && header === MASTERSHEET_WORK_VISA_EXPIRY && occurrence === 0) {
      source = 'computed';
      label = 'Work Visa Expiry (auto-computed: linked to Date of Expiry under MOM Information, ' +
        'unless P/T, Freelance, or Intern, then "-")';
    }
    if (source === 'manual' && header === MASTERSHEET_PASSPORT_EXPIRY && occurrence === 0) {
      source = 'computed';
      label = 'Passport Expiry (auto-computed: linked to Passport Expiry under MOM Information, ' +
        'unless P/T, Freelance, or Intern, then "-")';
    }
    if (source === 'manual' && header === MASTERSHEET_GROSS_TOTAL && occurrence === 0) {
      source = 'computed';
      label = 'Gross Total (auto-computed: SUM of Basic Salary through Other Allowance for every ' +
        'status except P/T; P/T stays manual for a typed hourly-rate description)';
    }
    if (source === 'manual' && header === MASTERSHEET_EMPLOYEE_PHOTO_HEADER && occurrence === 0) {
      source = 'computed';
      label = 'Employee\'s Photo (auto-inserted from this applicant\'s submitted Application Form photo, ' +
        'if any -- nothing typed here is used)';
    }

    descriptors.push({
      key: key,
      mastersheetHeader: header,
      label: label,
      source: source,
      value: value,
      options: options,
      searchable: SYNC_SEARCHABLE_HEADERS.indexOf(header) !== -1 && occurrence === 0,
    });
  }

  return descriptors;
}

/**
 * The final positional row array to write, in `mastersheetHeaders` order --
 * `mastersheetHeaders` MUST be freshly fetched at write time, never the
 * same list the review dialog was originally built from. `fieldValues` is
 * {fieldKey_(header, occurrence): value}, built from whatever was
 * confirmed in the review dialog (edited or not) -- re-deriving each
 * column's occurrence against the fresh header list (rather than trusting
 * a stale absolute position) is what keeps a duplicate-named column (e.g.
 * the 2nd "NAME") correctly matched even if something shifted.
 */
function buildRowValues_(mastersheetHeaders, fieldValues) {
  var entries = iterHeadersWithOccurrence_(mastersheetHeaders);
  var row = [];
  for (var i = 0; i < entries.length; i++) {
    var key = fieldKey_(entries[i].header, entries[i].occurrence);
    row.push(Object.prototype.hasOwnProperty.call(fieldValues, key) ? fieldValues[key] : '');
  }
  return row;
}
