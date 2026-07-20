// ============================================================
// STATE
// ============================================================
let STATE = {
  email: sessionStorage.getItem('email') || null,
  code: sessionStorage.getItem('code') || null,
  role: sessionStorage.getItem('role') || null,
  clients: [],
  manualChargeRows: [],
  searchTerm: '',
  paymentMethodsLoaded: false, // Stage 2: "Charge Customers" button lock — true hote hi enable hota hai (session ke liye; reload par phir se Load karna hoga)
  chargeStageStatusFilter: null, // set niche CHARGE_STAGE_STATUSES define hone ke baad (default filter)

  // ⭐ Terminated Clients page
  terminatedClients: [],
  terminatedStageFilter: new Set(['Pending Archive', 'Archived'])
};

// There's no fixed limit on Additional Services — as many as needed can be
// added via "+ Add Service" (the sheet automatically creates new columns).
function getServiceNumbers_(obj) {
  const nums = [];
  Object.keys(obj || {}).forEach(k => {
    const m = k.match(/^Additional Service (\d+)$/);
    if (m && String(obj[k] || '').trim() !== '') nums.push(parseInt(m[1], 10));
  });
  return nums.sort((a, b) => a - b);
}

// ============================================================
// LIVE CALCULATION (mirrors the sheet formulas):
//   Billing Amount ($)  = Practice Monthly Collection ($) x Medical Billing Rate (%)
//   Benefits Amount ($) = Benefits Verification Rate ($) x No. of Verified Benefits
// Monthly Minimum logic is intentionally NOT applied here — sendInvoices()
// in Stripe.gs/Code.gs already handles that at send-time.
// ============================================================
function parseNum_(val) {
  if (val === null || val === undefined || val === '') return 0;
  const n = parseFloat(String(val).replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? 0 : n;
}

// Handles rate stored as "6%", "6", or a raw decimal fraction like 0.06
// (same convention already used by formatFieldValue() below).
function parseRatePercent_(val) {
  if (val === null || val === undefined || val === '') return 0;
  const s = String(val).trim();
  const hasPercentSign = s.includes('%');
  const num = parseFloat(s.replace('%', ''));
  if (isNaN(num)) return 0;
  if (hasPercentSign) return num / 100;
  return (num > 0 && num < 1) ? num : num / 100;
}

// Sheet header -> friendlier display label (doesn't change the sheet's actual column name)
const LABELS = {
  'Practice Collection Month': 'Invoice Month',
  'Monthly Minimum (Billing)': 'Minimum Amount'
};
function label(key) { return LABELS[key] || key; }

// All real invoice statuses (set manually or by scripts in the sheet)
// The first '' option is always the blank/unselected default.
const INVOICE_STATUS_OPTIONS = [
  'Need to Send Invoice',
  'Manual Invoice - Check Sheet',
  'Manual Invoice Sent - Check Sheet',
  'Sent',
  'Paid',
  'Already Paid',
  'ACH-Initiated',
  'Failed',
  'Do Not Invoice'
];

// Status groupings used by the dashboards below
const SENT_STATUSES = ['Sent', 'Paid', 'Already Paid', 'ACH-Initiated', 'Failed', 'Manual Invoice Sent - Check Sheet'];
const PENDING_STATUSES = ['Need to Send Invoice', ''];
// Manual invoice clients (Melissa/Maribel/Sabah, ya future manual clients) —
// inhe alag dashboard card mein dikhaya jata hai, "Pending" mein nahi.
const MANUAL_STATUSES = ['Manual Invoice - Check Sheet'];
const CHARGED_STATUSES = ['Paid', 'Already Paid'];
const CHARGE_PENDING_STATUSES = ['Sent', 'ACH-Initiated'];
const FAILED_STATUSES = ['Failed'];

// Stage 2 (Charge Customers page) — sirf wo clients dikhayein jinka Stripe
// invoice already ban chuka hai, warna "Need to Send Invoice" jaise clients
// bhi list mein aa jate jinhe abhi charge nahi kiya ja sakta.
const CHARGE_STAGE_STATUSES = ['Sent', 'ACH-Initiated', 'Failed'];

// Charge Customers page ke top par status-filter chips — default sirf
// CHARGE_STAGE_STATUSES checked rehte hain. Jab koi client charge ho kar
// "Paid" / "Already Paid" ho jata hai to wo list se gayab ho jata hai
// (kyunki ab charge-ready nahi raha) — is filter se banda unhi ko wapas
// isi window mein tick karke dekh sakta hai.
const CHARGE_STAGE_FILTER_OPTIONS = [
  { key: 'Sent', label: 'Sent', tone: 'warn' },
  { key: 'ACH-Initiated', label: 'ACH-Initiated', tone: 'warn' },
  { key: 'Failed', label: 'Failed', tone: 'danger' },
  { key: 'Paid', label: 'Paid', tone: 'ok' },
  { key: 'Already Paid', label: 'Already Paid', tone: 'ok' }
];
STATE.chargeStageStatusFilter = new Set(CHARGE_STAGE_STATUSES);

const REQUIRED_FIELDS = [
  { key: 'Client Name', type: 'text' },
  { key: 'Email', type: 'email' },
  { key: 'Medical Billing Rate (%)', type: 'text', hint: 'e.g. 6 or 6% — always saved as a percentage' },
  { key: 'Monthly Minimum (Billing)', type: 'number' },
  { key: 'Benefits Verification Rate ($)', type: 'number' }
];

const OPTIONAL_ADD_FIELDS = [
  { key: 'Payment Method', type: 'select', options: ['Credit/Debit Card', 'ACH', 'ACH and Credit/Debit'] },
  { key: 'Practice Collection Month', type: 'text', hint: 'e.g. July 2026' },
  { key: 'Special Instructions', type: 'text' }
];

// These only show up in the edit modal (data needed for billing calculations)
const EDIT_ONLY_FIELDS = [
  { key: 'Practice Monthly Collection ($)', type: 'number' },
  { key: 'No. of Verified Benefits', type: 'number' },
  { key: 'Billing Amount ($)', type: 'number' },
  { key: 'Benefits Amount ($)', type: 'number' },
  { key: 'Invoice Status', type: 'select', options: INVOICE_STATUS_OPTIONS }
];

// Main table columns (besides Client / Status / Actions) — SR# is not shown
const SUMMARY_COLUMNS = [
  'Practice Collection Month',
  'Monthly Minimum (Billing)',
  'Billing Amount ($)',
  'Benefits Amount ($)',
  'Additional Amount ($)',
  'Total Invoice ($)'
];

// Columns shown when a row is expanded (▸) — services are added conditionally below
const BASE_DETAIL_COLUMNS = [
  'Payment Method',
  'Practice Monthly Collection ($)',
  'No. of Verified Benefits',
  'Client Status',
  'Termination Date'
];

// ============================================================
// LOGIN (Email + Access Code — checked against the "Users" sheet tab)
// ============================================================
window.addEventListener('DOMContentLoaded', () => {
  if (!CONFIG.WEB_APP_URL || CONFIG.WEB_APP_URL.startsWith('PASTE_')) {
    showGateError('WEB_APP_URL is not set in config.js.');
    return;
  }

  document.getElementById('loginForm').addEventListener('submit', handleLoginSubmit);

  if (STATE.email && STATE.code && STATE.role) {
    enterDashboard();
  }

  bindUI();
});

async function handleLoginSubmit(e) {
  e.preventDefault();
  const email = document.getElementById('loginEmail').value.trim();
  const code = document.getElementById('loginCode').value.trim();
  const btn = document.getElementById('loginBtn');
  btn.disabled = true;
  btn.textContent = 'Checking…';

  STATE.email = email;
  STATE.code = code;

  try {
    const res = await apiCall('login', {});
    if (!res.success) {
      showGateError(res.error || 'Login failed.');
      STATE.email = null;
      STATE.code = null;
      return;
    }
    STATE.role = res.role;
    sessionStorage.setItem('email', STATE.email);
    sessionStorage.setItem('code', STATE.code);
    sessionStorage.setItem('role', STATE.role);
    document.getElementById('gateError').style.display = 'none';
    enterDashboard();
  } catch (err) {
    showGateError(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sign in';
  }
}

function showGateError(msg) {
  const el = document.getElementById('gateError');
  el.textContent = msg;
  el.style.display = 'block';
}

function signOut() {
  sessionStorage.clear();
  STATE = {
    email: null, code: null, role: null, clients: [], searchTerm: '', paymentMethodsLoaded: false,
    chargeStageStatusFilter: new Set(CHARGE_STAGE_STATUSES),
    terminatedClients: [], terminatedStageFilter: new Set(['Pending Archive', 'Archived'])
  };
  document.getElementById('mainApp').style.display = 'none';
  document.getElementById('chargeStagePage').style.display = 'none';
  document.getElementById('terminatedPage').style.display = 'none';
  const chargeBtn = document.getElementById('chargeCustomersBtn');
  if (chargeBtn) { chargeBtn.disabled = true; chargeBtn.title = "Run 'Load Payment Methods' first"; }
  document.getElementById('authZone').style.display = 'none';
  document.getElementById('loginForm').reset();
  document.getElementById('gate').style.display = 'flex';
}

function enterDashboard() {
  document.getElementById('gate').style.display = 'none';
  document.getElementById('mainApp').style.display = 'block';
  document.getElementById('authZone').style.display = 'flex';

  document.getElementById('userEmail').textContent = STATE.email;
  const roleTag = document.getElementById('roleTag');
  roleTag.textContent = STATE.role;
  roleTag.className = 'role-tag' + (STATE.role === 'viewer' ? ' viewer' : '');

  const editorOnlyIds = ['addPracticeBtn', 'sendInvoicesBtn', 'openChargeStageBtn', 'prepareSheetBtn', 'clearMonthBtn', 'resetNextMonthBtn'];
  editorOnlyIds.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = STATE.role === 'editor' ? 'inline-flex' : 'none';
  });

  loadClients();
}

