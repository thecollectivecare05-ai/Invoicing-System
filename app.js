// ============================================================
// STATE
// ============================================================
let STATE = {
  email: sessionStorage.getItem('email') || null,
  code: sessionStorage.getItem('code') || null,
  role: sessionStorage.getItem('role') || null,
  clients: []
};

const REQUIRED_FIELDS = [
  { key: 'Client Name', type: 'text' },
  { key: 'Email', type: 'email' },
  { key: 'Medical Billing Rate (%)', type: 'text', hint: 'e.g. 6% ya 6' },
  { key: 'Monthly Minimum (Billing)', type: 'number' },
  { key: 'Benefits Verification Rate ($)', type: 'number' }
];

const OPTIONAL_ADD_FIELDS = [
  { key: 'Payment Method', type: 'select', options: ['Credit/Debit Card', 'ACH', 'ACH and Credit/Debit'] },
  { key: 'Special Instructions', type: 'text' }
];

const LIST_COLUMNS = [
  'Practice Collection Month',
  'Practice Monthly Collection ($)',
  'No. of Verified Benefits',
  'Billing Amount ($)',
  'Benefits Amount ($)',
  'Total Invoice ($)',
  'Payment Method',
  'Additional Service 1', 'Rate 1', 'Type 1',
  'Additional Service 2', 'Rate 2', 'Type 2'
];

