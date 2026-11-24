'use strict';

// Attendance interface for the shared HaderApp website.
// Uses the same Supabase session token and navigation as Registration/Certificates.
// Workshop and registration lists come from Nourhan's Registration API.
// Attendance actions go to Mohamed's protected Attendance API.

const byId = name => document.getElementById(name);
const messageEl = byId('message');
const organizerTools = byId('organizer-tools');
let me = null;
let workshops = [];

function notify(text, type = 'info') {
  showMessage(messageEl, text, type);
}

function makeOption(id, label) {
  const option = document.createElement('option');
  option.value = String(id);
  option.textContent = label;
  return option;
}

function selectedWorkshop() {
  return byId('workshop').value;
}

async function attendanceApi(path, options = {}) {
  const headers = { Authorization: 'Bearer ' + getToken() };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  let response;
  try {
    response = await fetch(ATTENDANCE_API + path, {
      method: options.method || 'GET',
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined
    });
  } catch (_) {
    throw new Error('Attendance API is unreachable. Start Floci and serve HaderApp locally. Public HTTPS hosting needs a public HTTPS backend.');
  }
  if (response.status === 401) {
    logout();
    throw new Error('Please sign in again.');
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = body.error;
    throw new Error((typeof error === 'string' ? error : error?.message) ||
      body.code || 'Attendance request failed (HTTP ' + response.status + ').');
  }
  return body;
}

function renderWorkshops() {
  const select = byId('workshop');
  select.replaceChildren(makeOption('', 'Select a workshop'));
  for (const workshop of workshops) {
    select.append(makeOption(workshop.workshopId, workshop.title + ' (#' + workshop.workshopId + ')'));
  }
  if (workshops.length) select.value = String(workshops[0].workshopId);
}

async function loadWorkshops() {
  if (me.role === 'organizer') {
    const items = await api(CONFIG.REGISTRATION_API, '/workshops');
    workshops = items.filter(w => w.organizerId === me.userId);
  } else {
    const items = await api(CONFIG.REGISTRATION_API, '/registrations/me');
    workshops = items.map(r => r.workshop).filter(Boolean);
  }
  renderWorkshops();
  if (workshops.length) await loadCurrentWorkshop();
  else {
    byId('sessions').textContent = 'No workshops available for this account.';
    notify('No workshops available.');
  }
}

async function loadCurrentWorkshop() {
  const workshopId = selectedWorkshop();
  if (!workshopId) return;
  await loadSessions();
  if (me.role === 'organizer') await loadRegistrations();
}

async function loadSessions() {
  const workshopId = selectedWorkshop();
  if (!workshopId) return;
  const data = await attendanceApi('/workshops/' + workshopId + '/sessions');
  const sessions = data.sessions || [];
  for (const id of ['checkin-session', 'attendance-session']) {
    const select = byId(id);
    select.replaceChildren(makeOption('', 'Select a session'));
    for (const s of sessions) select.append(makeOption(s.sessionId, s.title + ' (#' + s.sessionId + ')'));
    if (sessions.length) select.value = String(sessions[0].sessionId);
  }

  const list = byId('sessions');
  list.replaceChildren();
  if (!sessions.length) {
    list.textContent = 'No sessions have been created.';
    return;
  }
  for (const s of sessions) {
    const row = document.createElement('div');
    row.className = 'attendance-session';
    const left = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = s.title;
    const times = document.createElement('span');
    times.className = 'attendance-date';
    times.textContent = new Date(s.startTime).toLocaleString() + ' to ' +
      new Date(s.endTime).toLocaleString();
    const status = document.createElement('span');
    status.className = s.checkinStatus === 'open' ? 'attendance-open' : 'attendance-closed';
    status.textContent = s.checkinStatus === 'open' ? 'Open' : 'Closed';
    left.append(title, times);
    row.append(left, status);
    list.append(row);
  }
}