// ============================================================
// API HELPER
// ============================================================
async function apiCall(action, extra) {
  const payload = Object.assign({ action, email: STATE.email, code: STATE.code }, extra || {});
  const resp = await fetch(CONFIG.WEB_APP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(payload)
  });
  const data = await resp.json();
  if (!data.success && /email|access code/i.test(data.error || '') && action !== 'login') {
    signOut();
  }
  return data;
}

// ============================================================
// LOAD + RENDER TABLE
// ============================================================
async function loadClients() {
  const wrap = document.getElementById('tableWrap');
  // Sirf pehli dafa (jab abhi tak koi client load hi nahi hua) "Loading…" dikhao.
  // Uske baad har refresh (status change, edit, delete, bulk actions waghera) par
  // purani table jaisi ki taisi dikhti rahegi jab tak naya data aa kar seedha
  // uski jagah render na ho jaye — beech mein kuch bhi gayab/blank nahi hoga.
  const isFirstLoad = STATE.clients.length === 0;
  if (isFirstLoad) {
    wrap.innerHTML = '<div class="empty-state"><div class="mark">Loading…</div></div>';
  }

  const res = await apiCall('getClients', {});
  if (!res.success) {
    wrap.innerHTML = `<div class="empty-state"><div class="mark">Something went wrong</div>${escapeHtml(res.error)}</div>`;
    return;
  }
    STATE.clients = res.data;

  const manualRes = await apiCall('getManualInvoicesForCharge', {});
  STATE.manualChargeRows = manualRes.success ? manualRes.data : [];

  document.getElementById('clientCount').textContent = res.data.length;
  renderTable();
  renderSummaryPanel();
  renderDashboards();
  renderCycleProgress();
  renderChargeStageTable(); // same STATE.clients — Stage 2 ka Invoice Status Stage 1 jaisa hi rehta hai
}

function getFilteredClients() {
  const term = (STATE.searchTerm || '').trim().toLowerCase();
  if (!term) return STATE.clients;
  return STATE.clients.filter(c =>
    String(c['Client Name'] || '').toLowerCase().includes(term) ||
    String(c['Email'] || '').toLowerCase().includes(term)
  );
}

function renderTable() {
  const wrap = document.getElementById('tableWrap');
  const clients = getFilteredClients();

  if (STATE.clients.length === 0) {
    wrap.innerHTML = `<div class="empty-state"><div class="mark">No practice has been added yet</div>${STATE.role === 'editor' ? 'Get started with the "Add Practice" button.' : ''}</div>`;
    return;
  }
  if (clients.length === 0) {
    wrap.innerHTML = `<div class="empty-state"><div class="mark">No match found</div>Try a different name or email.</div>`;
    return;
  }

  const isEditor = STATE.role === 'editor';
  let html = '<table><thead><tr>';
  html += '<th class="sticky-col sticky-1"></th>';
  html += '<th class="sticky-col sticky-2">Client</th>';
  SUMMARY_COLUMNS.forEach(c => html += `<th>${escapeHtml(label(c))}</th>`);
  html += '<th>Invoice Status</th>';
  html += '</tr></thead><tbody>';

  clients.forEach(c => {
    html += `<tr>`;
    html += `<td class="sticky-col sticky-1">
      <button class="expand-btn" onclick="toggleDetails(${c.row})" id="expandBtn-${c.row}">▸</button>
      ${isEditor ? `<button class="edit-icon-btn" title="Edit" onclick="openEditModal(${c.row})">✎</button>` : ''}
      ${isEditor ? renderTerminateBtn_(c) : ''}
    </td>`;
    html += `<td class="sticky-col sticky-2"><span class="client-name">${escapeHtml(c['Client Name'] || '')}</span>${renderTerminatedBadge_(c)}<span class="client-email">${escapeHtml(c['Email'] || '')}</span></td>`;
    SUMMARY_COLUMNS.forEach(col => {
      const isMoney = /\(\$\)/.test(col) || col === 'Monthly Minimum (Billing)';
      html += `<td class="${isMoney ? 'money-cell' : ''}">${escapeHtml(getSummaryCellValue(c, col))}</td>`;
    });
    html += `<td id="statusCell-${c.row}">${renderStatusCell(c, isEditor)}</td>`;
    html += '</tr>';

    const colSpan = 3 + SUMMARY_COLUMNS.length;
    const detailCols = BASE_DETAIL_COLUMNS.slice();
    const serviceNums = getServiceNumbers_(c);
    serviceNums.forEach(n => detailCols.push('Additional Service ' + n, 'Rate ' + n, 'Type ' + n));

    html += `<tr class="details-row" id="detailsRow-${c.row}" style="display:none;"><td colspan="${colSpan}"><div class="details-grid">`;
    detailCols.forEach(col => {
      html += `<div class="detail-item"><span class="detail-label">${escapeHtml(label(col))}</span><span class="detail-value">${escapeHtml(c[col] != null && c[col] !== '' ? c[col] : '—')}</span></div>`;
    });
    if (serviceNums.length > 0) {
      html += `<div class="detail-item"><span class="detail-label">Additional Services Total</span><span class="detail-value">$${servicesTotal(c, serviceNums).toFixed(2)}</span></div>`;
    }
    html += `</div></td></tr>`;
  });

  html += '</tbody></table>';
  wrap.innerHTML = html;
}

// Value shown for a SUMMARY_COLUMNS cell — "Additional Amount ($)" is computed
// on the fly (sum of this row's additional services), everything else comes
// straight from the sheet.
function formatMoney_(val) {
  const n = parseFloat(val);
  if (isNaN(n)) return '';
  return '$' + n.toFixed(2);
}

function getSummaryCellValue(c, col) {
  if (col === 'Additional Amount ($)') {
    const nums = getServiceNumbers_(c);
    return formatMoney_(nums.length ? servicesTotal(c, nums) : 0);
  }
  const isMoneyCol = /\(\$\)/.test(col) || col === 'Monthly Minimum (Billing)';
  if (isMoneyCol) return formatMoney_(c[col]);
  return c[col] != null ? c[col] : '';
}

// Works out each additional service's amount: "fixed" type uses the full Rate,
// "percent" type uses Rate% of (Billing Amount + Benefits Amount), for this row
// only. If a client's rows get grouped into one combined invoice on Stripe, the
// actual charged amount for a percent-type service can differ slightly (Stripe
// uses the combined total) — this is just this row's estimate.
function servicesTotal(c, serviceNums) {
  const base = (parseFloat(c['Billing Amount ($)']) || 0) + (parseFloat(c['Benefits Amount ($)']) || 0);
  let total = 0;
  serviceNums.forEach(n => {
    const rate = parseFloat(c['Rate ' + n]) || 0;
    const type = String(c['Type ' + n] || '').trim().toLowerCase();
    if (type === 'fixed') total += rate;
    else if (type === 'percent') total += base * (rate / 100);
  });
  return total;
}

function toggleDetails(row) {
  const detailsRow = document.getElementById('detailsRow-' + row);
  const btn = document.getElementById('expandBtn-' + row);
  const isOpen = detailsRow.style.display !== 'none';
  detailsRow.style.display = isOpen ? 'none' : 'table-row';
  btn.textContent = isOpen ? '▸' : '▾';
}

// "Need to Send Invoice" is the real status value used by the backend
// (Prepare Sheet / Send Invoices logic) — but to the user it should just
// read as "Pending" until an invoice has actually gone out.
const STATUS_DISPLAY_LABELS = { 'Need to Send Invoice': 'Pending' };

