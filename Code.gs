/**
 * F&B PT Onboarding Portal
 * Shows each PIC only the onboarding status rows for their own outlet(s).
 * Pulls live directly from the ClickUp API on every page load (no sync step).
 * The dashboard (stat cards, by-outlet, by-status, table) re-renders entirely
 * client-side when the outlet filter changes - no page reload.
 *
 * SETUP:
 * 1. Google Sheet with tabs named exactly "PIC_Mapping", "MY_PIC_Mapping" and "Admins".
 *    PIC_Mapping (Singapore) & MY_PIC_Mapping (Malaysia) columns (row 1 headers): Email | Outlet
 *    Admins columns (row 1 headers):      Email   (sees every outlet, bird's-eye view)
 *    Each country's outlets are a separate namespace - the same outlet name (e.g. "Modu K")
 *    can exist in both countries and belong to a different PIC in each.
 * 2. Script Properties (Project Settings > Script Properties):
 *    CLICKUP_TOKEN = your ClickUp personal API token.
 * 3. Deploy > New deployment > Web app.
 *    - Execute as: User accessing the web app
 *    - Who has access: Anyone with a Google account
 * 4. Share the deployment URL with your PICs. Add each PIC's email + outlet to the
 *    mapping sheet for their country. Also share the underlying Sheet with each PIC's
 *    email as Viewer.
 */

// Singapore tasks carry dedicated "Outlet"/"Role"/"Full Name" custom fields.
// Malaysia tasks don't have an Outlet or Role field at all - that info is only
// encoded in the task title itself, formatted "PT-<Full Name>-<Outlet>-<Position>",
// so outletFromTitle:true switches getClickUpTasks_ over to parsing the title instead.
var COUNTRIES = [
  {
    code: 'SG', label: 'Singapore', listId: '901819849781', mappingSheet: 'PIC_Mapping',
    outletFromTitle: false, fullNameField: 'Full Name', outletField: 'Outlet', roleField: 'Role', startDateField: 'Proposed Start Date'
  },
  {
    code: 'MY', label: 'Malaysia', listId: '901819757280', mappingSheet: 'MY_PIC_Mapping',
    outletFromTitle: true, fullNameField: 'Full Name (as per NRIC/ID)', outletField: null, roleField: null, startDateField: 'PT Start Date'
  }
];
var ADMIN_SHEET = 'Admins';

// Each country has its own outlet namespace - an outlet named e.g. "Modu K" in
// Singapore is a completely different outlet from one with the same name in
// Malaysia. So a PIC's access is always resolved within a single country's own
// mapping sheet and own ClickUp list - never matched against another country's
// outlets or tasks.
function doGet(e) {
  var email = Session.getActiveUser().getEmail();
  if (!email) {
    return HtmlOutput_('Sign-in required', '<p>Please sign in with your Google account to view this page.</p>');
  }

  var isAdmin = isAdmin_(email);
  var countries;

  if (isAdmin) {
    countries = COUNTRIES.map(function (c) {
      var rows = getClickUpTasks_(c);
      return {
        code: c.code,
        label: c.label,
        outletsLabel: c.label + ' (admin view)',
        rows: rows,
        outlets: getOutletOptionsForCountry_(c, rows)
      };
    });
  } else {
    countries = [];
    COUNTRIES.forEach(function (c) {
      var outletOptions = getOutletsForEmail_(email, c.mappingSheet);
      if (outletOptions.length === 0) return;
      var wanted = {};
      outletOptions.forEach(function (o) { wanted[o.toLowerCase()] = true; });
      var rows = getClickUpTasks_(c).filter(function (t) { return wanted[t.outlet.toLowerCase()]; });
      countries.push({ code: c.code, label: c.label, outletsLabel: outletOptions.join(', '), rows: rows, outlets: outletOptions });
    });
    if (countries.length === 0) {
      return HtmlOutput_('No access configured',
        '<p>No outlet is set up for <b>' + escapeHtml_(email) + '</b>.</p>' +
        '<p>Contact HR to be added to the onboarding portal.</p>');
    }
  }

  return HtmlOutput_('Onboarding Status', renderShell_(countries, email));
}

