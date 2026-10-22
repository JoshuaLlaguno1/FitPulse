// ==========================================
// STATE MANAGEMENT & DOM ELEMENTS
// ==========================================
const MAX_CAPACITY = 50;
const STORAGE_KEY = 'fitpulse.attendance.v1';
const RING_CIRCUMFERENCE = 314;

// Source of truth for the attendance log.
// Each record: { id, name, date, timeIn, timeOut }
let records = [];
let nextRecordId = 1;

// Number of members currently inside the facility
let activeCount = 0;

let toastTimeout = null;

// Pending checkout state, populated while the confirmation modal is open
let pendingCheckoutId = null;
let pendingCheckoutName = '';

// Only one modal may be open at a time
let activeModal = null;

// Element focused before the current modal opened (restored on close)
let lastFocusedElement = null;

// Per-modal cleanup run when that modal closes (resets form state, etc.)
const modalCleanupHandlers = new Map();

// DOM Elements
const checkinForm = document.getElementById('checkin-form');
const memberInput = document.getElementById('member-input');
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

// True when the given member already has an open (not checked out) session
function isMemberActive(name) {
  const key = normalizeName(name);
  return records.some(r => !r.timeOut && normalizeName(r.name) === key);
}

// Recompute the active head-count from the records
function syncActiveCount() {
  activeCount = records.filter(r => !r.timeOut).length;
  return activeCount;
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
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ nextRecordId, records }));
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
    nextRecordId = Math.max(Number(parsed.nextRecordId) || 0, highestId + 1);
  } catch (err) {
    console.warn('FitPulse: unable to restore attendance data.', err);
    records = [];
    nextRecordId = 1;
  }
}

// ==========================================
// TOAST NOTIFICATIONS
// ==========================================

function showToast(message, type = 'success') {
  if (!toast || !toastMessage) return;

  // Normalise the requested tone
  const tone = (type === 'error' || type === 'warning') ? type : 'success';

  toastMessage.textContent = message;
  toast.classList.remove('toast-success', 'toast-error', 'toast-warning');
  toast.classList.add('toast-' + tone);

  // Swap the Lucide icon to match the toast type
  if (toastIconSlot) {
    toastIconSlot.replaceChildren();
    const icon = document.createElement('i');
    icon.className = 'toast-icon';
    const iconName = tone === 'error' ? 'alert-circle' : tone === 'warning' ? 'alert-triangle' : 'check-circle-2';
    icon.setAttribute('data-lucide', iconName);
    toastIconSlot.appendChild(icon);
  }

  toast.classList.remove('hidden');

  if (window.lucide) lucide.createIcons();

  if (toastTimeout) clearTimeout(toastTimeout);

  toastTimeout = setTimeout(() => {
    toast.classList.add('hidden');
  }, tone === 'success' ? 3000 : 5000);

  // Announce the outcome to assistive technology
  if (liveRegion) liveRegion.textContent = message;
}

// ==========================================
// ATTENDANCE LOG RENDERING
// ==========================================

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
  records.forEach(record => fragment.appendChild(createAttendanceRow(record)));
  attendanceList.replaceChildren(fragment);

  filterAttendanceList();
  updateClearLogsButtonState();
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
      noResults.textContent = records.length === 0
        ? 'No attendance records yet. Use Quick Check-In to add your first member.'
        : 'No records found matching your search.';
      noResults.classList.remove('hidden');
    } else {
      noResults.classList.add('hidden');
    }
  }
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
// EVENT HANDLERS
// ==========================================

// Handle Check-In
if (checkinForm) {
  checkinForm.addEventListener('submit', (e) => {
    e.preventDefault();

    const name = memberInput.value.trim();
    if (!name) return;

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
    syncActiveCount();
    updateOccupancyUI();

    showToast(`${name} | Checked In: ${timeIn}`);

    memberInput.value = '';
  });
}

// Perform Check-Out Action
function executeCheckout(recordId) {
  const record = records.find(r => r.id === recordId);
  if (!record || record.timeOut) return;

  const timeOut = getCurrentTimeFormatted();
  record.timeOut = timeOut;

  saveState();
  renderAttendanceList();
  syncActiveCount();
  updateOccupancyUI();

  showToast(`${record.name} | Checked Out: ${timeOut}`);
}

// Live Search
if (searchInput) {
  searchInput.addEventListener('input', filterAttendanceList);
}

// ==========================================
// CLEAR ALL LOGS (DESTRUCTIVE ACTION)
// ==========================================

// The phrase the user must type to unlock the wipe button
const CLEAR_CONFIRM_PHRASE = 'DELETE';

// Enables "Confirm Wipe" only on an exact, case-sensitive match
function updateClearConfirmState() {
  if (!clearConfirmInput || !btnClearConfirm) return;

  const matches = clearConfirmInput.value === CLEAR_CONFIRM_PHRASE;
  btnClearConfirm.disabled = !matches;
  clearConfirmInput.classList.toggle('is-valid', matches);
}

// Nothing to clear when the log is already empty
function updateClearLogsButtonState() {
  if (!btnClearLogs) return;
  btnClearLogs.disabled = records.length === 0;
}

function openClearLogsModal(triggerElement) {
  openModal(clearLogsModal, triggerElement, () => {
    if (clearConfirmInput) {
      clearConfirmInput.value = '';
      clearConfirmInput.focus();
    }
    updateClearConfirmState();
  });

  if (window.lucide) lucide.createIcons();
}

function closeClearLogsModal() {
  closeModal(clearLogsModal);
}

// Wipes every attendance record from memory and from storage
function wipeAllLogs() {
  records = [];
  activeCount = 0;
  nextRecordId = 1;

  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (err) {
    console.warn('FitPulse: unable to remove persisted attendance data.', err);
  }

  // A wiped log no longer matches any previous search
  if (searchInput) searchInput.value = '';

  renderAttendanceList();
  updateOccupancyUI();

  showToast('All attendance logs have been permanently deleted.', 'warning');
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

    wipeAllLogs();
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
syncActiveCount();
renderAttendanceList();
updateOccupancyUI();
updateClearConfirmState();
updateClearLogsButtonState();