function statusStamp(status) {
  const s = String(status || 'Pending').trim();
  const cls = s.toLowerCase().replace(/\s+/g, '-');
  const displayLabel = STATUS_DISPLAY_LABELS[s] || s;
  return `<span class="stamp ${cls}">${escapeHtml(displayLabel)}</span>`;
}

function renderStatusCell(c, isEditor) {
  if (!isEditor) return statusStamp(c['Invoice Status']);
  return `<span class="status-click" onclick="openStatusEditor(${c.row})" title="Click to change status">${statusStamp(c['Invoice Status'])}</span>`;
}

// ⭐ TERMINATION — row action button (sticky col 1): agar client already
// Terminated hai to ek chota "reactivate" button dikhao, warna "Terminate".
function renderTerminateBtn_(c) {
  const isTerminated = String(c['Client Status'] || '').trim().toLowerCase() === 'terminated';
  if (isTerminated) {
    return `<button class="reactivate-icon-btn" title="Reactivate client" onclick="reactivateClient(${c.row}, '${escapeAttr(c['Client Name'])}')">↩</button>`;
  }
  return `<button class="terminate-icon-btn" title="Mark as Terminated" onclick="openTerminateDialog(${c.row})">⛔</button>`;
}

// ⭐ TERMINATION — client-name column ke saath ek chota badge, taake row
// expand kiye bina hi dikh jaye ke client terminated hai (aur kis date se).
// yyyy-MM-dd (backend format) -> MM-DD-YYYY (display format). Agar value
// pehle se is format mein nahi hai to jaisa hai waisa hi wapis kar deta hai.
function formatDateDisplay_(isoDate) {
  if (!isoDate) return '';
  const parts = String(isoDate).split('-');
  if (parts.length !== 3) return isoDate;
  return parts[1] + '-' + parts[2] + '-' + parts[0];
}

function renderTerminatedBadge_(c) {
  const isTerminated = String(c['Client Status'] || '').trim().toLowerCase() === 'terminated';
  if (!isTerminated) return '';
  const dateTxt = c['Termination Date'] ? escapeHtml(formatDateDisplay_(c['Termination Date'])) : 'date not set';
  return `<span class="stamp terminated-badge" title="Termination Date: ${dateTxt}">🔴 Terminated · ${dateTxt}</span>`;
}

function openStatusEditor(row) {
  const client = STATE.clients.find(c => c.row === row);
  const cell = document.getElementById('statusCell-' + row);
  if (!client || !cell) return;
  const current = client['Invoice Status'] || '';
  let html = `<select id="statusSelect-${row}" class="status-select" onchange="saveStatusChange(${row}, this.value)" onblur="revertStatusCell(${row})">`;
  html += `<option value="" ${current === '' ? 'selected' : ''}>Pending</option>`;
  INVOICE_STATUS_OPTIONS.forEach(o => html += `<option value="${escapeAttr(o)}" ${current === o ? 'selected' : ''}>${escapeHtml(o)}</option>`);
  html += `</select>`;
  cell.innerHTML = html;
  document.getElementById('statusSelect-' + row).focus();
}

// Jab tak koi status save ho raha ho, us row ke liye revertStatusCell()
// ko blur waghera se accidentally trigger na hone do — warna select () DOM
// se hatate hi jo synchronous "blur" event fire hota hai wo revertStatusCell
// ko bula kar humara "Loading…" turant purane status se overwrite kar deta
// tha, aur lagta tha jaise status change ho hi nahi raha.
const STATUS_SAVING_ROWS = new Set();

function revertStatusCell(row) {
  if (STATUS_SAVING_ROWS.has(row)) return; // saveStatusChange abhi khud is cell ko control kar raha hai
  const client = STATE.clients.find(c => c.row === row);
  const cell = document.getElementById('statusCell-' + row);
  if (client && cell) cell.innerHTML = renderStatusCell(client, true);
}

async function saveStatusChange(row, newStatus) {
  STATUS_SAVING_ROWS.add(row);

  // NOTE: cell.innerHTML ko turant (isi synchronous onchange call ke andar)
  // nahi badalte — select abhi bhi focused hai, aur usay DOM se hataate hi
  // jo synchronous 'blur' event fire hota hai wo isi waqt cell ko chhedne ki
  // koshish karta hai, jis se browser "node to be removed is no longer a
  // child of this node… moved in a 'blur' event handler" wala error deta hai.
  // Isliye ek tick baad (setTimeout 0) badalte hain — us waqt tak blur cycle
  // poora ho chuka hota hai aur koi race nahi rehta.
  setTimeout(() => {
    const cell = document.getElementById('statusCell-' + row);
    if (cell) cell.innerHTML = '<span class="stamp status-loading">Loading…</span>';
  }, 0);

  const res = await apiCall('updateClient', { row, data: { 'Invoice Status': newStatus } });
  if (res.success) {
    toast('Status updated.', 'ok');
    // Poora page reload/refetch karne ki zaroorat nahi — sirf isi client ka
    // status STATE mein update karke halke se dashboards/summary re-render
    // karo, taake turant agli row edit ki ja sake, wait na karna pade.
    const client = STATE.clients.find(c => c.row === row);
    if (client) client['Invoice Status'] = newStatus;
    renderSummaryPanel();
    renderDashboards();
    renderCycleProgress();
    renderChargeStageTable();
  } else {
    toast(res.error, 'error');
  }
  STATUS_SAVING_ROWS.delete(row);
  revertStatusCell(row); // dropdown/loading indicator hata kar asli (naya ya purana) status badge dikhao
}

// ============================================================
// SUMMARY PANEL (right sidebar)
// ============================================================
function computeSummaryByPractice() {
  const map = {};
  STATE.clients.forEach(c => {
    const key = c['Client Name'] || '(No name)';
    const amt = parseFloat(c['Total Invoice ($)']) || 0;
    map[key] = (map[key] || 0) + amt;
  });
  return Object.keys(map).sort((a, b) => a.localeCompare(b)).map(name => ({ name, amount: map[name] }));
}

function renderSummaryPanel() {
  const el = document.getElementById('summaryCard');
  if (!el) return;
  const rows = computeSummaryByPractice();
  const grandTotal = rows.reduce((s, r) => s + r.amount, 0);

  let html = '<h3 class="summary-title">Summary By Practice</h3>';
  if (rows.length === 0) {
    html += '<div class="summary-empty">No data yet.</div>';
  } else {
    html += '<div class="summary-list">';
    rows.forEach(r => {
      html += `<div class="summary-row"><span class="summary-name">${escapeHtml(r.name)}</span><span class="summary-amt">$${r.amount.toFixed(2)}</span></div>`;
    });
    html += '</div>';
  }
  html += `<div class="summary-grand"><span>Grand Total</span><span>$${grandTotal.toFixed(2)}</span></div>`;
  el.innerHTML = html;
}

// ============================================================
// INVOICE CYCLE PROGRESS panel (right sidebar, below Summary By Practice)
// Reuses DASH_BUCKETS (already computed in renderDashboards()) — isliye
// renderCycleProgress() hamesha renderDashboards() ke BAAD call karna hai.
// ============================================================
function computeCycleProgress_() {
  // "Do Not Invoice" clients ko is tracker se nikal dete hain — unka month/invoice
  // kabhi banna hi nahi, isliye unhe count karne se ye card kabhi "done" nahi hota.
  // Terminated clients ko bhi isi wajah se nikala hai.
  const trackedClients = STATE.clients.filter(c => {
    const name = String(c['Client Name'] || '').trim();
    if (name === '') return false;
    const status = String(c['Invoice Status'] || '').trim().toLowerCase();
    const clientStatus = String(c['Client Status'] || '').trim().toLowerCase();
    if (status === 'do not invoice') return false;
    if (clientStatus === 'terminated') return false;
    return true;
  });
  const total = trackedClients.length;
  const monthSet = trackedClients.filter(c => String(c['Practice Collection Month'] || '').trim() !== '').length;

  const sentTotal = (DASH_BUCKETS.sent || []).length;        // Sent/Paid/Already Paid/ACH-Initiated/Failed/Manual Sent
  const pendingTotal = (DASH_BUCKETS.pending || []).length;  // Need to Send Invoice / blank
  const chargedTotal = (DASH_BUCKETS.charged || []).length;  // Paid/Already Paid
  const chargePendingTotal = (DASH_BUCKETS.chargePending || []).length; // Sent/ACH-Initiated
  const failedTotal = (DASH_BUCKETS.failed || []).length;    // Failed

  return [
    {
      label: 'Invoice Month Set',
      detail: monthSet + ' / ' + total + ' practices ("Prepare Sheet to Send Invoice")',
      state: total > 0 && monthSet === total ? 'done' : (monthSet > 0 ? 'progress' : 'pending')
    },
    {
      label: 'Invoices Sent',
      detail: sentTotal + ' sent · ' + pendingTotal + ' still pending',
      state: total > 0 && pendingTotal === 0 && sentTotal > 0 ? 'done' : (sentTotal > 0 ? 'progress' : 'pending')
    },
    {
      label: 'Charge Customers',
      detail: chargedTotal + ' charged · ' + chargePendingTotal + ' waiting to be charged',
      state: sentTotal > 0 && chargePendingTotal === 0 && chargedTotal > 0
        ? 'done'
        : (chargedTotal > 0 || chargePendingTotal > 0 ? 'progress' : 'pending')
    },
    {
      label: 'Failed Charges',
      detail: failedTotal > 0 ? failedTotal + ' need attention' : 'None right now',
      state: failedTotal > 0 ? 'warn' : 'done'
    },
    {
      label: 'Reset for Next Month',
      detail: 'Manual last step — run once everything above is settled',
      state: 'manual'
    }
  ];
}

