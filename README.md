# ChrisHR Apps Script Tools

A Google Apps Script port of two ChrisHR-AI workflows, meant for **colleagues**
who don't run the desktop app: **P-file creation** and **Mastersheet sync**.
It lives in this repo as a separate, independent project -- same underlying
business rules ("the brain"), different delivery: a custom menu inside the
Mastersheet itself, no Python app, no install required beyond Google Sheets
access.

The main `ChrisHR-AI` app (in `src/` at the repo root) stays exactly as it is,
for Chris's own personal use. This subfolder does not depend on it and is not
imported by it -- the two are kept in sync by hand when a business rule
changes on one side.

## What's included (v1)

- **Mastersheet sync** -- "HR Tools > Sync New Hire to Mastersheet": pick an
  Application Form response, optionally match a Bank Form submission by name
  (ranked, never auto-picked), review every field editable, then write one
  new row to the Mastersheet.
- **P-file creation** -- "HR Tools > Create P-file": pick an Application Form
  response, fill in the HR-only fields (Entity, Employee ID, Pass Type,
  Department, Position), preview the computed folder name, then create the
  employee's Drive folder from the template and file their identity
  documents into it.

## What's in progress (v2) -- letter generation

- **"HR Tools > Generate Letter for Selected Row..."** -- select a cell on
  the employee's row, then run this menu item. Opens a sidebar scoped to
  that employee: search-as-you-type across the **59-template catalog** in
  the separate "SG All Form" spreadsheet ("SG ALL FORMS" tab), picks
  collapse into removable chips.
- **Document generation is now live.** Clicking Generate scans each picked
  template's ACTUAL body text (not its filename -- confirmed live these
  disagree, see `LetterPlaceholders.js`'s header comment) for `<<...>>`
  placeholders, splits them into:
  - **resolved fields** -- Full Name/First Name, Entity, Position/Designation,
    Commencement/Joining Date, LWD/Last Working Day, Confirmation Date, NRIC
    -- filled automatically from the Mastersheet row (mapping confirmed
    directly with Chris, not guessed) and replaced everywhere they appear,
    regardless of casing.
  - **unresolved fields** (anything else, e.g. "amount", "purpose") --
    surfaced as a manual-input box **per occurrence**, not one shared value.
    Two `<<amount>>` tokens in the same letter (e.g. old salary -> new
    salary) each get their own input rather than silently receiving the
    same value.

  The generated copy is saved into the employee's P-file folder (resolved
  from column S's link) and opened for review -- nothing is auto-sent.
  Catalog rows that point at a folder of templates (a couple of the NDA
  rows) aren't auto-generated; the sidebar just links to the folder to pick
  from manually.
- **No click-to-open trigger, and this isn't a gap to fill in later --
  it's not possible.** `onSelectionChange` is not an installable trigger
  type in Apps Script at all (confirmed live: `ScriptApp.newTrigger(...)
  .forSpreadsheet(...).onSelectionChange` throws `TypeError: ... is not a
  function` -- the installable types for a spreadsheet are only
  onOpen/onEdit/onChange/onFormSubmit). It only exists as a *simple*
  trigger, and simple triggers can't reliably open a sidebar/dialog either
  -- Google blocks that specifically, since a simple trigger can fire from
  any collaborator's click, including someone who never authorized this
  script. The menu item is the real mechanism, same as Sync/P-file.

## What's deliberately NOT included

Everything else in the main app is out of scope for this Apps Script version:
Ask Chris (LLM assistant), Telegram monitoring/digest, ClickUp, SafetyCulture,
Dropbox Sign, onboarding/offboarding/payroll/work-pass workflows, and the raw
Typeform-application-PDF export. Letter generation is now in progress (see
above) rather than out of scope. If one of the others later turns out to be
worth porting too, treat it as its own follow-up, not a silent scope-creep
into this one.

## File map (Python source of truth -> Apps Script port)