function getClickUpTasks_(country) {
  var token = PropertiesService.getScriptProperties().getProperty('CLICKUP_TOKEN');
  var tasks = [];
  var page = 0;
  while (true) {
    var url = 'https://api.clickup.com/api/v2/list/' + country.listId + '/task' +
      '?include_closed=true&subtasks=true&page=' + page;
    var resp = UrlFetchApp.fetch(url, { headers: { Authorization: token } });
    var data = JSON.parse(resp.getContentText());
    var batch = data.tasks || [];
    tasks = tasks.concat(batch);
    if (batch.length < 100 || data.last_page) break;
    page++;
  }

  return tasks.map(function (t) {
    var statusRaw = t.status && t.status.status ? t.status.status : '';
    var priorityRaw = t.priority && t.priority.priority ? t.priority.priority : '';
    var titleParts = country.outletFromTitle ? parseTaskTitle_(t.name) : null;
    var fullName = getCustomFieldValue_(t, country.fullNameField) || (titleParts && titleParts.fullName) || t.name || '';
    return {
      outlet: titleParts ? titleParts.outlet : getCustomFieldValue_(t, country.outletField),
      name: fullName,
      position: titleParts ? titleParts.position : getCustomFieldValue_(t, country.roleField),
      status: statusRaw.toUpperCase(),
      priority: priorityRaw ? priorityRaw.charAt(0).toUpperCase() + priorityRaw.slice(1) : '',
      startDate: getCustomFieldDate_(t, country.startDateField),
      dueDate: t.due_date ? new Date(Number(t.due_date)) : '',
      lastUpdated: t.date_updated ? new Date(Number(t.date_updated)) : ''
    };
  });
}

// Malaysia task titles look like "PT-Muhammad Alif Hakimi Bin Mohd Saadon - Modu KLGCC- Service Crew"
// i.e. "PT-<Full Name>-<Outlet>-<Position>", with inconsistent spacing around the dashes.
// Splits on "-": the first chunk must be "PT", the last chunk is the position, the
// second chunk is the name, and everything in between (rejoined) is the outlet -
// this tolerates an outlet name that itself contains a dash (e.g. "Modu Samgyetang (TRX)").
function parseTaskTitle_(name) {
  var parts = String(name || '').split('-');
  if (parts.length < 4 || !/^pt$/i.test((parts[0] || '').trim())) return null;
  return {
    fullName: parts[1].trim(),
    outlet: parts.slice(2, parts.length - 1).join('-').trim(),
    position: parts[parts.length - 1].trim()
  };
}

// Singapore's Outlet options come from the ClickUp field definition itself (auto-syncs).
// Malaysia has no such field, so its outlet list is instead the unique set of outlets
// found by parsing the titles of its own currently-fetched tasks.
function getOutletOptionsForCountry_(country, rows) {
  if (country.outletField) return getOutletFieldOptions_(country.listId);
  var seen = {};
  var outlets = [];
  rows.forEach(function (r) {
    if (r.outlet && !seen[r.outlet.toLowerCase()]) {
      seen[r.outlet.toLowerCase()] = true;
      outlets.push(r.outlet);
    }
  });
  outlets.sort();
  return outlets;
}

function getCustomFieldValue_(task, fieldName) {
  var field = (task.custom_fields || []).filter(function (f) { return f.name === fieldName; })[0];
  if (!field || field.value === undefined || field.value === null || field.value === '') return '';
  if (field.type === 'drop_down' && field.type_config && field.type_config.options) {
    var opt = field.type_config.options[field.value];
    return opt ? opt.name : '';
  }
  return String(field.value);
}

function getCustomFieldDate_(task, fieldName) {
  var field = (task.custom_fields || []).filter(function (f) { return f.name === fieldName; })[0];
  if (!field || field.value === undefined || field.value === null || field.value === '') return '';
  return new Date(Number(field.value));
}