const CYCLE_STEP_ICON_ = { done: '✅', progress: '⏳', warn: '⚠️', pending: '⬜', manual: '🔁' };

function renderCycleProgress() {
  const el = document.getElementById('cycleProgressCard');
  if (!el) return;
  const steps = computeCycleProgress_();

  let html = '<h3 class="summary-title">Invoice Cycle Progress</h3><div class="cycle-steps">';
  steps.forEach(s => {
    const icon = CYCLE_STEP_ICON_[s.state] || '⬜';
    html += `<div class="cycle-step cycle-${s.state}">
      <div class="cycle-step-icon">${icon}</div>
      <div class="cycle-step-text">
        <div class="cycle-step-label">${escapeHtml(s.label)}</div>
        <div class="cycle-step-detail">${escapeHtml(s.detail)}</div>
      </div>
    </div>`;
  });
  html += '</div>';
  el.innerHTML = html;
}

// ============================================================
// DASHBOARDS (Invoice status + Card charge status)
// ============================================================
let DASH_BUCKETS = {};

function statusMatches(status, list) {
  const s = String(status || '').trim();
  return list.includes(s);
}

function clientsByStatus(list) {
  return STATE.clients.filter(c => statusMatches(c['Invoice Status'], list));
}

// ⭐ "Card Charge Status" ko sirf Master sheet clients tak mehdood nahi
// rehna chahiye — "Manual Invoices" sheet ki rows (Melissa/Maribel/Sabah
// jaisi manual invoices) bhi charge hoti hain aur unka apna Invoice Status
// (Sent/Paid/Failed/ACH-Initiated) hota hai. Ye dono jagah se combine
// karke filter karta hai.
function clientsByStatusMerged_(list) {
  const allRows = STATE.clients.concat(STATE.manualChargeRows || []);
  return allRows.filter(c => statusMatches(c['Invoice Status'], list));
}

// Master rows ka amount "Total Invoice ($)" mein hota hai, Manual Invoices
// sheet ki rows ka amount "Amount ($)" mein — dono field names handle
// karta hai, taake manual invoices ki value bhi sum mein shamil ho.
function invoiceAmount_(c) {
  const raw = (c['Total Invoice ($)'] !== undefined && c['Total Invoice ($)'] !== '')
    ? c['Total Invoice ($)']
    : c['Amount ($)'];
  return parseFloat(raw) || 0;
}

function sumInvoiceAmt_(rows) {
  return rows.reduce((s, c) => s + invoiceAmount_(c), 0);
}

function renderDashboards() {
  DASH_BUCKETS = {
    sent: clientsByStatus(SENT_STATUSES),
    pending: clientsByStatus(PENDING_STATUSES),
    manual: clientsByStatus(MANUAL_STATUSES),
    // ⭐ Charge-related buckets ab Master + Manual Invoices dono se aate hain
    charged: clientsByStatusMerged_(CHARGED_STATUSES),
    chargePending: clientsByStatusMerged_(CHARGE_PENDING_STATUSES),
    failed: clientsByStatusMerged_(FAILED_STATUSES)
  };

  const invoiceEl = document.getElementById('invoiceDash');
  if (invoiceEl) {
    invoiceEl.innerHTML = `
      <h3 class="dash-title">Invoice Status</h3>
      <div class="dash-cards">
        ${dashCardHtml('sent', 'Invoice Sent', DASH_BUCKETS.sent, 'ok')}
        ${dashCardHtml('pending', 'Pending', DASH_BUCKETS.pending, 'warn')}
        ${dashCardHtml('manual', 'Manual Invoice', DASH_BUCKETS.manual, 'warn')}
      </div>`;
  }

  const chargeEl = document.getElementById('chargeDash');
  if (chargeEl) {
    chargeEl.innerHTML = `
      <h3 class="dash-title">Card Charge Status</h3>
      <div class="dash-cards">
        ${dashCardHtml('charged', 'Already Charged', DASH_BUCKETS.charged, 'ok')}
        ${dashCardHtml('chargePending', 'Charge Pending', DASH_BUCKETS.chargePending, 'warn')}
        ${dashCardHtml('failed', 'Failed', DASH_BUCKETS.failed, 'danger')}
      </div>`;
  }

  const terminatedCountEl = document.getElementById('terminatedNavCount');
  if (terminatedCountEl) {
    const count = STATE.clients.filter(c => String(c['Client Status'] || '').trim().toLowerCase() === 'terminated').length;
    terminatedCountEl.textContent = count;
  }
}

function dashCardHtml(key, cardLabel, rows, tone) {
  return `<div class="dash-card ${tone}" onclick="openStatusDialog('${key}', '${escapeAttr(cardLabel)}')">
    <div class="dash-count">${rows.length}</div>
    <div class="dash-amt">$${sumInvoiceAmt_(rows).toFixed(2)}</div>
    <div class="dash-label">${escapeHtml(cardLabel)}</div>
  </div>`;
}

function openStatusDialog(key, dialogLabel) {
  const rows = DASH_BUCKETS[key] || [];
  document.getElementById('statusDialogTitle').textContent = dialogLabel + ' (' + rows.length + ')';

  let html = '<div class="status-dialog-table-wrap"><table class="status-dialog-table"><thead><tr>';
  html += '<th>Client</th><th>Email</th><th>Payment Method</th><th>Total Invoice ($)</th><th>Invoice Status</th>';
  html += '</tr></thead><tbody>';
  if (rows.length === 0) {
    html += '<tr><td colspan="5" class="status-dialog-empty">No practices in this category.</td></tr>';
  } else {
    rows.forEach(c => {
      html += `<tr>
        <td>${escapeHtml(c['Client Name'] || '')}</td>
        <td>${escapeHtml(c['Email'] || '')}</td>
        <td>${escapeHtml(c['Payment Method'] || '—')}</td>
        <td class="money-cell">${escapeHtml(c['Total Invoice ($)'] != null ? c['Total Invoice ($)'] : '')}</td>
        <td>${statusStamp(c['Invoice Status'])}</td>
      </tr>`;
    });
  }
  html += '</tbody></table></div>';
  document.getElementById('statusDialogBody').innerHTML = html;
  document.getElementById('statusDialogOverlay').classList.add('open');

  document.getElementById('statusDialogExcelBtn').onclick = () => exportRowsToExcel(rows, dialogLabel);
}

function closeStatusDialog() {
  document.getElementById('statusDialogOverlay').classList.remove('open');
}

// ============================================================
// STAGE 1 -> STAGE 2 PAGE SWITCH
// ============================================================
function openChargeStage() {
  document.getElementById('mainApp').style.display = 'none';
  document.getElementById('chargeStagePage').style.display = 'block';
  renderChargeStageTable();
}

function backToDashboard() {
  document.getElementById('chargeStagePage').style.display = 'none';
  document.getElementById('mainApp').style.display = 'block';
}

// ============================================================
// TERMINATED CLIENTS PAGE
// ============================================================
async function openTerminatedPage() {
  document.getElementById('mainApp').style.display = 'none';
  document.getElementById('terminatedPage').style.display = 'block';
  await loadTerminatedClients();
}

function backFromTerminatedPage() {
  document.getElementById('terminatedPage').style.display = 'none';
  document.getElementById('mainApp').style.display = 'block';
}

async function loadTerminatedClients() {
  const wrap = document.getElementById('terminatedTableWrap');
  if (wrap) wrap.innerHTML = '<div class="empty-state"><div class="mark">Loading…</div></div>';

  const res = await apiCall('getTerminatedClients', {});
  if (!res.success) {
    if (wrap) wrap.innerHTML = `<div class="empty-state"><div class="mark">Something went wrong</div>${escapeHtml(res.error)}</div>`;
    return;
  }
  STATE.terminatedClients = res.data;
  renderTerminatedSummary();
  renderTerminatedFilters();
  renderTerminatedTable();
}

