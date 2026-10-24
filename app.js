// ==========================================
// STATE MANAGEMENT & DOM ELEMENTS
// ==========================================
const MAX_CAPACITY = 25;
const STORAGE_KEY = 'fitpulse.attendance.v1';
const RING_CIRCUMFERENCE = 314;

// Source of truth for the attendance log.
// Each record: { id, name, date, timeIn, timeOut }
let records = [];
let nextRecordId = 1;

// Admin PIN for destructive actions
const ADMIN_PIN = '1234';
let pendingClearAction = null; // 'clearLogs' | 'clearHistory'

// Dashboard-only view cutoff. Records with an id at or below this value stay
// in the central store (and in History) but are hidden from the dashboard log.
let dashboardClearedThroughId = 0;

// Number of members currently inside the facility
let activeCount = 0;

let toastTimeout = null;

// Pending checkout state, populated while the confirmation modal is open
let pendingCheckoutId = null;
let pendingCheckoutName = '';

// Only one modal may be open at a time
let activeModal = null;

// Active top-level view: 'dashboard' or 'history'
let currentView = 'dashboard';

// History view loading/rendering state
let historyHasLoaded = false;
let historyRenderTimer = null;
let historySearchTimer = null;

// Element focused before the current modal opened (restored on close)
let lastFocusedElement = null;

// Per-modal cleanup run when that modal closes (resets form state, etc.)
const modalCleanupHandlers = new Map();

// DOM Elements
const checkinForm = document.getElementById('checkin-form');
const memberInput = document.getElementById('member-input');
const memberInputError = document.getElementById('member-input-error');
const attendanceList = document.getElementById('attendance-list');
const searchInput = document.getElementById('search-input');
const noResults = document.getElementById('no-results');

const activeCountEl = document.getElementById('active-count');
const currentCapacityEl = document.getElementById('current-capacity');
const maxCapacityEl = document.getElementById('max-capacity');
const capacityStateEl = document.getElementById('capacity-state');
const occupancyCard = document.querySelector('.occupancy-card');
const occupancyRing = document.getElementById('occupancy-ring');

const toast = document.getElementById('feedback-toast');
const toastMessage = document.getElementById('toast-message');
const toastIconSlot = document.getElementById('toast-icon-slot');
const liveRegion = document.getElementById('live-region');

// Modal DOM Elements
const checkoutModal = document.getElementById('checkout-modal');
const modalMemberName = document.getElementById('modal-member-name');
const btnModalCancel = document.getElementById('btn-modal-cancel');
const btnModalConfirm = document.getElementById('btn-modal-confirm');

// Clear-logs modal DOM Elements
const clearLogsModal = document.getElementById('clear-logs-modal');
const clearConfirmInput = document.getElementById('clear-confirm-input');
const btnClearLogs = document.getElementById('btn-clear-logs');
const btnClearCancel = document.getElementById('btn-clear-cancel');
const btnClearConfirm = document.getElementById('btn-clear-confirm');

// Background elements, made inert while the modal is open
const navbar = document.querySelector('.navbar');
const dashboardContainer = document.querySelector('.dashboard-container');

// Navigation / view elements
const navLinks = document.querySelectorAll('.nav-link');
const views = {
  dashboard: document.getElementById('view-dashboard'),
  history: document.getElementById('view-history')
};

// History view elements
const historyDateInput = document.getElementById('history-date');
const historySearchInput = document.getElementById('history-search');
const historyContent = document.getElementById('history-content');
const historyLoading = document.getElementById('history-loading');
const historyEmpty = document.getElementById('history-empty');
const historyEmptyTitle = document.getElementById('history-empty-title');
const historyEmptyText = document.getElementById('history-empty-text');
const historyResultSummary = document.getElementById('history-result-summary');
const btnHistoryReset = document.getElementById('btn-history-reset');
const btnHistoryEmpty = document.getElementById('btn-history-empty');
const btnClearHistory = document.getElementById('btn-clear-history');

// Clear History modal elements
const clearHistoryModal = document.getElementById('clear-history-modal');
const btnClearHistoryCancel = document.getElementById('btn-clear-history-cancel');
const btnClearHistoryConfirm = document.getElementById('btn-clear-history-confirm');

// Admin PIN modal elements
const adminPinModal = document.getElementById('admin-pin-modal');
const adminPinInput = document.getElementById('admin-pin-input');
const btnAdminPinCancel = document.getElementById('btn-admin-pin-cancel');
const btnAdminPinConfirm = document.getElementById('btn-admin-pin-confirm');

// ==========================================
// UTILITY FUNCTIONS
// ==========================================