| Apps Script file | Ports |
|---|---|
| `src/Config.js` | `config/pfile_creation.json`, `config/mastersheet_sync.json` |
| `src/Utils.js` | assorted small helpers from both services below |
| `src/MastersheetMapping.js` | `services/mastersheet_sync_mapping_service.py` |
| `src/MastersheetSync.js` | `services/mastersheet_sync_service.py` |
| `src/PfileNaming.js` | `services/typeform_pfile_document_service.py` (naming only -- PDF export not ported) |
| `src/PfileCreation.js` | `services/pfile_creation_service.py` + the Drive calls it uses from `connectors/personal_google_drive.py` |
| `src/HrToolsCode.js` | menu-opening functions + the server API the two dialogs call |
| `src/SyncDialog.html`, `src/PfileDialog.html` | new -- there's no Python UI equivalent to port; the desktop app used a native GUI |
| `src/LetterTemplateRegistry.js` | new -- reads the separate "SG All Form" spreadsheet's template catalog live; no Python equivalent exists to port |
| `src/LetterPlaceholders.js` | new -- resolves `<<...>>` placeholders found in a template's actual body text against Mastersheet columns (see "What's in progress" above); no Python equivalent exists to port |
| `src/LetterSidebarServer.js`, `src/LetterSidebar.html` | new -- the letter-generation sidebar (search/pick, fill-in-the-blanks, generate). Server file is named `LetterSidebarServer.js`, not `LetterSidebar.js`, because Apps Script strips extensions internally -- a `.js` and `.html` file sharing the same base name collide on push |

If Chris changes a business rule in one of the Python files above (a new
Education Level mapping, a different folder-name field order, a new
Employee Status value, ...), the matching Apps Script file needs the same
edit by hand -- there's no shared code between the two apps.

### `src/Code.js` is NOT this project's file -- do not overwrite it

The Mastersheet already had its own, pre-existing production Apps Script
project bound to it before this one was set up: resignee archiving
(`moveResignees_60days_headerBased_toExternalArchive`), Employee ID
generation/registry (`generateAndAssignEmployeeId_fromStatus`,
`backfillIdRegistry_fromActiveAndArchive`), and an `onEdit()` simple
trigger. `clasp clone`/`clasp push` operate on the *entire* Apps Script
project, and that existing code happens to live in a file also named
`Code.js` -- so this project's own code was deliberately kept out of
`Code.js` and put in `HrToolsCode.js` instead, to avoid two unrelated
codebases silently clobbering each other on every push.

The one exception is `onOpen()`: a project can only have one, and the
pre-existing one already built a menu also (coincidentally) named "HR
Tools" -- so this project's two menu items were merged into that existing
`onOpen()` in `Code.js`, rather than adding a second, competing one.
**When editing `Code.js`, touch only the two added lines inside `onOpen()`
-- never the rest of that file.** If the pre-existing script ever needs a
real change, that's Chris's call, made directly, not something this
project's edits should drift into by accident.

## Key differences from the Python original (and why)

- **No service-account / personal-OAuth split.** The Python app splits reads
  (read-only service account) from the one Mastersheet write (Chris's
  personal OAuth), because a service account can't write to the Mastersheet
  or own files in a personal My Drive. Apps Script has no such problem: every
  call here runs as whichever colleague is using the menu, using their own
  Google identity, so reads and writes both just need that colleague to
  already have normal access to the relevant sheets/folders.
- **LockService instead of true atomicity.** `addEmployeeRow_()` in
  `MastersheetSync.js` wraps the read-then-write sequence in
  `LockService.getScriptLock()` in addition to the Python original's
  immediate re-check of the target row right before writing. Neither
  eliminates the race entirely (Sheets has no row-level lock either way) --
  this closes the gap further than the Python version could, since Apps
  Script's lock is shared across every colleague running this same script.
- **`sequenceMatcherRatio_()` in `Utils.js`** is a from-scratch port of
  Python's `difflib.SequenceMatcher.ratio()` (Ratcliff/Obershelp), used only
  to *rank* Bank Form name candidates for a human to visually confirm. It's
  not byte-for-byte identical to CPython's implementation, but produces the
  same kind of similarity ordering -- fine for its one job, since nothing
  here is ever auto-matched.
- **appProperties require the Advanced Drive Service.** `DriveApp` (the
  simple built-in service) doesn't expose custom file metadata, which the
  P-file duplicate-protection check depends on (`chris_hr_type` /
  `typeform_token` tags on the root folder). `src/appsscript.json` enables
  the Advanced Drive Service (`Drive`, v3) instead, which mirrors the same
  REST calls `connectors/personal_google_drive.py` makes.

## Setup

### 1. Install clasp (one-time, on whoever is deploying this)

```bash
npm install -g @google/clasp
```

If this fails with an `EACCES`/permission error, npm's global install
folder isn't owned by your user (common with the official Node.js
installer) -- fix it by pointing npm at a folder you own instead of using
`sudo`:

```bash
mkdir -p ~/.npm-global
npm config set prefix "$HOME/.npm-global"
echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
npm install -g @google/clasp
```