function renderTerminatedSummary() {
  const el = document.getElementById('terminatedSummary');
  if (!el) return;
  const all = STATE.terminatedClients;
  const pending = all.filter(c => c.stage === 'Pending Archive');
  const archived = all.filter(c => c.stage === 'Archived');

  el.innerHTML = `
    <div class="charge-summary-card warn">
      <div class="charge-summary-label">Pending Archive</div>
      <div class="charge-summary-count">${pending.length} client${pending.length === 1 ? '' : 's'}</div>
      <div class="charge-summary-amt">Abhi Master sheet mein hain</div>
    </div>
    <div class="charge-summary-card ok">
      <div class="charge-summary-label">Archived</div>
      <div class="charge-summary-count">${archived.length} client${archived.length === 1 ? '' : 's'}</div>
      <div class="charge-summary-amt">Master se hat chuke hain</div>
    </div>`;
}

const TERMINATED_FILTER_OPTIONS = [
  { key: 'Pending Archive', label: 'Pending Archive', tone: 'warn' },
  { key: 'Archived', label: 'Archived', tone: 'ok' }
];

function renderTerminatedFilters() {
  const wrap = document.getElementById('terminatedFilters');
  if (!wrap) return;

  let html = '<span class="filter-label">Show:</span>';
  TERMINATED_FILTER_OPTIONS.forEach(opt => {
    const checked = STATE.terminatedStageFilter.has(opt.key) ? 'checked' : '';
    html += `<label class="status-filter-chip ${opt.tone}">
      <input type="checkbox" ${checked} onchange="toggleTerminatedFilter('${escapeAttr(opt.key)}', this.checked)">
      ${escapeHtml(opt.label)}
    </label>`;
  });
  wrap.innerHTML = html;
}

function toggleTerminatedFilter(stage, checked) {
  if (checked) STATE.terminatedStageFilter.add(stage);
  else STATE.terminatedStageFilter.delete(stage);
  renderTerminatedTable();
}

let TERMINATED_LAST_ROWS = [];

function renderTerminatedTable() {
  const wrap = document.getElementById('terminatedTableWrap');
  if (!wrap) return;

  const rows = STATE.terminatedClients.filter(c => STATE.terminatedStageFilter.has(c.stage));
  TERMINATED_LAST_ROWS = rows;

  const countEl = document.getElementById('terminatedPageCount');
  if (countEl) countEl.textContent = rows.length;

  let html = '<table><thead><tr>';
  html += '<th>Client Name / Email</th><th>Termination Date</th><th>Stage</th><th>Marked On</th><th>Notes</th><th></th>';
  html += '</tr></thead><tbody>';

  if (rows.length === 0) {
    html += '<tr><td colspan="6" class="status-dialog-empty">No terminated clients match the selected filter above.</td></tr>';
  } else {
    rows.forEach(c => {
      const isArchived = c.stage === 'Archived';
      const stageBadge = isArchived
        ? '<span class="stamp sent">Archived</span>'
        : '<span class="stamp pending">Pending Archive</span>';
      const reactivateBtn = (!isArchived && c.row)
        ? `<button class="reactivate-icon-btn" title="Reactivate client" onclick="reactivateClient(${c.row}, '${escapeAttr(c['Client Name'])}')">↩ Reactivate</button>`
        : '';
      html += `<tr>
        <td><span class="client-name">${escapeHtml(c['Client Name'] || '')}</span><span class="client-email">${escapeHtml(c['Email'] || '')}</span></td>
        <td>${escapeHtml(formatDateDisplay_(c['Termination Date']))}</td>
        <td>${stageBadge}</td>
        <td>${escapeHtml(formatDateDisplay_(c['Marked On']) || '—')}</td>
        <td>${escapeHtml(c['Deletion Status'] || '—')}</td>
        <td>${reactivateBtn}</td>
      </tr>`;
    });
  }

  html += '</tbody></table>';
  wrap.innerHTML = html;
}

function exportTerminatedToExcel() {
  if (typeof XLSX === 'undefined') {
    toast('Excel export library failed to load.', 'error');
    return;
  }
  if (!TERMINATED_LAST_ROWS.length) {
    toast('Nothing to export — no rows match the current filter.', 'error');
    return;
  }
  const data = TERMINATED_LAST_ROWS.map(c => ({
    'Client Name': c['Client Name'] || '',
    'Email': c['Email'] || '',
    'Termination Date': c['Termination Date'] || '',
    'Stage': c.stage || '',
    'Marked On': c['Marked On'] || '',
    'Notes': c['Deletion Status'] || ''
  }));
  const ws = XLSX.utils.json_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Terminated Clients');
  const fileName = 'terminated-clients-' + new Date().toISOString().slice(0, 10) + '.xlsx';
  XLSX.writeFile(wb, fileName);
}

// ============================================================
// STAGE 2 — CHARGE CUSTOMERS TABLE
// ============================================================
function renderChargeStageSummary() {
  const el = document.getElementById('chargeStageSummary');
  if (!el) return;

const allRows = STATE.clients.concat(STATE.manualChargeRows || []);
  const byStatus = list => allRows.filter(c => list.includes(String(c['Invoice Status'] || '').trim()));
  const sumAmt = rows => rows.reduce((s, c) => s + invoiceAmount_(c), 0);
  const invoiceWord = n => n + ' invoice' + (n === 1 ? '' : 's');

  const buckets = [
    { key: 'charged', label: 'Charged', tone: 'ok', rows: byStatus(CHARGED_STATUSES) },
    { key: 'pending', label: 'Pending', tone: 'warn', rows: byStatus(CHARGE_PENDING_STATUSES) },
    { key: 'failed', label: 'Failed', tone: 'danger', rows: byStatus(FAILED_STATUSES) }
  ];

  el.innerHTML = buckets.map(b => `
    <div class="charge-summary-card ${b.tone}">
      <div class="charge-summary-label">${escapeHtml(b.label)}</div>
      <div class="charge-summary-count">${invoiceWord(b.rows.length)}</div>
      <div class="charge-summary-amt">$${sumAmt(b.rows).toFixed(2)}</div>
    </div>`).join('');
}

function renderChargeStageFilters() {
  const wrap = document.getElementById('chargeStageFilters');
  if (!wrap) return;

  let html = '<span class="filter-label">Show statuses:</span>';
  CHARGE_STAGE_FILTER_OPTIONS.forEach(opt => {
    const checked = STATE.chargeStageStatusFilter.has(opt.key) ? 'checked' : '';
    html += `<label class="status-filter-chip ${opt.tone}">
      <input type="checkbox" ${checked} onchange="toggleChargeStageFilter('${escapeAttr(opt.key)}', this.checked)">
      ${escapeHtml(opt.label)}
    </label>`;
  });
  wrap.innerHTML = html;
}

function toggleChargeStageFilter(status, checked) {
  if (checked) STATE.chargeStageStatusFilter.add(status);
  else STATE.chargeStageStatusFilter.delete(status);
  renderChargeStageTable();
}

let CHARGE_STAGE_LAST_ROWS = [];

function renderChargeStageTable() {
  renderChargeStageSummary();
  renderChargeStageFilters();

  const wrap = document.getElementById('chargeStageTableWrap');
  if (!wrap) return; // Stage 2 abhi DOM mein nahi (safety check)

  const allRows = STATE.clients.concat(STATE.manualChargeRows || []);   const rows = allRows.filter(c => STATE.chargeStageStatusFilter.has(String(c['Invoice Status'] || '').trim()));
  CHARGE_STAGE_LAST_ROWS = rows; // Download Excel button isi (currently filtered) list ko export karta hai
  const countEl = document.getElementById('chargeStageCount');
  if (countEl) countEl.textContent = rows.length;

  let html = '<table><thead><tr>';
  html += '<th>Client Name / Email</th><th>Payment Method</th><th>Stripe Customer ID</th>';
  html += '<th>Payment Method ID</th><th>Invoice ID</th><th>Total Invoice ($)</th><th>Invoice Status</th><th>Remarks</th>';
  html += '</tr></thead><tbody>';

  if (rows.length === 0) {
    html += '<tr><td colspan="8" class="status-dialog-empty">No clients match the selected status filter above.</td></tr>';
  } else {
    rows.forEach(c => {
      const status = String(c['Invoice Status'] || '').trim();
      const isFailed = status === 'Failed';
      const remarks = c['Remarks'] || '';
      html += `<tr>
        <td><span class="client-name">${escapeHtml(c['Client Name'] || '')}</span><span class="client-email">${escapeHtml(c['Email'] || '')}</span></td>
        <td>${escapeHtml(c['Payment Method'] || '—')}</td>
        <td>${escapeHtml(c['Stripe Customer ID'] || '—')}</td>
        <td>${escapeHtml(c['Payment Method ID'] || '—')}</td>
        <td>${escapeHtml(c['Invoice ID'] || '—')}</td>
        <td class="money-cell">${escapeHtml(c['Total Invoice ($)'] != null ? c['Total Invoice ($)'] : '')}</td>
        <td>${statusStamp(status)}</td>
        <td class="${isFailed ? 'remarks-error' : ''}">${remarks ? (isFailed ? '⚠ ' : '') + escapeHtml(remarks) : '—'}</td>
      </tr>`;
    });
  }

  html += '</tbody></table>';
  wrap.innerHTML = html;
}