// All Outlet dropdown options as defined on the ClickUp list itself - auto-syncs
// as outlets are added/removed in ClickUp, no code change needed.
function getOutletFieldOptions_(listId) {
  var token = PropertiesService.getScriptProperties().getProperty('CLICKUP_TOKEN');
  var url = 'https://api.clickup.com/api/v2/list/' + listId + '/field';
  var resp = UrlFetchApp.fetch(url, { headers: { Authorization: token } });
  var data = JSON.parse(resp.getContentText());
  var field = (data.fields || []).filter(function (f) { return f.name === 'Outlet'; })[0];
  if (!field || !field.type_config || !field.type_config.options) return [];
  return field.type_config.options
    .slice()
    .sort(function (a, b) { return a.orderindex - b.orderindex; })
    .map(function (o) { return o.name; })
    .filter(function (n) { return n; });
}

function isAdmin_(email) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(ADMIN_SHEET);
  if (!sheet) return false;
  var values = sheet.getDataRange().getValues();
  var target = email.trim().toLowerCase();
  for (var i = 1; i < values.length; i++) {
    if (String(values[i][0] || '').trim().toLowerCase() === target) return true;
  }
  return false;
}

function getOutletsForEmail_(email, mappingSheetName) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(mappingSheetName);
  if (!sheet) return [];
  var values = sheet.getDataRange().getValues();
  var outlets = [];
  var target = email.trim().toLowerCase();
  for (var i = 1; i < values.length; i++) {
    var rowEmail = String(values[i][0] || '').trim().toLowerCase();
    var rowOutlet = String(values[i][1] || '').trim();
    if (rowEmail === target && rowOutlet) {
      outlets.push(rowOutlet);
    }
  }
  return outlets;
}

// ---- Page shell: header + country toggle + filter select + empty client-rendered dashboard ----

function renderShell_(countries, email) {
  var clientCountries = countries.map(function (c) {
    var clientRows = c.rows.map(function (r) {
      return {
        outlet: r.outlet,
        name: r.name,
        position: r.position,
        status: r.status,
        startDate: r.startDate instanceof Date ? r.startDate.toISOString() : null,
        dueDate: r.dueDate instanceof Date ? r.dueDate.toISOString() : null,
        lastUpdated: r.lastUpdated instanceof Date ? r.lastUpdated.toISOString() : null
      };
    });
    return { code: c.code, label: c.label, outletsLabel: c.outletsLabel, rows: clientRows, outlets: c.outlets };
  });
  var countriesJson = JSON.stringify(clientCountries).replace(/</g, '\\u003c');

  return '' +
    '<div class="header">' +
      '<div>' +
        '<h1>Onboarding Status</h1>' +
        '<div class="muted" id="headerLabel">' + escapeHtml_(countries[0].outletsLabel) + '</div>' +
      '</div>' +
      '<div class="muted">' + escapeHtml_(email) + '</div>' +
    '</div>' +
    '<div id="filter-bar"></div>' +
    '<div id="dashboard-body"></div>' +
    '<script>' + clientEngine_() +
      '\nvar COUNTRIES=' + countriesJson + ';' +
      '\nvar CURRENT=COUNTRIES[0].code;' +
      '\ninitFilterBar();\nrender("");\n<\/script>';
}