// ============================================================
// LOGIN (Email + Access Code — "Users" sheet tab se check hota hai)
// ============================================================
window.addEventListener('DOMContentLoaded', () => {
  if (!CONFIG.WEB_APP_URL || CONFIG.WEB_APP_URL.startsWith('PASTE_')) {
    showGateError('config.js mein WEB_APP_URL set nahi hai.');
    return;
  }

  document.getElementById('loginForm').addEventListener('submit', handleLoginSubmit);

  // Agar pehle se session mein login hai to seedha dashboard try karein
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
      showGateError(res.error || 'Login nahi hua.');
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
  STATE = { email: null, code: null, role: null, clients: [] };
  document.getElementById('mainApp').style.display = 'none';
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

  document.getElementById('addPracticeBtn').style.display = STATE.role === 'editor' ? 'inline-flex' : 'none';

  loadClients();
}

// ============================================================
// API HELPER
// ============================================================
async function apiCall(action, extra) {
  const payload = Object.assign({ action, email: STATE.email, code: STATE.code }, extra || {});
  const resp = await fetch(CONFIG.WEB_APP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // avoids CORS preflight
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
  wrap.innerHTML = '<div class="empty-state"><div class="mark">Loading…</div></div>';

  const res = await apiCall('getClients', {});
  if (!res.success) {
    wrap.innerHTML = `<div class="empty-state"><div class="mark">Kuch ghalat ho gaya</div>${escapeHtml(res.error)}</div>`;
    return;
  }
  STATE.clients = res.data;
  document.getElementById('clientCount').textContent = res.data.length;
  renderTable();
}

function renderTable() {
  const wrap = document.getElementById('tableWrap');
  if (STATE.clients.length === 0) {
    wrap.innerHTML = `<div class="empty-state"><div class="mark">Abhi koi practice add nahi hui</div>${STATE.role === 'editor' ? '"Add Practice" button se shuru karein.' : ''}</div>`;
    return;
  }

  const isEditor = STATE.role === 'editor';
  let html = '<table><thead><tr>';
  html += '<th>SR#</th><th>Client</th>';
  LIST_COLUMNS.forEach(c => html += `<th>${escapeHtml(c)}</th>`);
  html += '<th>Invoice Status</th>';
  if (isEditor) html += '<th>Actions</th>';
  html += '</tr></thead><tbody>';

  STATE.clients.forEach(c => {
    html += '<tr>';
    html += `<td class="sr-cell">${escapeHtml(c['SR#'] || '')}</td>`;
    html += `<td><span class="client-name">${escapeHtml(c['Client Name'] || '')}</span><span class="client-email">${escapeHtml(c['Email'] || '')}</span></td>`;
    LIST_COLUMNS.forEach(col => {
      const isMoney = /\(\$\)/.test(col) || col === 'Rate 1' || col === 'Rate 2';
      html += `<td class="${isMoney ? 'money-cell' : ''}">${escapeHtml(c[col] != null ? c[col] : '')}</td>`;
    });
    html += `<td>${statusStamp(c['Invoice Status'])}</td>`;
    if (isEditor) {
      html += `<td class="row-actions">
        <button class="btn btn-ghost btn-small" onclick="openEditModal(${c.row})">Edit</button>
        <button class="btn btn-teal btn-small" onclick="sendInvoice(${c.row}, '${escapeAttr(c['Client Name'])}')">Send Invoice</button>
        <button class="btn btn-danger btn-small" onclick="deleteClient(${c.row}, '${escapeAttr(c['Client Name'])}')">Delete</button>
      </td>`;
    }
    html += '</tr>';
  });

  html += '</tbody></table>';
  wrap.innerHTML = html;
}

function statusStamp(status) {
  const s = String(status || 'Pending').trim();
  const cls = s.toLowerCase().replace(/\s+/g, '-');
  return `<span class="stamp ${cls}">${escapeHtml(s)}</span>`;
}

// ============================================================
// ADD PRACTICE MODAL
// ============================================================
function bindUI() {
  document.getElementById('signOutBtn').addEventListener('click', signOut);
  document.getElementById('addPracticeBtn').addEventListener('click', () => openAddModal());
  document.getElementById('modalOverlay').addEventListener('click', e => {
    if (e.target.id === 'modalOverlay') closeModal();
  });
}

function openAddModal() {
  const fields = REQUIRED_FIELDS.concat(OPTIONAL_ADD_FIELDS);
  renderModal({
    title: 'Add Practice',
    sub: 'Naya client add karein. SR# khud-ba-khud generate hoga.',
    fields,
    values: {},
    onSubmit: async (values) => {
      const res = await apiCall('addPractice', { data: values });
      if (res.success) {
        closeModal();
        toast('Practice add ho gayi.', 'ok');
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
  const fields = REQUIRED_FIELDS.concat(OPTIONAL_ADD_FIELDS).concat([
    { key: 'Practice Collection Month', type: 'text' },
    { key: 'Practice Monthly Collection ($)', type: 'number' },
    { key: 'No. of Verified Benefits', type: 'number' },
    { key: 'Invoice Status', type: 'select', options: ['Need to Send Invoice', 'Sent', 'Paid', 'Failed'] }
  ]);
  renderModal({
    title: 'Edit — ' + client['Client Name'],
    sub: 'SR# ' + client['SR#'],
    fields,
    values: client,
    onSubmit: async (values) => {
      const res = await apiCall('updateClient', { row, data: values });
      if (res.success) {
        closeModal();
        toast('Update ho gaya.', 'ok');
        loadClients();
      } else {
        setModalMsg(res.error, 'error');
      }
    }
  });
}

function renderModal({ title, sub, fields, values, onSubmit }) {
  document.getElementById('modalTitle').textContent = title;
  document.getElementById('modalSub').textContent = sub;

  let html = '<div class="field-grid">';
  fields.forEach(f => {
    const val = values[f.key] != null ? values[f.key] : '';
    const isRequired = REQUIRED_FIELDS.some(rf => rf.key === f.key);
    const fullWidth = f.key === 'Special Instructions';
    html += `<div class="field ${fullWidth ? 'full' : ''}">
      <label>${escapeHtml(f.key)} ${isRequired ? '<span class="req">*</span>' : ''}</label>`;
    if (f.type === 'select') {
      html += `<select data-field="${escapeAttr(f.key)}">`;
      html += `<option value="">—</option>`;
      f.options.forEach(o => html += `<option value="${escapeAttr(o)}" ${val === o ? 'selected' : ''}>${escapeHtml(o)}</option>`);
      html += `</select>`;
    } else {
      html += `<input data-field="${escapeAttr(f.key)}" type="${f.type === 'number' ? 'number' : (f.type === 'email' ? 'email' : 'text')}" value="${escapeAttr(val)}" placeholder="${f.hint ? escapeAttr(f.hint) : ''}">`;
    }
    html += `</div>`;
  });
  html += '</div><div class="modal-msg" id="modalMsg"></div>';
  document.getElementById('modalBody').innerHTML = html;

  const footer = document.getElementById('modalFooter');
  footer.innerHTML = `
    <button class="btn btn-ghost" id="modalCancelBtn">Cancel</button>
    <button class="btn btn-primary" id="modalSaveBtn">Save</button>
  `;
  document.getElementById('modalCancelBtn').addEventListener('click', closeModal);
  document.getElementById('modalSaveBtn').addEventListener('click', () => {
    const inputs = document.querySelectorAll('[data-field]');
    const values = {};
    inputs.forEach(el => values[el.dataset.field] = el.value.trim());
    onSubmit(values);
  });

  document.getElementById('modalOverlay').classList.add('open');
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
// ROW ACTIONS
// ============================================================
async function deleteClient(row, name) {
  if (!confirm(`"${name}" ko delete karna hai? Ye sheet se row hata dega.`)) return;
  const res = await apiCall('deleteClient', { row });
  if (res.success) {
    toast('Delete ho gaya.', 'ok');
    loadClients();
  } else {
    toast(res.error, 'error');
  }
}

async function sendInvoice(row, name) {
  if (!confirm(`"${name}" ko invoice send karna hai (Stripe ke through)?`)) return;
  toast('Invoice bheja ja raha hai…');
  const res = await apiCall('sendInvoiceForClient', { row });
  if (res.success) {
    toast('Invoice process ho gaya.', 'ok');
    loadClients();
  } else {
    toast(res.error, 'error');
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
