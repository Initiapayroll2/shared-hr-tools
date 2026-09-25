/********* CONFIGURE HERE *********/
const MASTER_SHEET_NAME = "MASTERSHEET";   // your main tab name
const HEADER_ROW = 3;                      // header row number

const STATUS_HEADER = "EMPLOYEE STATUS";           // exact header text on row 3
const LWD_HEADER = "[Resign] Last working day/ Transfer date";    // exact header text on row 3

const DAYS_TO_KEEP = 60;

// External archive spreadsheet (from your link)
const ARCHIVE_SPREADSHEET_ID = "1ni-8X8mOnKm8RZz6ANweNwIrz7JXVDiP00H1qkCoBpU";
const ARCHIVE_SHEET_NAME = "Archive_Resignees";    // tab name in archive file

// Statuses eligible to move
const MOVE_STATUSES = [
  "RESIGNED",
  "P/T RESIGNED",
  "INTERNSHIP ENDED",
  "CONTRACT ENDED",
  "WITHDRAW",
  "TRANSFERRED ENTITY",
  "NOT IN USE",
  "INACTIVE"
];
/**********************************/

function moveResignees_60days_headerBased_toExternalArchive() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const ui = SpreadsheetApp.getUi();

  const master = ss.getSheetByName(MASTER_SHEET_NAME);
  if (!master) throw new Error(`Sheet "${MASTER_SHEET_NAME}" not found.`);

  const archiveSS = SpreadsheetApp.openById(ARCHIVE_SPREADSHEET_ID);
  const archive = archiveSS.getSheetByName(ARCHIVE_SHEET_NAME) || archiveSS.insertSheet(ARCHIVE_SHEET_NAME);

  const lastRow = master.getLastRow();
  const lastCol = master.getLastColumn();

  if (lastRow <= HEADER_ROW) {
    ui.alert("Move Resignees", "No data rows under the header row.", ui.ButtonSet.OK);
    return;
  }

  // --- Find column indexes by header name (row 3) ---
  const headerRowValues = master.getRange(HEADER_ROW, 1, 1, lastCol).getValues()[0];
  const norm = (s) => String(s || "").trim().toUpperCase();

  const headerNorm = headerRowValues.map(norm);
  const statusColIndex = headerNorm.indexOf(norm(STATUS_HEADER)); // 0-based
  const lwdColIndex = headerNorm.indexOf(norm(LWD_HEADER));       // 0-based

  if (statusColIndex === -1 || lwdColIndex === -1) {
    ui.alert(
      "Move Resignees - Setup issue",
      `Could not find required headers on row ${HEADER_ROW}:\n\n` +
        `• ${STATUS_HEADER}\n• ${LWD_HEADER}\n\n` +
        `Please make sure the header text matches exactly.`,
      ui.ButtonSet.OK
    );
    return;
  }

  // --- Ensure archive header rows 1–3 exist + "Move Reason" added on header row ---
  const masterHeaderRows = master.getRange(1, 1, HEADER_ROW, lastCol).getValues();

  if (archive.getLastRow() === 0) {
    const headerWithReason = masterHeaderRows.map(r => [...r, ""]); // pad 1 extra column
    headerWithReason[HEADER_ROW - 1][lastCol] = "Move Reason";      // add to row 3 last cell
    archive.getRange(1, 1, HEADER_ROW, lastCol + 1).setValues(headerWithReason);
  } else {
    const archCols = archive.getLastColumn();
    const archHeader = archive.getRange(HEADER_ROW, 1, 1, archCols).getValues()[0];
    const hasMoveReason = archHeader.map(h => String(h).trim().toLowerCase()).includes("move reason");
    if (!hasMoveReason) archive.getRange(HEADER_ROW, archCols + 1).setValue("Move Reason");
  }

  // --- Cutoff date = 60 days ago ---
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - DAYS_TO_KEEP);

  const moveSet = new Set(MOVE_STATUSES.map(norm));

  // --- Read data rows (row 4 onwards) ---
  const data = master.getRange(HEADER_ROW + 1, 1, lastRow - HEADER_ROW, lastCol).getValues();

  const rowsToMove = [];
  const rowsToDelete = [];

  let movedMissing = 0;
  let movedOld = 0;

  data.forEach((row, idx) => {
    const sheetRowNumber = HEADER_ROW + 1 + idx; // actual row number in sheet

    const status = norm(row[statusColIndex]);
    if (!moveSet.has(status)) return; // all other statuses stay

    const lwd = row[lwdColIndex];

    const isMissingLwd =
      lwd === "" ||
      lwd === null ||
      String(lwd).trim() === "-";

    // Condition: move if LWD missing OR LWD <= cutoff (>=60 days ago)
    if (isMissingLwd) {
      rowsToMove.push([...row, "Missing Last Working Day"]);
      rowsToDelete.push(sheetRowNumber);
      movedMissing++;
      return;
    }

    if (lwd instanceof Date && lwd <= cutoff) {
      rowsToMove.push([...row, `Last Working Day >= ${DAYS_TO_KEEP} days ago`]);
      rowsToDelete.push(sheetRowNumber);
      movedOld++;
      return;
    }

    // Safety: if LWD is not blank/"-" and not a real Date (e.g., text),
    // keep it in master so you can fix formatting.
  });

  if (rowsToMove.length === 0) {
    ui.alert("Move Resignees", "No rows to move based on current rules.", ui.ButtonSet.OK);
    return;
  }

  // --- Append to external archive ---
  const writeCols = lastCol + 1; // master columns + Move Reason