function getCurrentTimeFormatted() {
  const now = new Date();
  return now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// Uses the LOCAL calendar date. toISOString() would report the UTC day, which
// rolls over hours before local midnight and logs members on the wrong date.
function getCurrentDateFormatted() {
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, '0');
  const day = String(today.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// Case- and whitespace-insensitive key, used for duplicate detection
function normalizeName(name) {
  return String(name).trim().replace(/\s+/g, ' ').toLowerCase();
}

// Role logic removed - all entries treated as members uniformly

// A session is active only while it has not checked out and its id is above the
// last dashboard-clear cutoff. Clearing the dashboard logically ends those
// sessions for the dashboard/occupancy views without deleting their History
// records.
function isRecordActive(record) {
  return !record.timeOut && record.id > dashboardClearedThroughId;
}

// True when the given member already has an open (not checked out) session
function isMemberActive(name) {
  const key = normalizeName(name);
  return records.some(r => isRecordActive(r) && normalizeName(r.name) === key);
}

// Recompute the active head-count from the records
function syncActiveCount() {
  activeCount = records.filter(isRecordActive).length;
  return activeCount;
}

// Recompute and repaint every live-occupancy element from the central records.
function renderLiveOccupancy() {
  syncActiveCount();
  updateOccupancyUI();
}

function updateOccupancyUI() {
  const isFull = activeCount >= MAX_CAPACITY;

  if (activeCountEl) activeCountEl.textContent = activeCount;
  if (currentCapacityEl) currentCapacityEl.textContent = activeCount;
  if (maxCapacityEl) maxCapacityEl.textContent = MAX_CAPACITY;

  if (occupancyRing) {
    const ratio = Math.min(activeCount / MAX_CAPACITY, 1);
    const offset = RING_CIRCUMFERENCE - ratio * RING_CIRCUMFERENCE;
    occupancyRing.style.strokeDashoffset = offset;
  }

  if (occupancyCard) occupancyCard.classList.toggle('is-full', isFull);

  if (capacityStateEl) {
    capacityStateEl.textContent = isFull ? 'FULL' : 'AVAILABLE';
    capacityStateEl.classList.toggle('is-full', isFull);
  }
}

// ==========================================
// PERSISTENCE
// ==========================================

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      nextRecordId,
      dashboardClearedThroughId,
      records
    }));
  } catch (err) {
    // Storage can be unavailable (private mode, blocked file:// origins).
    console.warn('FitPulse: unable to persist attendance data.', err);
  }
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;

    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.records)) return;

    records = parsed.records
      .filter(r => r && typeof r.name === 'string' && typeof r.date === 'string')
      .map(r => ({
        id: Number(r.id) || 0,
        name: r.name,
        date: r.date,
        timeIn: r.timeIn || '',
        timeOut: r.timeOut || null
      }));

    const highestId = records.reduce((max, r) => Math.max(max, r.id), 0);
    dashboardClearedThroughId = Math.min(
      Math.max(Number(parsed.dashboardClearedThroughId) || 0, 0),
      highestId
    );
    nextRecordId = Math.max(Number(parsed.nextRecordId) || 0, highestId + 1);
  } catch (err) {
    console.warn('FitPulse: unable to restore attendance data.', err);
    records = [];
    nextRecordId = 1;
    dashboardClearedThroughId = 0;
  }
}

// ==========================================
// TOAST NOTIFICATIONS
// ==========================================

function showToast(message, type = 'success') {
  if (!toast || !toastMessage) return;

  // Normalise the requested tone
  let tone = type;
  if (type === 'error' || type === 'warning') {
    tone = type;
  } else if (type === 'success' || type === 'member') {
    tone = type === 'member' ? 'member' : 'success';
  } else if (type === 'admin' || type === 'staff') {
    tone = type;
  } else {
    tone = 'success';
  }

  toastMessage.textContent = message;
  toast.classList.remove('toast-success', 'toast-error', 'toast-warning', 'toast-admin', 'toast-staff', 'toast-member');
  toast.classList.add('toast-' + tone);

  // Swap the Lucide icon to match the toast type
  if (toastIconSlot) {
    toastIconSlot.replaceChildren();
    const icon = document.createElement('i');
    icon.className = 'toast-icon';
    let iconName = 'check-circle-2';
    if (tone === 'error') iconName = 'alert-circle';
    else if (tone === 'warning') iconName = 'alert-triangle';
    else if (tone === 'admin') iconName = 'shield-check';
    else if (tone === 'staff') iconName = 'briefcase';
    else if (tone === 'member') iconName = 'user-check';
    icon.setAttribute('data-lucide', iconName);
    toastIconSlot.appendChild(icon);
  }

  toast.classList.remove('hidden');

  if (window.lucide) lucide.createIcons();

  if (toastTimeout) clearTimeout(toastTimeout);

  const duration = (tone === 'error' || tone === 'warning') ? 5000 : 3500;
  toastTimeout = setTimeout(() => {
    toast.classList.add('hidden');
  }, duration);

  // Announce the outcome to assistive technology
  if (liveRegion) liveRegion.textContent = message;
}

// ==========================================
// ATTENDANCE LOG RENDERING
// ==========================================