// All dashboard HTML (stat cards, by-outlet, by-status, grouped table) is built
// here, client-side, so the outlet filter re-renders instantly without a reload.
function clientEngine_() {
  return '' +
    'var STATUS_ORDER=["PENDING HR REVIEW","TO GENERATE LOA","LOA PENDING SIGNATURE","TO CREATE STAFFANY ACCOUNT","ONBOARDING COMPLETE","COMPLETE"];' +
    'var STATUS_COLORS={"PENDING HR REVIEW":"#8b8f97","TO GENERATE LOA":"#7b68ee","LOA PENDING SIGNATURE":"#4a90d9","TO CREATE STAFFANY ACCOUNT":"#2bb673","ONBOARDING COMPLETE":"#1f9254","COMPLETE":"#1c1c1c"};' +
    'var DEFAULT_COLOR="#8b8f97";' +
    'function esc(v){return String(v==null?"":v).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");}' +
    'function fmtDate(iso){if(!iso)return "";var d=new Date(iso);return d.toLocaleDateString("en-GB",{day:"2-digit",month:"short",year:"numeric"});}' +
    'function mondayOf(d){var date=new Date(d);var day=date.getDay();date.setDate(date.getDate()+(day===0?-6:1-day));date.setHours(0,0,0,0);return date;}' +
    'function statCard(value,label){return "<div class=\\"stat-card\\"><div class=\\"stat-value\\">"+value+"</div><div class=\\"stat-label\\">"+esc(label)+"</div></div>";}' +
    'function buildStatCards(rows){' +
      'var now=new Date();var mThis=mondayOf(now);var mNext=new Date(mThis);mNext.setDate(mThis.getDate()+7);var mAfter=new Date(mThis);mAfter.setDate(mThis.getDate()+14);' +
      'var thisWeek=0,nextWeek=0;' +
      'rows.forEach(function(r){if(!r.startDate)return;var d=new Date(r.startDate);if(d>=mThis&&d<mNext)thisWeek++;else if(d>=mNext&&d<mAfter)nextWeek++;});' +
      'return "<div class=\\"stat-row\\">"+statCard(rows.length,"Total onboarding")+statCard(thisWeek,"Joining this week")+statCard(nextWeek,"Joining next week")+"</div>";' +
    '}' +
    'function buildOutletBreakdown(rows,selected){' +
      'if(selected)return "";' +
      'var counts={};var order=[];' +
      'rows.forEach(function(r){if(!r.outlet)return;if(!counts[r.outlet]){counts[r.outlet]=0;order.push(r.outlet);}counts[r.outlet]++;});' +
      'if(order.length<2)return "";' +
      'var chips=order.map(function(o){return "<div class=\\"outlet-chip\\"><span class=\\"outlet-chip-name\\">"+esc(o)+"</span><span class=\\"outlet-chip-count\\">"+counts[o]+"</span></div>";}).join("");' +
      'return "<div class=\\"section\\"><div class=\\"section-title\\">By outlet</div><div class=\\"outlet-chips\\">"+chips+"</div></div>";' +
    '}' +
    'function buildStatusBar(rows){' +
      'var counts={};var total=rows.length;' +
      'STATUS_ORDER.forEach(function(s){counts[s]=0;});' +
      'rows.forEach(function(r){if(counts[r.status]===undefined)counts[r.status]=0;counts[r.status]++;});' +
      'var statuses=STATUS_ORDER.concat(Object.keys(counts).filter(function(s){return STATUS_ORDER.indexOf(s)===-1;}));' +
      'if(total===0)return "";' +
      'var segments=statuses.map(function(s){var n=counts[s]||0;if(n===0)return "";var color=STATUS_COLORS[s]||DEFAULT_COLOR;var pct=(n/total*100).toFixed(2);return "<div class=\\"bar-segment\\" style=\\"width:"+pct+"%;background:"+color+"\\" title=\\""+esc(s)+": "+n+"\\"></div>";}).join("");' +
      'var legend=statuses.map(function(s){var n=counts[s]||0;if(n===0)return "";var color=STATUS_COLORS[s]||DEFAULT_COLOR;return "<div class=\\"legend-item\\"><span class=\\"legend-dot\\" style=\\"background:"+color+"\\"></span>"+esc(s)+" <span class=\\"legend-count\\">"+n+"</span></div>";}).join("");' +
      'return "<div class=\\"section\\"><div class=\\"section-title\\">By status</div><div class=\\"bar\\">"+segments+"</div><div class=\\"legend\\">"+legend+"</div></div>";' +
    '}' +
    'function buildGroupedTable(rows){' +
      'var groups={};var order=[];' +
      'rows.forEach(function(r){if(!groups[r.status]){groups[r.status]=[];order.push(r.status);}groups[r.status].push(r);});' +
      'var statusOrder=STATUS_ORDER.concat(order.filter(function(s){return STATUS_ORDER.indexOf(s)===-1;}));' +
      'var body="";' +
      'statusOrder.forEach(function(status){' +
        'var members=groups[status];if(!members||members.length===0)return;' +
        'var color=STATUS_COLORS[status]||DEFAULT_COLOR;' +
        'body+="<tr class=\\"group-header\\"><td colspan=\\"6\\"><span class=\\"badge\\" style=\\"background:"+color+"\\">"+esc(status)+"</span> <span class=\\"muted\\">"+members.length+"</span></td></tr>";' +
        'members.forEach(function(r){' +
          'body+="<tr><td>"+esc(r.outlet)+"</td><td>"+esc(r.name)+"</td><td>"+esc(r.position)+"</td><td>"+esc(fmtDate(r.startDate))+"</td><td>"+esc(fmtDate(r.dueDate))+"</td><td class=\\"muted\\">"+esc(fmtDate(r.lastUpdated))+"</td></tr>";' +
        '});' +
      '});' +
      'return "<div class=\\"table-wrap\\"><table><thead><tr><th>Outlet</th><th>Employee</th><th>Position</th><th>Start Date</th><th>Expected Join Date</th><th>Last Updated</th></tr></thead><tbody>"+body+"</tbody></table></div>";' +
    '}' +
    'function emptyState(selected){' +
      'var who=selected?("<b>"+esc(selected)+"</b>"):"any outlet";' +
      'return "<div class=\\"section\\" style=\\"text-align:center;padding:32px 18px;\\"><div style=\\"font-size:15px;margin-bottom:4px;\\">Nothing\\u2019s cooking at "+who+" right now.</div><div class=\\"muted\\">No one\\u2019s onboarding there at the moment \\u2014 check back soon.</div></div>";' +
    '}' +
    'function findCountry(code){for(var i=0;i<COUNTRIES.length;i++){if(COUNTRIES[i].code===code)return COUNTRIES[i];}return COUNTRIES[0];}' +
    'function initFilterBar(){renderFilterBar();}' +
    'function renderFilterBar(){' +
      'var c=findCountry(CURRENT);var html="";' +
      'if(COUNTRIES.length>1){' +
        'html+="<div class=\\"country-toggle\\">"+COUNTRIES.map(function(cc){return "<button class=\\"country-btn"+(cc.code===CURRENT?" active":"")+"\\" onclick=\\"selectCountry(\'"+cc.code+"\')\\">"+esc(cc.label)+"</button>";}).join("")+"</div>";' +
      '}' +
      'if(c.outlets.length>1){' +
        'var opts=c.outlets.map(function(o){return "<option value=\\""+esc(o)+"\\">"+esc(o)+"</option>";}).join("");' +
        'html+="<div class=\\"filter-row\\"><label for=\\"outletFilter\\" class=\\"muted\\">Filter by outlet</label><select id=\\"outletFilter\\" onchange=\\"render(this.value)\\"><option value=\\"\\">All outlets</option>"+opts+"</select></div>";' +
      '}' +
      'document.getElementById("filter-bar").innerHTML=html;' +
    '}' +
    'function selectCountry(code){' +
      'CURRENT=code;' +
      'var c=findCountry(CURRENT);' +
      'var lbl=document.getElementById("headerLabel");' +
      'if(lbl)lbl.textContent=c.outletsLabel;' +
      'renderFilterBar();' +
      'render("");' +
    '}' +
    'function render(selected){' +
      'var c=findCountry(CURRENT);' +
      'var rows=selected?c.rows.filter(function(r){return r.outlet===selected;}):c.rows;' +
      'var el=document.getElementById("dashboard-body");' +
      'if(rows.length===0){el.innerHTML=emptyState(selected);return;}' +
      'el.innerHTML=buildStatCards(rows)+buildOutletBreakdown(rows,selected)+buildStatusBar(rows)+buildGroupedTable(rows);' +
    '}';
}