const startRow = archive.getLastRow() + 1;

// make sure archive has enough columns
if (archive.getMaxColumns() < writeCols) {
  archive.insertColumnsAfter(
    archive.getMaxColumns(),
    writeCols - archive.getMaxColumns()
  );
}

// make sure archive has enough rows
if (archive.getMaxRows() < startRow + rowsToMove.length - 1) {
  archive.insertRowsAfter(
    archive.getMaxRows(),
    startRow + rowsToMove.length - 1 - archive.getMaxRows()
  );
}

const normalized = rowsToMove.map(r => {
  const out = r.slice(0, writeCols);
  while (out.length < writeCols) out.push("");
  return out;
});

const targetRange = archive.getRange(startRow, 1, normalized.length, writeCols);

  // Prevent validation rules in archive from blocking the write
  targetRange.clearDataValidations();
  targetRange.setValues(normalized);

  // --- Delete from master (bottom-up so row numbers don’t shift) ---
  rowsToDelete.sort((a, b) => b - a).forEach(r => master.deleteRow(r));

  const remaining = master.getLastRow() - HEADER_ROW;

  ui.alert(
    "Move Resignees - Summary",
    `Done!\n\nMoved to external archive "${ARCHIVE_SHEET_NAME}": ${rowsToMove.length}\n` +
      `• Missing LWD: ${movedMissing}\n` +
      `• LWD >= ${DAYS_TO_KEEP} days ago: ${movedOld}\n\n` +
      `Remaining in "${MASTER_SHEET_NAME}": ${remaining}`,
    ui.ButtonSet.OK
  );
}
/*************** CONFIG ****************/
const REGISTRY_SHEET_NAME = "ID Registry";
const RUNNING_DIGITS = 4;

// Mastersheet header names (must match row 3)
const ID_HEADER     = "EMPLOYEE ID";
const NAME_HEADER   = "FULL NAME";
const JOIN_HEADER   = "COMMENCEMENT DATE [JOINING DATE]";
const ENTITY_HEADER = "OFFICIAL COMPANY";

// Map Employee Status -> Prefix
const STATUS_TO_PREFIX = {
  "F/T": "SGFT",
  "P/T": "SGPT",
  "LONG TERM PT": "SGPT",
  "PT ADMIN": "SGPT",
  "P/T SUB": "SGPT",            // change to block if you don't want IDs for subs
  "FREELANCE": "SGFL",
  "INTERN - SCHOOL": "SGIT",
  "INTERN - NON SCHOOL": "SGIT"
};
/****************************************/