// Records visible in the dashboard log only. Clearing the dashboard raises the
// cutoff, but the underlying records stay intact for the History view.
function getDashboardRecords() {
  return records.filter(record => record.id > dashboardClearedThroughId);
}

// Builds a table row using DOM APIs only (never innerHTML) so member names
// are inserted as text and cannot inject markup. Existing CSS classes are
// preserved so the visual styling is unchanged.
function createAttendanceRow(record) {
  const row = document.createElement('tr');
  row.dataset.recordId = String(record.id);
  // Searchable fields only (name + date), so UI chrome such as the
  // "Check Out" button label can never match a query.
  row.dataset.search = `${record.name} ${record.date}`.toLowerCase();

  // Date cell
  const dateTd = document.createElement('td');
  const dateBadge = document.createElement('span');
  dateBadge.className = 'date-badge';
  dateBadge.textContent = record.date;
  dateTd.appendChild(dateBadge);

  // Member name cell
  const nameTd = document.createElement('td');
  nameTd.className = 'member-name';
  nameTd.textContent = record.name;

  // Check-in time cell
  const timeInTd = document.createElement('td');
  const timeInBadge = document.createElement('span');
  timeInBadge.className = 'time-badge in';
  timeInBadge.textContent = record.timeIn;
  timeInTd.appendChild(timeInBadge);

  // Action / check-out cell
  const actionTd = document.createElement('td');
  if (record.timeOut) {
    const timeOutBadge = document.createElement('span');
    timeOutBadge.className = 'time-badge out';
    timeOutBadge.textContent = record.timeOut;
    actionTd.appendChild(timeOutBadge);
  } else {
    const checkoutBtn = document.createElement('button');
    checkoutBtn.type = 'button';
    checkoutBtn.className = 'btn-checkout';
    checkoutBtn.textContent = 'Check Out';
    checkoutBtn.addEventListener('click', () => openCheckoutModal(record, checkoutBtn));
    actionTd.appendChild(checkoutBtn);
  }

  row.append(dateTd, nameTd, timeInTd, actionTd);
  return row;
}

function renderAttendanceList() {
  if (!attendanceList) return;

  const fragment = document.createDocumentFragment();
  getDashboardRecords().forEach(record => fragment.appendChild(createAttendanceRow(record)));
  attendanceList.replaceChildren(fragment);

  filterAttendanceList();
  updateClearLogsButtonState();

  // Keep the history view in sync while it is visible
  if (currentView === 'history') renderHistory();
}

function filterAttendanceList() {
  if (!attendanceList) return;

  const query = searchInput ? searchInput.value.toLowerCase().trim() : '';
  const rows = attendanceList.querySelectorAll('tr');
  let visibleCount = 0;

  rows.forEach(row => {
    const haystack = row.dataset.search || '';
    if (!query || haystack.includes(query)) {
      row.style.display = '';
      visibleCount++;
    } else {
      row.style.display = 'none';
    }
  });

  if (noResults) {
    if (visibleCount === 0) {
      if (records.length === 0) {
        noResults.textContent = 'No attendance records yet. Use Quick Check-In to add your first member.';
      } else if (getDashboardRecords().length === 0) {
        noResults.textContent = 'Dashboard log cleared. New check-ins will appear here; past visits remain available in History.';
      } else {
        noResults.textContent = 'No records found matching your search.';
      }
      noResults.classList.remove('hidden');
    } else {
      noResults.classList.add('hidden');
    }
  }
}

// ==========================================
// TOP NAVIGATION & HISTORY VIEW
// ==========================================