// ============================================================
// BULK ACTION BUTTONS (Send Invoices / Load Payment Methods / Charge Customers)
// ============================================================
async function runBulkAction(btn, action, doneMsg) {
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Running…';
  try {
    const res = await apiCall(action, {});
    if (res.success) {
      toast(doneMsg, 'ok');
      await loadClients();
      return true;
    } else {
      toast(res.error || 'Something went wrong.', 'error');
      return false;
    }
  } catch (err) {
    toast(err.message, 'error');
    return false;
  } finally {
    btn.textContent = originalText;
    btn.disabled = false;
  }
}

async function handleSendInvoicesClick() {
  const btn = document.getElementById('sendInvoicesBtn');
  await runBulkAction(btn, 'sendInvoicesBulk', 'Invoices sent.');
}

// ⭐ "Prepare Sheet to Send Invoice" — sab clients ke Invoice Month mein
// current month ("July 2026" jaisa format) bhar deta hai, Send Invoices
// se pehle chalaya jata hai.
async function handlePrepareSheetClick() {
  const btn = document.getElementById('prepareSheetBtn');
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Preparing…';
  try {
    const res = await apiCall('prepareInvoiceMonth', {});
    if (res.success) {
      toast(`Invoice Month "${res.month}" set for ${res.updated} client(s).`, 'ok');
      await loadClients();
    } else {
      toast(res.error || 'Something went wrong.', 'error');
    }
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.textContent = originalText;
    btn.disabled = false;
  }
}

// ⭐ Temporary button — Invoice Month column ko poori sheet mein clear
// kar deta hai (testing/reset ke liye).
async function handleClearMonthClick() {
  if (!confirm('Clear the Invoice Month for all clients? (This is only for testing/reset purposes)')) return;
  const btn = document.getElementById('clearMonthBtn');
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Clearing…';
  try {
    const res = await apiCall('clearInvoiceMonth', {});
    if (res.success) {
      toast(`Invoice Month cleared for ${res.updated} client(s).`, 'ok');
      await loadClients();
    } else {
      toast(res.error || 'Something went wrong.', 'error');
    }
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.textContent = originalText;
    btn.disabled = false;
  }
}

// ⭐ "Reset for Next Month" — 6 columns clear karta hai (Practice Collection
// Month, Practice Monthly Collection ($), No. of Verified Benefits, Stripe
// Customer ID, Payment Method ID, Invoice ID) taake agla billing cycle
// fresh shuru ho sake. Invoice Status jaan-boojh kar touch nahi hota.
async function handleResetNextMonthClick() {
  if (!confirm('Reset for next month?\n\nThese columns will be fully cleared (for all clients):\n- Practice Collection Month\n- Practice Monthly Collection ($)\n- No. of Verified Benefits\n- Stripe Customer ID\n- Payment Method ID\n- Invoice ID\n- Remarks\n\nInvoice Status will be smart-reset:\n- "Manual Invoice Sent - Check Sheet" → back to "Manual Invoice - Check Sheet"\n- "Do Not Invoice" → left untouched\n- All other statuses → cleared to blank/Pending\n\nThis action cannot be undone.')) return;
  const btn = document.getElementById('resetNextMonthBtn');
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Resetting…';
  try {
    const res = await apiCall('resetForNextMonth', {});
    if (res.success) {
      toast(`Reset done for ${res.updated} client(s).`, 'ok');
      await loadClients();
    } else {
      toast(res.error || 'Something went wrong.', 'error');
    }
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.textContent = originalText;
    btn.disabled = false;
  }
}

async function handleLoadPaymentMethodsClick() {
  const btn = document.getElementById('loadPaymentMethodsBtn');
  const ok = await runBulkAction(btn, 'loadPaymentMethods', 'Payment methods loaded.');
  if (ok) {
    STATE.paymentMethodsLoaded = true;
    const chargeBtn = document.getElementById('chargeCustomersBtn');
    chargeBtn.disabled = false;
    chargeBtn.title = '';
  }
}

async function handleChargeCustomersClick() {
  if (!STATE.paymentMethodsLoaded) return; // extra safety, button already disabled
  const btn = document.getElementById('chargeCustomersBtn');
  await runBulkAction(btn, 'chargeCustomersBulk', 'Charging completed.');
}

function exportRowsToExcel(rows, dialogLabel) {
  if (typeof XLSX === 'undefined') {
    toast('Excel export library failed to load.', 'error');
    return;
  }
  const data = rows.map(c => ({
    'Client Name': c['Client Name'] || '',
    'Email': c['Email'] || '',
    'Payment Method': c['Payment Method'] || '',
    'Total Invoice ($)': c['Total Invoice ($)'] || '',
    'Invoice Status': c['Invoice Status'] || ''
  }));
  const ws = XLSX.utils.json_to_sheet(data);
  const wb = XLSX.utils.book_new();
  const sheetName = (dialogLabel || 'Sheet1').substring(0, 28);
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  const fileName = 'billing-' + (dialogLabel || 'export').toLowerCase().replace(/\s+/g, '-') + '-' + new Date().toISOString().slice(0, 10) + '.xlsx';
  XLSX.writeFile(wb, fileName);
}

function exportChargeStageToExcel() {
  if (typeof XLSX === 'undefined') {
    toast('Excel export library failed to load.', 'error');
    return;
  }
  if (!CHARGE_STAGE_LAST_ROWS.length) {
    toast('Nothing to export — no rows match the current filter.', 'error');
    return;
  }
  const data = CHARGE_STAGE_LAST_ROWS.map(c => ({
    'Client Name': c['Client Name'] || '',
    'Email': c['Email'] || '',
    'Payment Method': c['Payment Method'] || '',
    'Stripe Customer ID': c['Stripe Customer ID'] || '',
    'Payment Method ID': c['Payment Method ID'] || '',
    'Invoice ID': c['Invoice ID'] || '',
    'Total Invoice ($)': c['Total Invoice ($)'] || '',
    'Invoice Status': c['Invoice Status'] || '',
    'Remarks': c['Remarks'] || ''
  }));
  const ws = XLSX.utils.json_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Charge Customers');
  const fileName = 'charge-customers-' + new Date().toISOString().slice(0, 10) + '.xlsx';
  XLSX.writeFile(wb, fileName);
}

// ============================================================
// ADD / EDIT MODAL
// ============================================================
function bindUI() {
  document.getElementById('signOutBtn').addEventListener('click', signOut);
  document.getElementById('addPracticeBtn').addEventListener('click', () => openAddModal());
  document.getElementById('modalOverlay').addEventListener('click', e => {
    if (e.target.id === 'modalOverlay') closeModal();
  });

  document.getElementById('sendInvoicesBtn').addEventListener('click', handleSendInvoicesClick);
  const prepareSheetBtn = document.getElementById('prepareSheetBtn');
  if (prepareSheetBtn) prepareSheetBtn.addEventListener('click', handlePrepareSheetClick);
  const clearMonthBtn = document.getElementById('clearMonthBtn');
  if (clearMonthBtn) clearMonthBtn.addEventListener('click', handleClearMonthClick);
  const resetNextMonthBtn = document.getElementById('resetNextMonthBtn');
  if (resetNextMonthBtn) resetNextMonthBtn.addEventListener('click', handleResetNextMonthClick);
  document.getElementById('openChargeStageBtn').addEventListener('click', openChargeStage);
  document.getElementById('backToDashboardBtn').addEventListener('click', backToDashboard);
  document.getElementById('loadPaymentMethodsBtn').addEventListener('click', handleLoadPaymentMethodsClick);
  document.getElementById('chargeCustomersBtn').addEventListener('click', handleChargeCustomersClick);
  document.getElementById('chargeStageExcelBtn').addEventListener('click', exportChargeStageToExcel);

  const backFromTerminatedBtn = document.getElementById('backFromTerminatedBtn');
  if (backFromTerminatedBtn) backFromTerminatedBtn.addEventListener('click', backFromTerminatedPage);
  const terminatedExcelBtn = document.getElementById('terminatedExcelBtn');
  if (terminatedExcelBtn) terminatedExcelBtn.addEventListener('click', exportTerminatedToExcel);

  const searchInput = document.getElementById('practiceSearch');
  if (searchInput) {
    searchInput.addEventListener('input', e => {
      STATE.searchTerm = e.target.value;
      renderTable();
    });
  }

  const statusDialogCloseBtn = document.getElementById('statusDialogCloseBtn');
  if (statusDialogCloseBtn) statusDialogCloseBtn.addEventListener('click', closeStatusDialog);
  const statusDialogOverlay = document.getElementById('statusDialogOverlay');
  if (statusDialogOverlay) {
    statusDialogOverlay.addEventListener('click', e => {
      if (e.target.id === 'statusDialogOverlay') closeStatusDialog();
    });
  }

  // ⭐ TERMINATION dialog bindings
  const terminateDialogCancelBtn = document.getElementById('terminateDialogCancelBtn');
  if (terminateDialogCancelBtn) terminateDialogCancelBtn.addEventListener('click', closeTerminateDialog);
  const terminateDialogConfirmBtn = document.getElementById('terminateDialogConfirmBtn');
  if (terminateDialogConfirmBtn) terminateDialogConfirmBtn.addEventListener('click', confirmTerminate);
  const terminateDialogOverlay = document.getElementById('terminateDialogOverlay');
  if (terminateDialogOverlay) {
    terminateDialogOverlay.addEventListener('click', e => {
      if (e.target.id === 'terminateDialogOverlay') closeTerminateDialog();
    });
  }
}