// Simple/installable trigger executions may not be authorised to read the
// editor's Google profile email. The audit email is useful when available,
// but it must never block Employee ID assignment or the Registry entry.
function activeUserEmailIfAvailable_() {
  try {
    return Session.getActiveUser().getEmail() || "";
  } catch (ignored) {
    return "";
  }
}

// If you already have onOpen(), merge menu items instead of adding a second onOpen().
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("HR Tools")
    .addItem("Move Resignees (60 days)", "moveResignees_60days_headerBased_toExternalArchive")
    .addItem("Generate & Assign Employee ID", "generateAndAssignEmployeeId_fromStatus")
    .addItem("Void Employee ID (Selected Row)", "voidEmployeeIdForSelectedRow")
    .addSeparator()
    .addItem("Backfill ID Registry (Admin)", "backfillIdRegistry_fromActiveAndArchive")
    .addSeparator()
    // Added by the apps-script-hr-tools project (P-file creation + Mastersheet
    // sync from Typeform) -- see HrToolsCode.js, MastersheetSync.js,
    // PfileCreation.js. Merged into this existing menu/onOpen() rather than a
    // second one, since a project can only have one onOpen().
    //
    // Deliberately just these -- this menu is shared with colleagues.
    // menuDiagnoseNextMastersheetRow(), menuDiagnoseFilter(),
    // menuGrowMastersheetFilterRange(), and menuListNonBlankRowsFrom() in
    // HrToolsCode.js are diagnostic/admin tools used while building this
    // project, not meant for regular use -- still callable any time from
    // the Apps Script editor's Run button (pick the function from the
    // dropdown, Run), just not cluttering this menu.
    .addItem("Sync New Hire to Mastersheet...", "showSyncDialog")
    .addItem("Create P-file...", "showPfileDialog")
    .addSeparator()
    // Letter-generation sidebar (LetterSidebarServer.js/LetterSidebar.html)
    // -- stage 1 only (search + pick, no document generation yet). Select a
    // cell on the employee's row, then use this menu item -- there's no
    // click-to-open trigger; onSelectionChange isn't an installable trigger
    // type in Apps Script at all (confirmed live), only a simple trigger,
    // and simple triggers can't reliably open a sidebar either. See
    // menuGenerateLettersForSelectedRow()'s comment for the full story.
    .addItem("Generate Letter for Selected Row...", "menuGenerateLettersForSelectedRow")
    .addSeparator()
    // Photo sync (photo-sync/PhotoMatching.gs, photo-sync/PhotoBackfill.gs)
    // -- pulls each employee's submitted photo from either Typeform
    // application form into column CB as a real embedded image. Scan is
    // safe to re-run any time (skips rows that already have a photo or are
    // already logged); Apply only acts on rows a human has ticked Approve.
    .addItem("Photo Backfill: Scan & Match...", "scanAndMatchEmployeePhotos")
    .addItem("Photo Backfill: Apply Approved Matches...", "applyApprovedPhotoMatches")
    .addItem("Photo Backfill: Diagnose Failed Matches...", "diagnoseFailedPhotoMatches")
    .addToUi();
}