async function loadRegistrations() {
  const workshopId = selectedWorkshop();
  if (!workshopId) return;
  const items = await api(CONFIG.REGISTRATION_API,
    '/workshops/' + workshopId + '/registrations');
  const select = byId('registration');
  select.replaceChildren(makeOption('', 'Select an attendee'));
  for (const r of items) {
    select.append(makeOption(r.registrationId, (r.name || r.email || 'Attendee') +
      ' (#' + r.registrationId + ')'));
  }
  if (items.length) select.value = String(items[0].registrationId);
}

async function showSummary() {
  const data = await attendanceApi('/workshops/' + selectedWorkshop() + '/attendance/summary');
  const root = byId('summary');
  root.replaceChildren();
  const header = document.createElement('p');
  header.textContent = data.registeredAttendees + ' registered attendees, ' +
    data.totalSessions + ' total sessions. Percentages are provisional until the workshop ends.';
  root.append(header);
  for (const a of data.attendees || []) {
    const row = document.createElement('div');
    row.className = 'attendance-summary-row';
    const name = document.createElement('strong');
    name.textContent = a.attendeeName || 'Attendee #' + a.registrationId;
    const count = document.createElement('span');
    count.textContent = a.attendedSessions + '/' + a.totalSessions + ' (' +
      (a.attendancePercentage ?? 'N/A') + '%)';
    row.append(name, count);
    root.append(row);
  }
}

function handle(action) {
  return async event => {
    if (event?.preventDefault) event.preventDefault();
    const button = event?.submitter || event?.currentTarget;
    if (button) button.disabled = true;
    try {
      await action();
    } catch (error) {
      notify(error.message, 'error');
    } finally {
      if (button) button.disabled = false;
    }
  };
}

byId('workshop').addEventListener('change', handle(loadCurrentWorkshop));
byId('refresh').addEventListener('click', handle(async () => {
  await loadCurrentWorkshop();
  notify('Workshop refreshed.', 'success');
}));

byId('create-session').addEventListener('submit', handle(async () => {
  const workshopId = selectedWorkshop();
  const start = byId('session-start').value;
  const end = byId('session-end').value;
  if (!workshopId || !start || !end || new Date(end) <= new Date(start)) {
    throw new Error('Select a workshop and valid session times.');
  }
  await attendanceApi('/workshops/' + workshopId + '/sessions', {
    method: 'POST',
    body: {
      title: byId('session-title').value.trim(),
      startTime: new Date(start).toISOString(),
      endTime: new Date(end).toISOString()
    }
  });
  byId('create-session').reset();
  await loadSessions();
  notify('Session created with check-in closed.', 'success');
}));

async function changeCheckin(status) {
  const workshopId = selectedWorkshop();
  const sessionId = byId('checkin-session').value;
  if (!workshopId || !sessionId) throw new Error('Select a workshop and session.');
  await attendanceApi('/workshops/' + workshopId + '/sessions/' + sessionId + '/checkin', {
    method: 'PATCH', body: { status }
  });
  await loadSessions();
  notify('Check-in is now ' + status + '.', 'success');
}

byId('open-checkin').addEventListener('click', handle(() => changeCheckin('open')));
byId('close-checkin').addEventListener('click', handle(() => changeCheckin('closed')));

byId('mark-present').addEventListener('click', handle(async () => {
  const workshopId = selectedWorkshop();
  const sessionId = byId('attendance-session').value;
  const registrationId = Number(byId('registration').value);
  if (!workshopId || !sessionId || !registrationId) {
    throw new Error('Select a workshop, session, and registered attendee.');
  }
  await attendanceApi('/workshops/' + workshopId + '/sessions/' + sessionId + '/attendance', {
    method: 'POST', body: { registrationId }
  });
  notify('Attendance recorded.', 'success');
}));

byId('view-summary').addEventListener('click', handle(async () => {
  if (!selectedWorkshop()) throw new Error('Select a workshop.');
  await showSummary();
  notify('Summary loaded.', 'success');
}));

(async function start() {
  if (!requireLoginPage()) return;
  try {
    me = await loadNav();
    organizerTools.hidden = me.role !== 'organizer';
    await loadWorkshops();
  } catch (e) {
    notify(e.message, 'error');
  }
})();