function openAddModal() {
  const fields = REQUIRED_FIELDS.concat(OPTIONAL_ADD_FIELDS);
  renderModal({
    title: 'Add Practice',
    sub: 'Add a new client. SR# will be generated automatically.',
    fields,
    values: {},
    onSubmit: async (values) => {
      const res = await apiCall('addPractice', { data: values });
      if (res.success) {
        closeModal();
        toast('Practice added.', 'ok');
        loadClients();
      } else {
        setModalMsg(res.error, 'error');
      }
    }
  });
}

function openEditModal(row) {
  const client = STATE.clients.find(c => c.row === row);
  if (!client) return;
  const fields = REQUIRED_FIELDS.concat(OPTIONAL_ADD_FIELDS).concat(EDIT_ONLY_FIELDS);
  renderModal({
    title: 'Edit — ' + client['Client Name'],
    sub: client['Email'] || '',
    fields,
    values: client,
    rowActions: { row, name: client['Client Name'] },
    lockedFields: true,
    onSubmit: async (values) => {
      const res = await apiCall('updateClient', { row, data: values });
      if (res.success) {
        closeModal();
        toast('Update saved.', 'ok');
        loadClients();
      } else {
        setModalMsg(res.error, 'error');
      }
    }
  });
}

function formatFieldValue(key, val) {
  if (val == null || val === '') return '';
  if (key === 'Medical Billing Rate (%)') {
    const s = String(val).trim();
    if (s.includes('%')) return s;
    const num = parseFloat(s);
    if (!isNaN(num)) {
      // Rate in the sheet may be a fraction (0.03) or a plain number (3) —
      // fractions under 1 get converted to a percentage so it displays correctly.
      const pct = (num > 0 && num < 1) ? num * 100 : num;
      return (Math.round(pct * 100) / 100) + '%';
    }
  }
  return val;
}

// These fields stay editable even in "lockedFields" mode.
// Billing Amount ($) / Benefits Amount ($) are NOT here anymore — they're now
// locked + live-calculated (see LIVE_CALC_FIELDS / recalcLiveAmounts below).
const ALWAYS_EDITABLE_FIELDS = ['Payment Method', 'Practice Monthly Collection ($)', 'No. of Verified Benefits'];

// These locked fields get their displayed value recalculated in real time
// (Billing Amount = Collection x Rate, Benefits Amount = Benefits Rate x Benefits Count)
// as the user edits Practice Monthly Collection ($) / No. of Verified Benefits.
const LIVE_CALC_FIELDS = ['Billing Amount ($)', 'Benefits Amount ($)'];

function renderModal({ title, sub, fields, values, onSubmit, rowActions, lockedFields }) {
  document.getElementById('modalTitle').textContent = title;
  document.getElementById('modalSub').textContent = sub;

  let html = '<div class="field-grid">';
  fields.forEach(f => {
    const val = values[f.key] != null ? values[f.key] : '';
    const isRequired = REQUIRED_FIELDS.some(rf => rf.key === f.key);
    const fullWidth = f.key === 'Special Instructions';
    const isLocked = lockedFields && !ALWAYS_EDITABLE_FIELDS.includes(f.key);
    html += `<div class="field ${fullWidth ? 'full' : ''}">
      <label>${escapeHtml(label(f.key))} ${isRequired ? '<span class="req">*</span>' : ''}</label>`;
    if (isLocked) {
      const display = f.type === 'select'
        ? (val || '—')
        : (formatFieldValue(f.key, val) || '—');
      const liveAttr = LIVE_CALC_FIELDS.includes(f.key) ? ` data-live="${escapeAttr(f.key)}"` : '';
      html += `<div class="field-readonly"${liveAttr}>${escapeHtml(display)}</div>`;
    } else if (f.type === 'select') {
      html += `<select data-field="${escapeAttr(f.key)}">`;
      html += `<option value="">—</option>`;
      f.options.forEach(o => html += `<option value="${escapeAttr(o)}" ${val === o ? 'selected' : ''}>${escapeHtml(o)}</option>`);
      html += `</select>`;
    } else {
      html += `<input data-field="${escapeAttr(f.key)}" type="${f.type === 'number' ? 'number' : (f.type === 'email' ? 'email' : 'text')}" value="${escapeAttr(val)}" placeholder="${f.hint ? escapeAttr(f.hint) : ''}">`;
    }
    html += `</div>`;
  });
  html += '</div>';

  if (lockedFields) {
    html += `<p class="lock-note">🔒 Rate/fee details are set when the practice is added and can't be edited here. Payment Method, Practice Monthly Collection, No. of Verified Benefits, status (from the table) and services (below) can be changed — Billing/Benefits Amount recalculate automatically.</p>`;
  }

  html += '<div class="section-label">Additional Services</div>';
  html += '<div id="serviceBlocks">';
  modalServiceSlots = getServiceNumbers_(values); // service numbers this client already has
  modalServiceSlots.forEach(n => {
    html += serviceBlockHtml(n, {
      name: values['Additional Service ' + n] || '',
      rate: values['Rate ' + n] || '',
      type: values['Type ' + n] || ''
    });
  });
  html += '</div>';
  html += '<button type="button" class="btn btn-ghost btn-small" id="addServiceBtn" onclick="addServiceBlock()">+ Add Service</button>';

  html += '<div class="modal-msg" id="modalMsg"></div>';
  document.getElementById('modalBody').innerHTML = html;

  // Live-recalculate Billing Amount ($) / Benefits Amount ($) display whenever
  // Practice Monthly Collection ($) or No. of Verified Benefits changes.
  // Medical Billing Rate (%) / Benefits Verification Rate ($) are locked here,
  // so their fixed value is read once from `values` (the original client data).
  const billingDisplay = document.querySelector('[data-live="Billing Amount ($)"]');
  const benefitsDisplay = document.querySelector('[data-live="Benefits Amount ($)"]');
  if (billingDisplay || benefitsDisplay) {
    const rate = parseRatePercent_(values['Medical Billing Rate (%)']);
    const benefitsRate = parseNum_(values['Benefits Verification Rate ($)']);

    const recalcLiveAmounts = () => {
      if (billingDisplay) {
        const collectionEl = document.querySelector('[data-field="Practice Monthly Collection ($)"]');
        const collection = parseNum_(collectionEl ? collectionEl.value : values['Practice Monthly Collection ($)']);
        billingDisplay.textContent = (collection * rate).toFixed(2);
      }
      if (benefitsDisplay) {
        const benefitsCountEl = document.querySelector('[data-field="No. of Verified Benefits"]');
        const benefitsCount = parseNum_(benefitsCountEl ? benefitsCountEl.value : values['No. of Verified Benefits']);
        benefitsDisplay.textContent = (benefitsRate * benefitsCount).toFixed(2);
      }
    };

    document.getElementById('modalBody').addEventListener('input', (e) => {
      const f = e.target.dataset.field;
      if (f === 'Practice Monthly Collection ($)' || f === 'No. of Verified Benefits') {
        recalcLiveAmounts();
      }
    });

    recalcLiveAmounts(); // initial paint, so it's correct even before any typing
  }

  const footer = document.getElementById('modalFooter');
  let footerHtml = '';
  // NOTE: Delete aur Send Invoice buttons yahan se hata diye gaye hain.
  // Send Invoice ab ek alag bulk function se hoga (jo baad mein end pe
  // add hogi aur sab clients ko ek sath process karegi) — is modal se
  // ab sirf plain edit/save hota hai.
  footerHtml += `
    <button class="btn btn-ghost" id="modalCancelBtn">Cancel</button>
    <button class="btn btn-primary" id="modalSaveBtn">Save</button>
  `;
  footer.innerHTML = footerHtml;
  document.getElementById('modalCancelBtn').addEventListener('click', closeModal);
  document.getElementById('modalSaveBtn').addEventListener('click', async () => {
    const inputs = document.querySelectorAll('[data-field]');
    const values = {};
    inputs.forEach(el => values[el.dataset.field] = el.value.trim());

    // Medical Billing Rate (%) should always be stored as a percentage —
    // if the user typed a plain number (e.g. "6"), add the % sign automatically.
    const rateKey = 'Medical Billing Rate (%)';
    if (values[rateKey]) {
      let rateVal = values[rateKey].trim();
      if (!rateVal.includes('%')) {
        const num = parseFloat(rateVal);
        if (!isNaN(num)) {
          const pct = (num > 0 && num < 1) ? num * 100 : num;
          rateVal = (Math.round(pct * 100) / 100) + '%';
        }
      }
      values[rateKey] = rateVal;
    }
    // Billing Amount ($) / Benefits Amount ($) / Total Invoice ($) are not
    // sent from here — the backend (restoreRowFormulas_ in WebApp.gs) sets
    // live formulas for all three right after this save, using the
    // sheet's actual column layout (more reliable than guessing it here).

    const saveBtn = document.getElementById('modalSaveBtn');
    const cancelBtn = document.getElementById('modalCancelBtn');
    saveBtn.disabled = true;
    cancelBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    setModalMsg('Saving, please wait…', 'saving');

    try {
      await onSubmit(values);
    } finally {
      // Agar save fail hua to modal khula rehta hai (onSubmit apna error
      // message already dikha chuka hoga) — is case mein button wapis
      // normal/enabled kar dein taake dobara try kiya ja sake. Agar save
      // kamyab hua to onSubmit modal already band kar chuka hoga, is liye
      // ye check us waqt kuch nahi karega.
      if (document.getElementById('modalOverlay').classList.contains('open')) {
        saveBtn.disabled = false;
        cancelBtn.disabled = false;
        saveBtn.textContent = 'Save';
      }
    }
  });

  document.getElementById('modalOverlay').classList.add('open');
}