function generateAndAssignEmployeeId_fromStatus() {
  const ui = SpreadsheetApp.getUi();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getActiveSheet();

  if (sheet.getName() !== MASTER_SHEET_NAME) {
    ui.alert(`Please run this inside the "${MASTER_SHEET_NAME}" tab.`);
    return;
  }

  const row = sheet.getActiveCell().getRow();
  if (row <= HEADER_ROW) {
    ui.alert(`Please select a data row (row ${HEADER_ROW + 1} onwards).`);
    return;
  }

  const lastCol = sheet.getLastColumn();
  const headers = sheet.getRange(HEADER_ROW, 1, 1, lastCol).getValues()[0]
    .map(v => String(v || "").replace(/\s+/g, " ").trim()); // normalize line breaks/spaces

  const findCol = (headerName) => {
    const target = String(headerName).replace(/\s+/g, " ").trim().toUpperCase();
    const idx = headers.findIndex(h => h.toUpperCase() === target);
    return idx === -1 ? -1 : idx + 1;
  };

  const idCol = findCol(ID_HEADER);
  const nameCol = findCol(NAME_HEADER);
  const statusCol = findCol(STATUS_HEADER);
  const joinCol = findCol(JOIN_HEADER);
  const entityCol = findCol(ENTITY_HEADER);

  if (idCol === -1) throw new Error(`Cannot find header "${ID_HEADER}" in row ${HEADER_ROW}.`);
  if (nameCol === -1) throw new Error(`Cannot find header "${NAME_HEADER}" in row ${HEADER_ROW}.`);
  if (statusCol === -1) throw new Error(`Cannot find header "${STATUS_HEADER}" in row ${HEADER_ROW}.`);
  if (joinCol === -1) throw new Error(`Cannot find header "${JOIN_HEADER}" in row ${HEADER_ROW}.`);
  if (entityCol === -1) throw new Error(`Cannot find header "${ENTITY_HEADER}" in row ${HEADER_ROW}.`);

  const existingId = String(sheet.getRange(row, idCol).getValue() || "").trim();
  if (existingId) {
    ui.alert(`This row already has an Employee ID: ${existingId}`);
    return;
  }

  const fullName = String(sheet.getRange(row, nameCol).getValue() || "").trim();
  const entity = String(sheet.getRange(row, entityCol).getValue() || "").trim();

  const statusRaw = String(sheet.getRange(row, statusCol).getValue() || "").trim();
  const status = statusRaw.toUpperCase();
  const prefix = STATUS_TO_PREFIX[status];
if (!prefix) {
  ui.alert(
    `Cannot generate ID because Employee Status is "${statusRaw}".\n\n` +
    `Allowed statuses for ID generation:\n` +
    Object.keys(STATUS_TO_PREFIX).join(", ")
  );
  return;
}

  const joinDate = sheet.getRange(row, joinCol).getValue(); // can be Date or blank

  // Prevent duplicates if multiple users run simultaneously
  const lock = LockService.getDocumentLock();
  lock.waitLock(30000);
  try {
    const registry = ensureRegistrySheet_(ss);

    const nextId = getNextIdFromRegistry_(registry, prefix);

    // Write into mastersheet
    sheet.getRange(row, idCol).setValue(nextId);

    // Log into registry (your chosen columns)
    registry.appendRow([
      nextId,
      fullName,
      joinDate,
      entity,
      statusRaw,           // Type = Employee Status
      new Date(),
      activeUserEmailIfAvailable_()
    ]);

    ui.alert(`Done!\n\nAssigned Employee ID: ${nextId}\nLogged into ${REGISTRY_SHEET_NAME}.`);
  } finally {
    lock.releaseLock();
  }
}

function ensureRegistrySheet_(ss) {
  let reg = ss.getSheetByName(REGISTRY_SHEET_NAME);
  if (!reg) {
    reg = ss.insertSheet(REGISTRY_SHEET_NAME);
    reg.getRange(1, 1, 1, 7).setValues([[
      "Employee ID","Full Name","Join Date","Entity","Type","Created At","Created By"
    ]]);
  } else if (reg.getLastRow() === 0) {
    reg.getRange(1, 1, 1, 7).setValues([[
      "Employee ID","Full Name","Join Date","Entity","Type","Created At","Created By"
    ]]);
  }
  return reg;
}

function getNextIdFromRegistry_(registrySheet, prefix) {
  const lastRow = registrySheet.getLastRow();
  if (lastRow < 2) return prefix + padNumber_(1, RUNNING_DIGITS);

  const ids = registrySheet.getRange(2, 1, lastRow - 1, 1).getValues().flat()
    .map(v => String(v || "").trim())
    .filter(Boolean);

  const re = new RegExp("^" + prefix + "(\\d{" + RUNNING_DIGITS + "})$");
  let maxNum = 0;

  for (const id of ids) {
    const m = id.match(re);
    if (m) {
      const n = parseInt(m[1], 10);
      if (!isNaN(n) && n > maxNum) maxNum = n;
    }
  }
  return prefix + padNumber_(maxNum + 1, RUNNING_DIGITS);
}