function escapeHtml_(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function HtmlOutput_(title, bodyHtml) {
  var html = '' +
    '<!DOCTYPE html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>' + escapeHtml_(title) + '</title>' +
    '<style>' +
      '*{box-sizing:border-box;}' +
      'body{font-family:Arial,Helvetica,sans-serif;margin:0;padding:24px;background:#f5f6f8;color:#1c1c1c;}' +
      '.header{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:20px;flex-wrap:wrap;gap:8px;}' +
      'h1{font-size:22px;margin:0 0 4px 0;}' +
      '.muted{color:#6b6f76;font-size:13px;}' +

      '.stat-row{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:20px;}' +
      '.stat-card{flex:1;min-width:140px;background:#fff;border-radius:10px;padding:16px 18px;box-shadow:0 1px 3px rgba(0,0,0,0.06);border-top:3px solid #7b68ee;}' +
      '.stat-value{font-size:28px;font-weight:700;line-height:1.1;}' +
      '.stat-label{color:#6b6f76;font-size:12px;margin-top:4px;}' +

      '.section{background:#fff;border-radius:10px;padding:16px 18px;box-shadow:0 1px 3px rgba(0,0,0,0.06);margin-bottom:16px;}' +
      '.section-title{font-size:12px;font-weight:600;color:#6b6f76;text-transform:uppercase;letter-spacing:0.03em;margin-bottom:10px;}' +

      '.outlet-chips{display:flex;flex-wrap:wrap;gap:8px;}' +
      '.outlet-chip{display:flex;align-items:center;gap:6px;background:#f5f6f8;border-radius:8px;padding:6px 10px;font-size:13px;}' +
      '.outlet-chip-count{background:#1c1c1c;color:#fff;border-radius:10px;padding:1px 7px;font-size:11px;font-weight:600;}' +

      '.bar{display:flex;height:12px;border-radius:6px;overflow:hidden;background:#f0f0f2;margin-bottom:12px;}' +
      '.bar-segment{height:100%;}' +
      '.legend{display:flex;flex-wrap:wrap;gap:14px;font-size:12px;color:#444;}' +
      '.legend-item{display:flex;align-items:center;gap:6px;}' +
      '.legend-dot{width:8px;height:8px;border-radius:50%;display:inline-block;}' +
      '.legend-count{color:#6b6f76;}' +

      '.filter-row{display:flex;align-items:center;gap:10px;margin-bottom:16px;}' +
      '#outletFilter{font-size:13px;padding:5px 8px;border-radius:6px;border:1px solid #ddd;background:#fff;color:#1c1c1c;}' +

      '.country-toggle{display:flex;gap:8px;margin-bottom:12px;}' +
      '.country-btn{font-size:13px;padding:6px 16px;border-radius:20px;border:1px solid #ddd;background:#fff;color:#1c1c1c;cursor:pointer;}' +
      '.country-btn.active{background:#1c1c1c;color:#fff;border-color:#1c1c1c;}' +

      '.table-wrap{overflow-x:auto;background:#fff;border-radius:10px;box-shadow:0 1px 3px rgba(0,0,0,0.06);}' +
      'table{width:100%;border-collapse:collapse;}' +
      'th,td{text-align:left;padding:10px 12px;border-bottom:1px solid #eee;font-size:13px;white-space:nowrap;}' +
      'th{background:#fafafa;font-weight:600;color:#444;}' +
      'tr.group-header td{background:#fafbfc;padding:8px 12px;border-bottom:1px solid #eee;}' +
      '.badge{display:inline-block;color:#fff;padding:3px 10px;border-radius:12px;font-size:12px;white-space:nowrap;}' +
    '</style></head><body>' + bodyHtml + '</body></html>';
  return HtmlService.createHtmlOutput(html)
    .setTitle(title)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}