// Tracks the service numbers this client currently has while the modal is open
// (e.g. [1,2]) — clicking "+ Add Service" pushes a new number onto it.
let modalServiceSlots = [];

function serviceBlockHtml(n, vals) {
  const typeVal = String(vals.type || '').trim().toLowerCase();
  return `
  <div class="service-block" id="serviceBlock-${n}">
    <div class="service-block-head">
      <span>Service ${n}</span>
      <button type="button" class="remove-service-btn" onclick="removeServiceBlock(${n})">✕ Remove</button>
    </div>
    <div class="field-grid">
      <div class="field full">
        <label>Service Name</label>
        <input data-field="Additional Service ${n}" type="text" value="${escapeAttr(vals.name)}" placeholder="e.g. Credentialing Fee">
      </div>
      <div class="field">
        <label>Rate</label>
        <input data-field="Rate ${n}" type="number" value="${escapeAttr(vals.rate)}" placeholder="e.g. 50">
      </div>
      <div class="field">
        <label>Type</label>
        <select data-field="Type ${n}">
          <option value="">—</option>
          <option value="fixed" ${typeVal === 'fixed' ? 'selected' : ''}>Fixed ($)</option>
          <option value="percent" ${typeVal === 'percent' ? 'selected' : ''}>Percent (% of invoice)</option>
        </select>
      </div>
    </div>
  </div>`;
}

function addServiceBlock() {
  const nextN = (modalServiceSlots.length ? Math.max(...modalServiceSlots) : 0) + 1;
  modalServiceSlots.push(nextN);
  const container = document.getElementById('serviceBlocks');
  container.insertAdjacentHTML('beforeend', serviceBlockHtml(nextN, { name: '', rate: '', type: '' }));
  const nameInput = document.querySelector(`#serviceBlock-${nextN} input[data-field^="Additional Service"]`);
  if (nameInput) nameInput.focus();
}

function removeServiceBlock(n) {
  const block = document.getElementById('serviceBlock-' + n);
  if (block) block.remove();
  modalServiceSlots = modalServiceSlots.filter(x => x !== n);
  // The backend needs to be told this service was removed, otherwise the old
  // value would stay in the sheet — a hidden input takes care of that.
  const wrap = document.getElementById('modalBody');
  const marker = document.createElement('input');
  marker.type = 'hidden';
  marker.dataset.field = 'Additional Service ' + n;
  marker.value = '';
  wrap.appendChild(marker);
  const rateMarker = marker.cloneNode();
  rateMarker.dataset.field = 'Rate ' + n;
  wrap.appendChild(rateMarker);
  const typeMarker = marker.cloneNode();
  typeMarker.dataset.field = 'Type ' + n;
  wrap.appendChild(typeMarker);
}

function closeModal() {
  document.getElementById('modalOverlay').classList.remove('open');
}

function setModalMsg(msg, type) {
  const el = document.getElementById('modalMsg');
  el.textContent = msg;
  el.className = 'modal-msg ' + type;
}

// ============================================================
// ⭐ TERMINATION
// ============================================================
// Row jiske liye Terminate dialog abhi khula hai
let TERMINATE_TARGET_ROW = null;

function openTerminateDialog(row) {
  const client = STATE.clients.find(c => c.row === row);
  if (!client) return;
  TERMINATE_TARGET_ROW = row;
  document.getElementById('terminateDialogSub').textContent = (client['Client Name'] || '') + ' — ' + (client['Email'] || '');
  const dateInput = document.getElementById('terminateDateInput');
  if (dateInput) dateInput.value = '';
  setTerminateMsg('', '');
  document.getElementById('terminateDialogOverlay').classList.add('open');
}

function closeTerminateDialog() {
  document.getElementById('terminateDialogOverlay').classList.remove('open');
  TERMINATE_TARGET_ROW = null;
}

function setTerminateMsg(msg, type) {
  const el = document.getElementById('terminateDialogMsg');
  if (!el) return;
  el.textContent = msg || '';
  el.className = 'modal-msg ' + (type || '');
}

async function confirmTerminate() {
  const dateVal = document.getElementById('terminateDateInput').value;
  if (!dateVal) { setTerminateMsg('Please select a termination date.', 'error'); return; }
  if (!TERMINATE_TARGET_ROW) return;

  const confirmBtn = document.getElementById('terminateDialogConfirmBtn');
  const cancelBtn = document.getElementById('terminateDialogCancelBtn');
  confirmBtn.disabled = true;
  cancelBtn.disabled = true;
  confirmBtn.textContent = 'Saving…';
  setTerminateMsg('Saving…', 'saving');

  const res = await apiCall('markTerminated', { row: TERMINATE_TARGET_ROW, terminationDate: dateVal });

  confirmBtn.disabled = false;
  cancelBtn.disabled = false;
  confirmBtn.textContent = 'Confirm Termination';

  if (res.success) {
    toast('Client marked as Terminated.', 'ok');
    closeTerminateDialog();
    loadClients();
  } else {
    setTerminateMsg(res.error, 'error');
  }
}

async function reactivateClient(row, name) {
  if (!confirm(`Set "${name}" back to Active? Invoicing will resume normally.`)) return;
  const res = await apiCall('reactivateClient', { row });
  if (res.success) {
    toast('Client reactivated.', 'ok');
    loadClients();
    const terminatedPageEl = document.getElementById('terminatedPage');
    if (terminatedPageEl && terminatedPageEl.style.display !== 'none') {
      loadTerminatedClients();
    }
  } else {
    toast(res.error, 'error');
  }
}

// ============================================================
// ROW ACTIONS
// ============================================================
async function deleteClient(row, name) {
  if (!confirm(`Delete "${name}"? This will remove the row from the sheet.`)) return false;
  const res = await apiCall('deleteClient', { row });
  if (res.success) {
    toast('Deleted.', 'ok');
    loadClients();
    return true;
  } else {
    toast(res.error, 'error');
    return false;
  }
}

async function sendInvoice(row, name) {
  if (!confirm(`Send an invoice to "${name}" (via Stripe)?`)) return false;
  toast('Sending invoice…');
  const res = await apiCall('sendInvoiceForClient', { row });
  if (res.success) {
    toast('Invoice processed.', 'ok');
    loadClients();
    return true;
  } else {
    toast(res.error, 'error');
    return false;
  }
}

// ============================================================
// UTIL
// ============================================================
function toast(msg, type) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast show' + (type ? ' ' + type : '');
  clearTimeout(window._toastTimer);
  window._toastTimer = setTimeout(() => el.classList.remove('show'), 3500);
}

function escapeHtml(str) {
  return String(str == null ? '' : str).replace(/[&<>"']/g, m => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[m]));
}
function escapeAttr(str) { return escapeHtml(str).replace(/`/g, '&#96;'); }