function padNumber_(n, digits) {
  const s = String(n);
  return "0".repeat(Math.max(0, digits - s.length)) + s;
}
function backfillIdRegistry_fromActiveAndArchive() {
  const ui = SpreadsheetApp.getUi();
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // Archive spreadsheet + tab name
  const ARCHIVE_SPREADSHEET_ID = "1ni-8X8mOnKm8RZz6ANweNwIrz7JXVDiP00H1qkCoBpU";
  const ARCHIVE_SHEET_NAME = "Archive_Resignees"; // <-- change if your tab name differs
  const ARCHIVE_HEADER_ROW = 3;

  const master = ss.getSheetByName(MASTER_SHEET_NAME);
  if (!master) throw new Error(`Cannot find sheet: ${MASTER_SHEET_NAME}`);

  const registry = ss.getSheetByName(REGISTRY_SHEET_NAME) || ss.insertSheet(REGISTRY_SHEET_NAME);
  if (registry.getLastRow() === 0) {
    registry.getRange(1, 1, 1, 7).setValues([[
      "Employee ID","Full Name","Join Date","Entity","Type","Created At","Created By"
    ]]);
  }

  // normalize header text (handles line breaks/spaces)
  const norm = s => String(s || "").replace(/\s+/g, " ").trim().toUpperCase();

  const findCols = (sheet, headerRow) => {
    const lastCol = sheet.getLastColumn();
    const headers = sheet.getRange(headerRow, 1, 1, lastCol).getValues()[0].map(norm);
    const get = (h) => headers.indexOf(norm(h)) + 1;
    return {
      id: get(ID_HEADER),
      name: get(NAME_HEADER),
      join: get(JOIN_HEADER),
      ent: get(ENTITY_HEADER),
      stat: get(STATUS_HEADER),
      lastCol
    };
  };

  // --- Active mastersheet ---
  const mCols = findCols(master, HEADER_ROW);
  if ([mCols.id,mCols.name,mCols.join,mCols.ent,mCols.stat].some(c => c < 1)) {
    throw new Error("Mastersheet: cannot find one or more required headers. Check your header texts.");
  }

  const mLastRow = master.getLastRow();
  const mData = (mLastRow > HEADER_ROW)
    ? master.getRange(HEADER_ROW + 1, 1, mLastRow - HEADER_ROW, mCols.lastCol).getValues()
    : [];

  // --- Archive sheet (external file) ---
  const archSS = SpreadsheetApp.openById(ARCHIVE_SPREADSHEET_ID);
  const arch = archSS.getSheetByName(ARCHIVE_SHEET_NAME);
  if (!arch) throw new Error(`Cannot find archive tab "${ARCHIVE_SHEET_NAME}" in the archive file.`);

  const aCols = findCols(arch, ARCHIVE_HEADER_ROW);
  if ([aCols.id,aCols.name,aCols.join,aCols.ent,aCols.stat].some(c => c < 1)) {
    throw new Error("Archive: cannot find one or more required headers. Check archive header texts.");
  }

  const aLastRow = arch.getLastRow();
  const aData = (aLastRow > ARCHIVE_HEADER_ROW)
    ? arch.getRange(ARCHIVE_HEADER_ROW + 1, 1, aLastRow - ARCHIVE_HEADER_ROW, aCols.lastCol).getValues()
    : [];

  // --- Existing IDs already in registry ---
  const regDataRows = registry.getLastRow() - 1; // rows below header
const existing = new Set(
  (regDataRows >= 1 ? registry.getRange(2, 1, regDataRows, 1).getValues().flat() : [])
    .map(x => String(x || "").trim())
    .filter(Boolean)
);

  const toAppend = [];

  const collect = (rows, cols, label) => {
    rows.forEach(r => {
      const id = String(r[cols.id - 1] || "").trim();
      if (!id || existing.has(id)) return;
      existing.add(id);

      const fullName = String(r[cols.name - 1] || "").trim();
      const joinDate = r[cols.join - 1];
      const entity = String(r[cols.ent - 1] || "").trim();
      const type = String(r[cols.stat - 1] || "").trim(); // store Employee Status as Type
      toAppend.push([id, fullName, joinDate, entity, type, new Date(), label]);
    });
  };

  collect(mData, mCols, "BACKFILL_ACTIVE");
  collect(aData, aCols, "BACKFILL_ARCHIVE");

  if (toAppend.length) {
    registry.getRange(registry.getLastRow() + 1, 1, toAppend.length, 7).setValues(toAppend);
  }

  ui.alert("Backfill complete", `Added ${toAppend.length} historical IDs into ID_Registry.`, ui.ButtonSet.OK);
}
function generateAndAssignEmployeeId_fromStatus() {
  const ui = SpreadsheetApp.getUi();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getActiveSheet();

  // Safety: correct tab only
  if (sheet.getName() !== MASTER_SHEET_NAME) {
    ui.alert(`Please run this inside the "${MASTER_SHEET_NAME}" tab.`);
    return;
  }

  const row = sheet.getActiveCell().getRow();
  if (row <= HEADER_ROW) {
    ui.alert(`Please select a data row (row ${HEADER_ROW + 1} onwards).`);
    return;
  }

  // --- Find columns by header (row 3) with whitespace normalization ---
  const lastCol = sheet.getLastColumn();
  const headers = sheet.getRange(HEADER_ROW, 1, 1, lastCol).getValues()[0]
    .map(v => String(v || "").replace(/\s+/g, " ").trim());

  const norm = s => String(s || "").replace(/\s+/g, " ").trim().toUpperCase();
  const findCol = (headerName) => {
    const target = norm(headerName);
    const idx = headers.map(norm).indexOf(target);
    return idx === -1 ? -1 : idx + 1; // 1-based
  };

  const idCol = findCol(ID_HEADER);
  const nameCol = findCol(NAME_HEADER);
  const statusCol = findCol(STATUS_HEADER);
  const joinCol = findCol(JOIN_HEADER);
  const entityCol = findCol(ENTITY_HEADER);

  if ([idCol, nameCol, statusCol, joinCol, entityCol].some(c => c === -1)) {
    ui.alert(
      "Header not found",
      `I couldn't find one of these headers on row ${HEADER_ROW}:\n` +
      `- ${ID_HEADER}\n- ${NAME_HEADER}\n- ${STATUS_HEADER}\n- ${JOIN_HEADER}\n- ${ENTITY_HEADER}`,
      ui.ButtonSet.OK
    );
    return;
  }

  // --- Read key values from the selected row ---
  const existingId = String(sheet.getRange(row, idCol).getValue() || "").trim();
  const fullName = String(sheet.getRange(row, nameCol).getValue() || "").trim();
  const statusRaw = String(sheet.getRange(row, statusCol).getValue() || "").trim();
  const entity = String(sheet.getRange(row, entityCol).getValue() || "").trim();
  const joinDate = sheet.getRange(row, joinCol).getValue();

  // If user clicked an empty row (common mistake)
  if (!fullName && !statusRaw && !entity && !existingId) {
    ui.alert(
      "No employee data detected",
      "It looks like you clicked an empty row.\n\nPlease click any cell on the employee’s row (e.g., Full Name or Employee Status), then run again.",
      ui.ButtonSet.OK
    );
    return;
  }

  // If ID already exists, stop
  if (existingId) {
    ui.alert("Already has ID", `This row already has an Employee ID: ${existingId}`, ui.ButtonSet.OK);
    return;
  }

  // Validate status -> prefix
  const status = statusRaw.toUpperCase();
  const prefix = STATUS_TO_PREFIX[status];
  if (!prefix) {
    ui.alert(
      "Cannot generate ID",
      `Employee Status is "${statusRaw || "(blank)"}".\n\nAllowed statuses:\n` +
      Object.keys(STATUS_TO_PREFIX).join(", "),
      ui.ButtonSet.OK
    );
    return;
  }

  // --- Confirmation popup before generating ---
  const joinText = (joinDate instanceof Date)
    ? Utilities.formatDate(joinDate, ss.getSpreadsheetTimeZone(), "dd MMM yyyy")
    : (String(joinDate || "").trim() || "-");

  // --- Generate + log with lock (prevents duplicates if multiple users run) ---
  const lock = LockService.getDocumentLock();
  lock.waitLock(30000);

  try {
    const registry = ensureRegistrySheet_(ss); // your existing helper
    const nextId = getNextIdFromRegistry_(registry, prefix); // your existing helper

    // Write ID into mastersheet
    sheet.getRange(row, idCol).setValue(nextId);

    // Log into registry (your 7 columns)
    registry.appendRow([
      nextId,
      fullName,
      joinDate,
      entity,
      statusRaw,
      new Date(),
      activeUserEmailIfAvailable_()
    ]);

  } finally {
    lock.releaseLock();
  }
}
function voidEmployeeIdForSelectedRow() {
  const ui = SpreadsheetApp.getUi();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getActiveSheet();

  // Safety: run only on mastersheet
  if (sheet.getName() !== MASTER_SHEET_NAME) {
    ui.alert(`Please run this inside the "${MASTER_SHEET_NAME}" tab.`);
    return;
  }

  const row = sheet.getActiveCell().getRow();
  if (row <= HEADER_ROW) {
    ui.alert(`Please select a data row (row ${HEADER_ROW + 1} onwards).`);
    return;
  }

  // Find columns by header
  const lastCol = sheet.getLastColumn();
  const headers = sheet.getRange(HEADER_ROW, 1, 1, lastCol).getValues()[0]
    .map(v => String(v || "").replace(/\s+/g, " ").trim());

  const norm = s => String(s || "").replace(/\s+/g, " ").trim().toUpperCase();
  const findCol = (headerName) => {
    const idx = headers.map(norm).indexOf(norm(headerName));
    return idx === -1 ? -1 : idx + 1;
  };

  const idCol = findCol(ID_HEADER);
  const nameCol = findCol(NAME_HEADER);

  if (idCol === -1) {
    ui.alert(`Cannot find header "${ID_HEADER}" on row ${HEADER_ROW}.`);
    return;
  }

  const empId = String(sheet.getRange(row, idCol).getValue() || "").trim();
const fullName = (nameCol !== -1) ? String(sheet.getRange(row, nameCol).getValue() || "").trim() : "";

if (!empId) {
  ui.alert("No Employee ID found on this row to void.");
  return;
}

// Confirmation prompt (anyone can void, but must confirm)
const confirm = ui.alert(
  "Confirm Void Employee ID",
  `You are about to VOID this Employee ID:\n\n` +
  `Employee ID: ${empId}\n` +
  (fullName ? `Full Name: ${fullName}\n` : "") +
  `\nThis will:\n` +
  `• Mark the ID as VOID in "${REGISTRY_SHEET_NAME}"\n` +
  `• Clear the Employee ID from the selected row\n\n` +
  `Proceed?`,
  ui.ButtonSet.YES_NO
);

if (confirm !== ui.Button.YES) return;

// Open registry
const registry = ss.getSheetByName(REGISTRY_SHEET_NAME);
if (!registry) {
  ui.alert(`Cannot find "${REGISTRY_SHEET_NAME}" tab.`);
  return;
}


  // Ensure "ID Status" column exists (add if missing)
  const regLastCol = registry.getLastColumn();
  const regHeader = registry.getRange(1, 1, 1, regLastCol).getValues()[0].map(h => String(h || "").trim());
  let statusCol = regHeader.findIndex(h => h.toLowerCase() === "id status") + 1;
  if (statusCol === 0) {
    statusCol = regLastCol + 1;
    registry.getRange(1, statusCol).setValue("ID Status");
  }

  // Find ID in registry column A
  const regLastRow = registry.getLastRow();
  if (regLastRow < 2) {
    ui.alert("ID_Registry has no data rows.");
    return;
  }

  const ids = registry.getRange(2, 1, regLastRow - 1, 1).getValues().flat()
    .map(v => String(v || "").trim());

  const idx = ids.indexOf(empId);
  if (idx === -1) {
    ui.alert(`Employee ID "${empId}" not found in ID_Registry.`);
    return;
  }

  const regRow = idx + 2; // because ids start from row 2

  // Mark VOID in registry
  registry.getRange(regRow, statusCol).setValue("VOID");

  // Clear Employee ID in mastersheet (so you can generate the correct one)
  sheet.getRange(row, idCol).clearContent();

  ui.alert(
    "Voided",
    `Employee ID ${empId} has been marked VOID in ID_Registry and cleared from the selected row.\n` +
    (fullName ? `Name: ${fullName}` : ""),
    ui.ButtonSet.OK
  );
}
function onEdit(e) {
  try {
    autoAssignEmployeeIdOnStatusEdit_(e);
  } catch (err) {
    // keep silent (no success popups). Change to alert if you want.
    console.error(err);
  }
}