Then log in and enable the Apps Script API (both one-time, per Google
account):

```bash
clasp login
```

`clasp login` opens a browser window to sign in -- use whichever Google
account has edit access to the Mastersheet. Separately, visit
[script.google.com/home/usersettings](https://script.google.com/home/usersettings)
and switch **"Google Apps Script API"** to On for that same account (clasp
will fail with a clear error telling you to do this if you skip it).

### 2. Get the Script ID -- **do NOT use `clasp create --parentId`**

Older clasp docs (v2) describe `clasp create --type sheets --parentId
<existing file ID>` as a way to attach a new script to an *existing*
spreadsheet. **This no longer works in clasp v3** (confirmed against
v3.3.0): `--parentId` is silently ignored whenever `--type` is anything
other than `standalone`, and `create` unconditionally makes a **new**
blank spreadsheet instead. There is no flag-based way around this in v3 --
get the Script ID from the Sheets UI instead:

1. Open the actual Mastersheet in Sheets
2. **Extensions > Apps Script** -- this opens (or creates, if none exists
   yet) the Apps Script project already bound to that specific spreadsheet
3. In that editor, click the gear icon (Project Settings) and copy the
   **Script ID**

### 3. Clone it locally and push

```bash
clasp clone <scriptId> --rootDir src
```

**Read what this pulls down before pushing anything back.** If the
Mastersheet already has its own bound script (ours did -- see "`src/Code.js`
is NOT this project's file" above), `clone` will overwrite whatever local
file has the same name as a file already in that remote project --
including `src/appsscript.json`, which gets replaced with a bare-bones
default manifest and needs its `enabledAdvancedServices`/`oauthScopes`
restored by hand afterward. Diff what changed, don't just push blindly:

```bash
clasp push --force
```

(`--force` is needed here specifically because the manifest changed and
clasp otherwise asks for interactive confirmation before overwriting it.)

### 4. Open the Mastersheet and authorize

Reload the Mastersheet in Sheets. An "HR Tools" menu should appear. The
first time anyone runs a menu item, Google will show a standard OAuth
consent screen (Sheets + Drive access) -- that's expected, one-time per
person, and is what lets the script act as that colleague's own Google
identity rather than needing any shared credentials.

### 5. Make sure colleagues actually have access to what the script touches

Apps Script doesn't grant access by itself -- a colleague running this needs,
under their own Google account:

- **Edit** access to the Mastersheet
- **View** access to the Application Form response sheet and the Bank Form
  response sheet
- **View** access to the P-file template folder in Drive
- **Edit** access to the P-file destination folder in Drive

Without these, the relevant menu action will fail with a normal Google
"you need permission" error, not a bug in this code.

## Testing checklist (do this after every `clasp push`)

There's no automated test suite for this Apps Script project (Apps Script
has no equivalent to the Python side's `src/Tests/`) -- verify by hand:

- [ ] "HR Tools" menu appears on opening the Mastersheet
- [ ] Sync dialog lists recent Application Form responses, newest first
- [ ] Sync dialog's bank-match step never pre-selects a candidate
- [ ] Sync dialog's review step shows every Mastersheet column, editable
- [ ] Submitting writes exactly one new row, at the correct next-empty-row
      position, and doesn't touch any other row
- [ ] Submitting twice in quick succession from two accounts doesn't
      silently overwrite either row (one should get the conflict error)
- [ ] P-file dialog's live preview matches what the folder name ends up
      being once created
- [ ] Creating a P-file for an already-existing token finds the existing
      folder instead of duplicating it
- [ ] Re-running P-file creation on the same applicant skips already-
      uploaded documents instead of duplicating them
- [ ] "Generate Letter for Selected Row..." opens the sidebar with the
      correct employee's name/ID/company/position
- [ ] Typing in the letter search box returns matching templates, and
      already-picked ones don't reappear in the results
- [ ] Generating a letter with only resolved fields (no manual input needed)
      produces a document with every placeholder correctly filled -- no
      literal `<<...>>` left behind anywhere in the body
- [ ] Generating a letter with an unresolved, repeated placeholder (e.g. a
      salary-increment template's two `<<amount>>` tokens) shows TWO
      separate input boxes, and each ends up in the right spot in the
      output -- not both replaced with the same value
- [ ] The generated file lands in the employee's actual P-file folder
      (check column S's link), not somewhere else
- [ ] A catalog row that points at a folder (the NDA rows) shows a
      "pick manually" link instead of trying to auto-generate