function getViewFromHash() {
  const requested = window.location.hash.replace(/^#/, '');
  return views[requested] ? requested : 'dashboard';
}

function updateNavState(viewName) {
  navLinks.forEach(link => {
    const isActive = link.dataset.view === viewName;
    link.classList.toggle('is-active', isActive);
    if (isActive) {
      link.setAttribute('aria-current', 'page');
    } else {
      link.removeAttribute('aria-current');
    }
  });
}

// Switches between the dashboard and history views, updates the nav state,
// and lazily prepares the history view the first time it is opened.
function setView(viewName, options = {}) {
  if (!views[viewName]) viewName = 'dashboard';

  const changed = currentView !== viewName;
  currentView = viewName;

  Object.entries(views).forEach(([name, element]) => {
    if (!element) return;
    element.classList.toggle('hidden', name !== viewName);
  });

  updateNavState(viewName);

  document.title = viewName === 'history'
    ? 'History - FitPulse'
    : 'FitPulse - Live Capacity & Check-In System';

  if (options.updateHash !== false && window.location.hash !== `#${viewName}`) {
    window.location.hash = viewName;
  }

  if (changed && viewName === 'history') {
    if (!historyHasLoaded) {
      historyHasLoaded = true;
      refreshHistory({ showLoading: true });
    } else {
      refreshHistory();
    }
  }

  if (changed && options.scroll !== false) {
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    window.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' });
  }
}

// Show the history skeleton briefly so the view has a deliberate loading
// state, then render the grouped records.
function refreshHistory(options = {}) {
  const showLoading = Boolean(options.showLoading);

  if (historyRenderTimer) {
    clearTimeout(historyRenderTimer);
    historyRenderTimer = null;
  }

  if (showLoading) {
    if (historyLoading) historyLoading.classList.remove('hidden');
    if (historyContent) historyContent.classList.add('hidden');
    if (historyEmpty) historyEmpty.classList.add('hidden');

    historyRenderTimer = setTimeout(() => {
      historyRenderTimer = null;
      renderHistory();
      if (historyLoading) historyLoading.classList.add('hidden');
    }, 320);
    return;
  }

  if (historyLoading) historyLoading.classList.add('hidden');
  renderHistory();
}

function getInitials(name) {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function formatHistoryDate(dateString) {
  const [year, month, day] = String(dateString).split('-').map(Number);
  if (!year || !month || !day) return dateString;

  const date = new Date(year, month - 1, day);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(year, month - 1, day);
  target.setHours(0, 0, 0, 0);

  const diffDays = Math.round((today - target) / 86400000);
  const shortDate = date.toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' });

  if (diffDays === 0) return `Today \u00b7 ${shortDate}`;
  if (diffDays === 1) return `Yesterday \u00b7 ${shortDate}`;
  return date.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

function createHistoryItem(record) {
  const item = document.createElement('li');
  item.className = 'history-item';

  const avatar = document.createElement('span');
  avatar.className = 'history-avatar';
  avatar.setAttribute('aria-hidden', 'true');
  avatar.textContent = getInitials(record.name);

  const main = document.createElement('div');
  main.className = 'history-item-main';

  const name = document.createElement('span');
  name.className = 'history-name';
  name.textContent = record.name;

  const meta = document.createElement('span');
  meta.className = 'history-session';

  const active = isRecordActive(record);
  if (record.timeOut) {
    meta.textContent = `Checked in ${record.timeIn} \u00b7 checked out ${record.timeOut}`;
  } else if (active) {
    meta.textContent = `Checked in ${record.timeIn} \u00b7 still in facility`;
  } else {
    meta.textContent = `Checked in ${record.timeIn} \u00b7 session cleared from dashboard`;
  }

  main.append(name, meta);

  const status = document.createElement('span');
  const statusType = record.timeOut ? 'is-complete' : active ? 'is-active' : 'is-cleared';
  status.className = `history-status ${statusType}`;
  status.textContent = record.timeOut ? 'Completed' : active ? 'In facility' : 'Cleared';

  item.append(avatar, main, status);
  return item;
}

function createHistoryGroup(dateString, items) {
  const group = document.createElement('section');
  group.className = 'history-group';

  const headingId = `history-group-${dateString}`;
  group.setAttribute('aria-labelledby', headingId);

  const heading = document.createElement('div');
  heading.className = 'history-group-heading';

  const title = document.createElement('h2');
  title.className = 'history-group-title';
  title.id = headingId;
  title.textContent = formatHistoryDate(dateString);

  const count = document.createElement('span');
  count.className = 'history-group-count';
  count.textContent = `${items.length} ${items.length === 1 ? 'check-in' : 'check-ins'}`;

  heading.append(title, count);

  const list = document.createElement('ul');
  list.className = 'history-list';
  items.forEach(record => list.appendChild(createHistoryItem(record)));

  group.append(heading, list);
  return group;
}

function updateHistoryResetState(hasFilters) {
  if (!btnHistoryReset) return;

  if (typeof hasFilters !== 'boolean') {
    hasFilters = Boolean(
      (historyDateInput && historyDateInput.value) ||
      (historySearchInput && historySearchInput.value.trim())
    );
  }

  btnHistoryReset.disabled = !hasFilters;
}

function updateHistoryEmptyState(hasFilters) {
  if (!btnClearHistory) return;
  btnClearHistory.disabled = records.length === 0;

  if (!historyEmpty || !historyEmptyTitle || !historyEmptyText) return;

  const noRecords = records.length === 0;

  historyEmptyTitle.textContent = noRecords
    ? 'No check-in history yet'
    : 'No check-ins match your filters';

  historyEmptyText.textContent = noRecords
    ? 'Once members check in, their visits will be grouped here by date.'
    : 'Try a different date, clear the search, or reset the filters to see all history.';

  if (btnHistoryEmpty) {
    btnHistoryEmpty.dataset.action = noRecords ? 'dashboard' : 'reset';

    const icon = document.createElement('i');
    icon.setAttribute('aria-hidden', 'true');
    icon.setAttribute('data-lucide', noRecords ? 'layout-dashboard' : 'rotate-ccw');

    btnHistoryEmpty.replaceChildren(
      icon,
      document.createTextNode(noRecords ? ' GO TO DASHBOARD' : ' CLEAR FILTERS')
    );

    if (window.lucide) lucide.createIcons();
  }
}

function renderHistory() {
  if (!historyContent) return;

  const dateFilter = historyDateInput ? historyDateInput.value : '';
  const query = historySearchInput ? historySearchInput.value.trim().toLowerCase() : '';
  const hasFilters = Boolean(dateFilter || query);

  const filtered = records
    .filter(record => {
      if (dateFilter && record.date !== dateFilter) return false;
      if (query && !`${record.name} ${record.date}`.toLowerCase().includes(query)) return false;
      return true;
    })
    .sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);

  // Group records chronologically, newest date first
  const groups = new Map();
  filtered.forEach(record => {
    if (!groups.has(record.date)) groups.set(record.date, []);
    groups.get(record.date).push(record);
  });

  const fragment = document.createDocumentFragment();
  groups.forEach((items, dateString) => {
    fragment.appendChild(createHistoryGroup(dateString, items));
  });
  historyContent.replaceChildren(fragment);

  let summary;
  if (records.length === 0) {
    summary = 'No check-ins recorded yet.';
  } else if (filtered.length === 0) {
    summary = 'No check-ins match the current filters.';
  } else {
    const visitLabel = filtered.length === 1 ? 'check-in' : 'check-ins';
    const dayLabel = groups.size === 1 ? 'day' : 'days';
    summary = `Showing ${filtered.length} ${visitLabel} across ${groups.size} ${dayLabel}`;
    if (hasFilters) summary += ` (filtered from ${records.length} total)`;
    summary += '.';
  }

  if (historyResultSummary) historyResultSummary.textContent = summary;

  const isEmpty = filtered.length === 0;
  if (historyContent) historyContent.classList.toggle('hidden', isEmpty);
  if (historyEmpty) historyEmpty.classList.toggle('hidden', !isEmpty);

  if (isEmpty) updateHistoryEmptyState(hasFilters);
  else {
    if (btnClearHistory) btnClearHistory.disabled = records.length === 0;
  }
  updateHistoryResetState(hasFilters);

  if (window.lucide) lucide.createIcons();
}

function resetHistoryFilters() {
  if (historyDateInput) historyDateInput.value = '';
  if (historySearchInput) historySearchInput.value = '';
  refreshHistory();
}

// Navigation clicks update the URL hash; the hashchange listener applies the
// view so browser back/forward buttons keep working.
navLinks.forEach(link => {
  link.addEventListener('click', () => {
    const targetView = link.dataset.view;
    if (!views[targetView] || currentView === targetView) return;
    window.location.hash = targetView;
  });
});

window.addEventListener('hashchange', () => {
  setView(getViewFromHash(), { updateHash: false });
});

// History filter interactions
if (historyDateInput) {
  historyDateInput.addEventListener('change', () => refreshHistory());
}

if (historySearchInput) {
  historySearchInput.addEventListener('input', () => {
    if (historySearchTimer) clearTimeout(historySearchTimer);
    historySearchTimer = setTimeout(() => {
      historySearchTimer = null;
      refreshHistory();
    }, 140);
  });
}

if (btnHistoryReset) {
  btnHistoryReset.addEventListener('click', resetHistoryFilters);
}

if (btnHistoryEmpty) {
  btnHistoryEmpty.addEventListener('click', () => {
    if (btnHistoryEmpty.dataset.action === 'reset') {
      resetHistoryFilters();
      return;
    }

    if (window.location.hash === '#dashboard') {
      setView('dashboard');
    } else {
      window.location.hash = 'dashboard';
    }
  });
}

// Clear all history
function openClearHistoryModal(triggerElement) {
  openModal(clearHistoryModal, triggerElement, () => {
    if (btnClearHistoryConfirm) btnClearHistoryConfirm.focus();
  });
  if (window.lucide) lucide.createIcons();
}

function closeClearHistoryModal() {
  closeModal(clearHistoryModal);
}

function clearAllHistory() {
  records = [];
  nextRecordId = 1;
  dashboardClearedThroughId = 0;
  saveState();
  renderAttendanceList();
  renderLiveOccupancy();
  if (historyDateInput) historyDateInput.value = '';
  if (historySearchInput) historySearchInput.value = '';
  historyHasLoaded = true;
  refreshHistory();
  showToast('Attendance history cleared successfully.', 'success');
}

if (btnClearHistory) {
  btnClearHistory.addEventListener('click', () => {
    pendingClearAction = 'clearHistory';
    openModal(adminPinModal, btnClearHistory, () => {
      if (adminPinInput) {
        adminPinInput.value = '';
        adminPinInput.focus();
      }
    });
    if (window.lucide) lucide.createIcons();
  });
}

if (btnClearHistoryCancel) {
  btnClearHistoryCancel.addEventListener('click', closeClearHistoryModal);
}

if (btnClearHistoryConfirm) {
  btnClearHistoryConfirm.addEventListener('click', () => {
    clearAllHistory();
    closeClearHistoryModal();
    if (historySearchInput) historySearchInput.focus();
  });
}

if (clearHistoryModal) {
  clearHistoryModal.addEventListener('click', (e) => {
    if (e.target === clearHistoryModal) closeClearHistoryModal();
  });
}

// Admin PIN modal handlers
function closeAdminPinModal() {
  closeModal(adminPinModal);
}

if (btnAdminPinCancel) {
  btnAdminPinCancel.addEventListener('click', () => {
    pendingClearAction = null;
    closeAdminPinModal();
  });
}

if (btnAdminPinConfirm) {
  btnAdminPinConfirm.addEventListener('click', () => {
    if (!adminPinInput) return;
    const entered = adminPinInput.value;
    if (entered === ADMIN_PIN) {
      const action = pendingClearAction;
      pendingClearAction = null;
      adminPinInput.value = '';
      closeAdminPinModal();
      if (action === 'clearLogs') {
        openModal(clearLogsModal, btnClearLogs, () => {
          if (clearConfirmInput) {
            clearConfirmInput.value = '';
            clearConfirmInput.focus();
          }
          updateClearConfirmState();
        });
        if (window.lucide) lucide.createIcons();
        return;
      } else if (action === 'clearHistory') {
        openModal(clearHistoryModal, btnClearHistory);
        if (window.lucide) lucide.createIcons();
        return;
      }
      if (searchInput) searchInput.focus();
    } else {
      adminPinInput.value = '';
      showToast('Invalid Admin Passcode. Access denied.', 'error');
      adminPinInput.focus();
    }
  });
}

if (adminPinModal) {
  adminPinModal.addEventListener('click', (e) => {
    if (e.target === adminPinModal) {
      pendingClearAction = null;
      if (adminPinInput) adminPinInput.value = '';
      closeAdminPinModal();
    }
  });
}

// ==========================================
// MODAL CONTROLS (shared by every overlay)
// ==========================================

// Hide the page behind the modal from both pointer and assistive technology
function setBackgroundInert(isInert) {
  [navbar, dashboardContainer].forEach(el => {
    if (!el) return;
    if (isInert) {
      el.setAttribute('inert', '');
      el.setAttribute('aria-hidden', 'true');
    } else {
      el.removeAttribute('inert');
      el.removeAttribute('aria-hidden');
    }
  });
}

function getModalFocusables(overlay) {
  if (!overlay) return [];
  return Array.from(
    overlay.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
  ).filter(el => !el.disabled && el.offsetParent !== null);
}

// Opens an overlay, hides the page behind it and moves focus into the dialog.
function openModal(overlay, triggerElement, onOpen) {
  if (!overlay) return;

  // Never stack two modals on top of each other
  if (activeModal && activeModal !== overlay) closeModal(activeModal);

  // Remember the trigger so focus can be returned to it when the modal closes
  lastFocusedElement = triggerElement || document.activeElement;
  activeModal = overlay;

  overlay.classList.remove('hidden');
  setBackgroundInert(true);

  if (onOpen) onOpen();
}

// Closes an overlay, restores the page behind it and returns focus.
function closeModal(overlay) {
  if (!overlay) return;

  overlay.classList.add('hidden');
  setBackgroundInert(false);

  if (activeModal === overlay) activeModal = null;

  // Run the modal's own cleanup (reset form fields, clear state, ...)
  const cleanup = modalCleanupHandlers.get(overlay);
  if (cleanup) cleanup();

  // Only restore focus if the trigger still exists and can receive it
  if (
    lastFocusedElement &&
    typeof lastFocusedElement.focus === 'function' &&
    document.contains(lastFocusedElement) &&
    !lastFocusedElement.disabled
  ) {
    lastFocusedElement.focus();
  }
  lastFocusedElement = null;
}

// ---- Checkout confirmation modal ----

function openCheckoutModal(record, triggerElement) {
  pendingCheckoutId = record.id;
  pendingCheckoutName = record.name;

  if (modalMemberName) modalMemberName.textContent = record.name;

  openModal(checkoutModal, triggerElement, () => {
    // Move focus into the dialog
    if (btnModalConfirm) btnModalConfirm.focus();
  });

  if (window.lucide) lucide.createIcons();
}

function closeCheckoutModal() {
  closeModal(checkoutModal);
}

modalCleanupHandlers.set(checkoutModal, () => {
  pendingCheckoutId = null;
  pendingCheckoutName = '';
});

// Modal Buttons Events
if (btnModalCancel) {
  btnModalCancel.addEventListener('click', closeCheckoutModal);
}

if (btnModalConfirm) {
  btnModalConfirm.addEventListener('click', () => {
    const recordId = pendingCheckoutId;
    if (recordId !== null) executeCheckout(recordId);
    closeCheckoutModal();
    // The trigger button is replaced during the re-render, so park focus
    // somewhere useful for keyboard users.
    if (searchInput) searchInput.focus();
  });
}

// Close modal if clicking background overlay
if (checkoutModal) {
  checkoutModal.addEventListener('click', (e) => {
    if (e.target === checkoutModal) closeCheckoutModal();
  });
}

// Escape closes the active modal; Tab is trapped inside it
document.addEventListener('keydown', (e) => {
  if (!activeModal) return;

  if (e.key === 'Escape') {
    e.preventDefault();
    closeModal(activeModal);
    return;
  }

  if (e.key === 'Tab') {
    const focusables = getModalFocusables(activeModal);
    if (focusables.length === 0) return;

    const first = focusables[0];
    const last = focusables[focusables.length - 1];

    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }
});

// ==========================================
// MEMBER NAME VALIDATION
// ==========================================

// Allowed: letters (any case), spaces, hyphens and apostrophes.
const NAME_ALLOWED_PATTERN = /^[A-Za-z][A-Za-z\s'-]*$/;

// Matches anything that is not allowed; used for stripping on input/paste.
const NAME_INVALID_PATTERN = /[^a-zA-Z\s'-]/g;

// Collapses repeats a browser autofill or paste can sneak in (e.g. "O''Neil").
const NAME_REPEATED_PUNCTUATION = /([\s'-])\1+/g;

function sanitizeNameInput(value) {
  return String(value)
    .replace(NAME_INVALID_PATTERN, '')
    .replace(NAME_REPEATED_PUNCTUATION, '$1');
}

// Strips disallowed characters as the user types or pastes, and reports how
// many characters were removed so the caller can warn the user.
function enforceNameInputRules() {
  if (!memberInput) return 0;

  const original = memberInput.value;
  const cleaned = sanitizeNameInput(original);

  if (cleaned === original) return 0;

  // Preserve the caret position relative to the cleaned text
  const caret = memberInput.selectionStart;
  const removedBeforeCaret = original
    .slice(0, caret === null ? original.length : caret)
    .replace(NAME_INVALID_PATTERN, '').length;

  const removed = original.length - cleaned.length;

  memberInput.value = cleaned;

  if (document.activeElement === memberInput) {
    memberInput.setSelectionRange(removedBeforeCaret, removedBeforeCaret);
  }

  return removed;
}

function showFieldError(message) {
  if (!memberInputError) return;
  memberInputError.textContent = message;
  memberInputError.classList.remove('hidden');
  if (memberInput) memberInput.classList.add('has-error');
}

function clearFieldError() {
  if (memberInputError) {
    memberInputError.textContent = '';
    memberInputError.classList.add('hidden');
  }
  if (memberInput) memberInput.classList.remove('has-error');
}

// Returns an error message when the name is unusable, otherwise null.
function validateMemberName(value) {
  const name = String(value).trim();

  if (!name) return 'Please enter the member name before checking in.';
  if (name.length < 2) return 'Member name must be at least 2 letters long.';
  if (!/[A-Za-z]/.test(name)) return "Member name must contain at least one letter.";
  if (!NAME_ALLOWED_PATTERN.test(name)) {
    return "Member name can only contain letters, spaces, hyphens (-) and apostrophes (').";
  }
  return null;
}

// ==========================================
// EVENT HANDLERS
// ==========================================

// Handle Check-In
if (checkinForm) {
  checkinForm.addEventListener('submit', (e) => {
    e.preventDefault();

    // The submit handler is the source of truth; HTML validation is a hint
    // for browsers that support it.
    const rawName = memberInput ? memberInput.value : '';
    const name = sanitizeNameInput(rawName).trim();

    // Reject anything the sanitizer had to change (numbers / symbols), rather
    // than silently accepting a partial name.
    const nameError = rawName.trim() === name
      ? validateMemberName(name)
      : "Member name can only contain letters, spaces, hyphens (-) and apostrophes (').";

    if (nameError) {
      showFieldError(nameError);
      showToast(nameError, 'error');
      if (memberInput) memberInput.focus();
      return;
    }

    if (memberInput) memberInput.value = name;

    // Facility is full - refuse the check-in
    if (syncActiveCount() >= MAX_CAPACITY) {
      showToast(`Facility is at full capacity (${MAX_CAPACITY}/${MAX_CAPACITY}). Please wait for a member to check out.`, 'error');
      if (memberInput) memberInput.focus();
      return;
    }

    // Member is already inside - refuse the duplicate session
    if (isMemberActive(name)) {
      showToast(`${name} is already checked in.`, 'error');
      if (memberInput) memberInput.select();
      return;
    }

    const timeIn = getCurrentTimeFormatted();
    const currentDate = getCurrentDateFormatted();

    records.unshift({
      id: nextRecordId++,
      name,
      date: currentDate,
      timeIn,
      timeOut: null
    });

    saveState();
    renderAttendanceList();
    renderLiveOccupancy();

    showToast(`Member ${name} checked in successfully!`);

    memberInput.value = '';
    clearFieldError();
  });
}

// Live name filtering while typing or pasting
if (memberInput) {
  const warnAboutRemovedCharacters = (removed) => {
    if (removed <= 0) return;
    showToast(
      `Removed ${removed} invalid ${removed === 1 ? 'character' : 'characters'}. Only letters, spaces, hyphens (-) and apostrophes (') are allowed.`,
      'warning'
    );
  };

  const applyLiveNameRules = (notify) => {
    const removed = enforceNameInputRules();
    if (notify) warnAboutRemovedCharacters(removed);

    // Clear the error styling once the field is usable again
    if (!validateMemberName(memberInput.value)) clearFieldError();
  };

  memberInput.addEventListener('input', () => applyLiveNameRules(true));

  // Paste is applied after the event, so strip on the next tick
  memberInput.addEventListener('paste', () => {
    setTimeout(() => applyLiveNameRules(true), 0);
  });

  memberInput.addEventListener('blur', () => applyLiveNameRules(false));
}

// Perform Check-Out Action
function executeCheckout(recordId) {
  const record = records.find(r => r.id === recordId);
  if (!record || record.timeOut) return;

  const timeOut = getCurrentTimeFormatted();
  record.timeOut = timeOut;

  saveState();
  renderAttendanceList();
  renderLiveOccupancy();

  showToast(`${record.name} | Checked Out: ${timeOut}`);
}

// Live Search
if (searchInput) {
  searchInput.addEventListener('input', filterAttendanceList);
}

// ==========================================
// CLEAR DASHBOARD LOG (VIEW-ONLY)
// ==========================================

// The phrase the user must type to unlock the clear button
const CLEAR_CONFIRM_PHRASE = 'CLEAR';

// Enables "Clear Dashboard Log" only on an exact, case-sensitive match
function updateClearConfirmState() {
  if (!clearConfirmInput || !btnClearConfirm) return;

  const matches = clearConfirmInput.value === CLEAR_CONFIRM_PHRASE;
  btnClearConfirm.disabled = !matches;
  clearConfirmInput.classList.toggle('is-valid', matches);
}

// Nothing to clear when the dashboard log is already empty
function updateClearLogsButtonState() {
  if (!btnClearLogs) return;
  btnClearLogs.disabled = getDashboardRecords().length === 0;
}

function openClearLogsModal(triggerElement) {
  // Require admin PIN before clearing logs
  pendingClearAction = 'clearLogs';
  openModal(adminPinModal, triggerElement, () => {
    if (adminPinInput) {
      adminPinInput.value = '';
      adminPinInput.focus();
    }
  });
  if (window.lucide) lucide.createIcons();
}

function closeClearLogsModal() {
  closeModal(clearLogsModal);
}

// Hide every record currently shown in the dashboard log and reset the live
// occupancy view. History still reads from the untouched central records array.
function clearDashboardLogs() {
  dashboardClearedThroughId = records.reduce((max, record) => Math.max(max, record.id), 0);

  saveState();

  // A cleared dashboard no longer matches any previous dashboard search
  if (searchInput) searchInput.value = '';
  if (memberInput) memberInput.value = '';
  clearFieldError();

  renderAttendanceList();
  renderLiveOccupancy();

  showToast('Dashboard log and live occupancy cleared. Attendance history has been preserved.', 'warning');
}

if (btnClearLogs) {
  btnClearLogs.addEventListener('click', () => openClearLogsModal(btnClearLogs));
}

if (clearConfirmInput) {
  clearConfirmInput.addEventListener('input', updateClearConfirmState);
}

if (btnClearCancel) {
  btnClearCancel.addEventListener('click', closeClearLogsModal);
}

if (btnClearConfirm) {
  btnClearConfirm.addEventListener('click', () => {
    // Guard again at the point of action
    if (!clearConfirmInput || clearConfirmInput.value !== CLEAR_CONFIRM_PHRASE) return;

    clearDashboardLogs();
    showToast('Dashboard log reset completed.', 'success');
    closeClearLogsModal();
    if (searchInput) searchInput.focus();
  });
}

// Close modal if clicking background overlay
if (clearLogsModal) {
  clearLogsModal.addEventListener('click', (e) => {
    if (e.target === clearLogsModal) closeClearLogsModal();
  });
}

// Reset and disable the confirmation field whenever the modal closes
modalCleanupHandlers.set(clearLogsModal, () => {
  if (clearConfirmInput) {
    clearConfirmInput.value = '';
    clearConfirmInput.classList.remove('is-valid');
  }
  updateClearConfirmState();
});

// Initialize UI
loadState();
renderAttendanceList();
renderLiveOccupancy();
updateClearConfirmState();
updateClearLogsButtonState();
clearFieldError();

// The date picker should not allow dates in the future
if (historyDateInput) {
  historyDateInput.max = getCurrentDateFormatted();
}

// Restore the view requested in the URL hash (defaults to dashboard)
setView(getViewFromHash(), { updateHash: false, scroll: false });