function autoAssignEmployeeIdOnStatusEdit_(e) {
  if (!e) return;

  const range = e.range;
  const sheet = range.getSheet();
  const ss = sheet.getParent();

  // Only on mastersheet
  if (sheet.getName() !== MASTER_SHEET_NAME) return;

  const row = range.getRow();
  if (row <= HEADER_ROW) return;

  // --- find columns by header row ---
  const lastCol = sheet.getLastColumn();
  const headers = sheet.getRange(HEADER_ROW, 1, 1, lastCol).getValues()[0]
    .map(v => String(v || "").replace(/\s+/g, " ").trim());

  const norm = s => String(s || "").replace(/\s+/g, " ").trim().toUpperCase();
  const findCol = (headerName) => {
    const idx = headers.map(norm).indexOf(norm(headerName));
    return idx === -1 ? -1 : idx + 1; // 1-based
  };

  const idCol = findCol(ID_HEADER);
  const statusCol = findCol(STATUS_HEADER);
  const nameCol = findCol(NAME_HEADER);
  const joinCol = findCol(JOIN_HEADER);
  const entityCol = findCol(ENTITY_HEADER);

  // If cannot find required headers, do nothing
  if ([idCol, statusCol, nameCol, joinCol, entityCol].some(c => c === -1)) return;

  // Trigger ONLY when the edited cell is Employee Status column
  if (range.getColumn() !== statusCol) return;

  // Condition: Employee ID must be empty
  const existingId = String(sheet.getRange(row, idCol).getValue() || "").trim();
  if (existingId) return;

  // Status must be present and eligible
  const statusRaw = String(range.getValue() || "").trim();
  if (!statusRaw) return;

  const status = statusRaw.toUpperCase();
  const prefix = STATUS_TO_PREFIX[status];
  if (!prefix) return; // not eligible status => do nothing

  // Optional safety: name must exist (prevents IDs on incomplete rows)
  const fullName = String(sheet.getRange(row, nameCol).getValue() || "").trim();
  if (!fullName) return;

  const joinDate = sheet.getRange(row, joinCol).getValue();
  const entity = String(sheet.getRange(row, entityCol).getValue() || "").trim();

  // Lock to prevent duplicates in multi-user edits
  const lock = LockService.getDocumentLock();
  lock.waitLock(30000);

  try {
    const registry = ensureRegistrySheet_(ss);
    const nextId = getNextIdFromRegistry_(registry, prefix);

    // Write ID into mastersheet
    sheet.getRange(row, idCol).setValue(nextId);

    // Log into registry
    registry.appendRow([
      nextId,
      fullName,
      joinDate,
      entity,
      statusRaw,
      new Date(),
      activeUserEmailIfAvailable_()
    ]);
  } finally {
    lock.releaseLock();
  }
}
