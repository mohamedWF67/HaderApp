'use strict';

// HaderApp public Supabase Auth configuration. Publishable key is safe in frontend.
// PostgreSQL DATABASE_URL is NOT used here and must remain in your local .env.
const SUPABASE_URL = 'https://lydhdtlxodhyqjhvcfdu.supabase.co';
const PUBLISHABLE_KEY = 'sb_publishable_RwEDDrJWI8dfQLh1k54qoQ_XduP2Bjv';
const TOKEN_KEY = 'hader_token';

const byId = id => document.getElementById(id);
const messageBox = byId('message');
let token = sessionStorage.getItem(TOKEN_KEY);
let currentRole = null;

function message(text, error = false) {
  messageBox.textContent = text;
  messageBox.classList.toggle('error', error);
}

function setDisabled(id, disabled) {
  byId(id).disabled = disabled;
}

function opt(value, label) {
  const option = document.createElement('option');
  option.value = String(value);
  option.textContent = label;
  return option;
}

function displayDate(iso) {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: 'medium', timeStyle: 'short'
  });
}

async function api(path, options = {}) {
  const result = await fetch(path, {
    method: options.method || 'GET',
    headers: {
      Authorization: 'Bearer ' + token,
      ...(options.body ? { 'Content-Type': 'application/json' } : {})
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {})
  });
  const data = await result.json().catch(() => ({}));
  if (!result.ok) {
    throw new Error(data.error || data.message || data.code || ('HTTP ' + result.status));
  }
  return data;
}

function chooseWorkshop() {
  return byId('workshop-select').value;
}

function chooseSession(id) {
  return byId(id).value;
}

async function loadWorkshops() {
  const items = await api('/api/workshops');
  const select = byId('workshop-select');
  select.replaceChildren(opt('', 'Select a workshop'));

  for (const w of items) {
    select.append(opt(w.workshopId, w.title + ' (#' + w.workshopId + ')'));
  }

  if (!items.length) {
    message(currentRole === 'organizer'
      ? 'This organizer does not own a workshop yet.'
      : 'You are not registered for a workshop yet.');
    return;
  }

  select.value = String(items[0].workshopId);
  await loadSelectedWorkshop();
}

async function loadSelectedWorkshop() {
  const workshopId = chooseWorkshop();
  if (!workshopId) return;
  byId('summary-list').textContent = 'Select View summary to load attendance.';
  try {
    await loadSessions();
    if (currentRole === 'organizer') await loadRegistrations();
  } catch (e) {
    message(e.message, true);
  }
}

async function loadSessions() {
  const workshopId = chooseWorkshop();
  if (!workshopId) return;
  const data = await api('/workshops/' + workshopId + '/sessions');

  const list = byId('sessions-list');
  list.replaceChildren();

  for (const selectId of ['checkin-session', 'attendance-session']) {
    const select = byId(selectId);
    select.replaceChildren(opt('', 'Select a session'));
    for (const s of data.sessions) {
      select.append(opt(s.sessionId, s.title + ' (#' + s.sessionId + ')'));
    }
    select.value = data.sessions.length ? String(data.sessions[0].sessionId) : '';
  }

  if (!data.sessions.length) {
    list.textContent = 'No sessions created for this workshop yet.';
    return;
  }

  for (const s of data.sessions) {
    const row = document.createElement('div');
    row.className = 'session-row';

    const left = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = s.title;
    const details = document.createElement('div');
    details.className = 'details';
    details.textContent = displayDate(s.startTime) + ' to ' + displayDate(s.endTime);
    left.append(title, details);

    const status = document.createElement('strong');
    status.className = s.checkinStatus === 'open' ? 'status-open' : 'status-closed';
    status.textContent = s.checkinStatus === 'open' ? '● Open' : '● Closed';
    row.append(left, status);
    list.append(row);
  }
}

async function loadRegistrations() {
  const workshopId = chooseWorkshop();
  if (!workshopId) return;
  const data = await api('/api/workshops/' + workshopId + '/registrations');
  const select = byId('registration-select');
  select.replaceChildren(opt('', 'Select registered attendee'));
  for (const r of data) {
    select.append(opt(r.registrationId,
      (r.attendeeName || 'Attendee') + ' (#' + r.registrationId + ')'));
  }
  if (data.length) select.value = String(data[0].registrationId);
}

async function loadSummary() {
  const workshopId = chooseWorkshop();
  if (!workshopId) return message('Select a workshop first.', true);
  const data = await api('/workshops/' + workshopId + '/attendance/summary');
  const list = byId('summary-list');
  list.replaceChildren();

  const note = document.createElement('p');
  note.className = 'muted';
  note.textContent = data.registeredAttendees + ' registered attendees · ' +
    data.totalSessions + ' total sessions. Percentages are provisional until all sessions are complete.';
  list.append(note);

  if (!data.attendees.length) {
    const text = document.createElement('p');
    text.textContent = 'No registered attendees yet.';
    list.append(text);
    return;
  }

  for (const attendee of data.attendees) {
    const row = document.createElement('div');
    row.className = 'summary-row';

    const who = document.createElement('div');
    const name = document.createElement('strong');
    name.textContent = attendee.attendeeName || 'Attendee #' + attendee.registrationId;
    const detail = document.createElement('div');
    detail.className = 'details';
    detail.textContent = attendee.attendedSessions + ' / ' + attendee.totalSessions + ' sessions attended';
    who.append(name, detail);

    const percentage = document.createElement('span');
    percentage.textContent = attendee.attendancePercentage === null
      ? 'N/A' : attendee.attendancePercentage + '%';

    row.append(who, percentage);
    list.append(row);
  }
}

function showSignedOut() {
  token = null;
  currentRole = null;
  sessionStorage.removeItem(TOKEN_KEY);
  byId('login-panel').hidden = false;
  byId('workspace').hidden = true;
  byId('logout').hidden = true;
}

async function showSignedIn() {
  const who = await api('/api/me');
  currentRole = who.role;

  byId('login-panel').hidden = true;
  byId('workspace').hidden = false;
  byId('logout').hidden = false;
  byId('role-label').textContent = currentRole === 'organizer' ? 'Organizer' : 'Attendee';
  byId('organizer-tools').hidden = currentRole !== 'organizer';
  byId('summary-panel').hidden = currentRole !== 'organizer';

  await loadWorkshops();
}

byId('login-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  message('Signing in...');
  try {
    const result = await fetch(SUPABASE_URL + '/auth/v1/token?grant_type=password', {
      method: 'POST',
      headers: { apikey: PUBLISHABLE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: byId('email').value.trim(),
        password: byId('password').value
      })
    });
    const auth = await result.json().catch(() => ({}));
    if (!result.ok || !auth.access_token) {
      throw new Error('Login failed. Check your Hader email and password.');
    }
    token = auth.access_token;
    sessionStorage.setItem(TOKEN_KEY, token);
    byId('password').value = '';
    await showSignedIn();
    message('Signed in successfully.');
  } catch (error) {
    showSignedOut();
    message(error.message, true);
  } finally {
    button.disabled = false;
  }
});

byId('logout').addEventListener('click', () => {
  showSignedOut();
  message('Signed out.');
});

byId('workshop-select').addEventListener('change', loadSelectedWorkshop);
byId('refresh-sessions').addEventListener('click', async () => {
  try { await loadSelectedWorkshop(); message('Workshop refreshed.'); }
  catch (e) { message(e.message, true); }
});

byId('create-session').addEventListener('submit', async event => {
  event.preventDefault();
  const workshopId = chooseWorkshop();
  if (!workshopId) return message('Select a workshop.', true);

  const title = byId('session-title').value.trim();
  const start = byId('session-start').value;
  const end = byId('session-end').value;
  if (!start || !end || new Date(end) <= new Date(start)) {
    return message('End time must be after start time.', true);
  }

  try {
    const created = await api('/workshops/' + workshopId + '/sessions', {
      method: 'POST',
      body: {
        title,
        startTime: new Date(start).toISOString(),
        endTime: new Date(end).toISOString()
      }
    });
    message('Created session #' + created.sessionId + '. Check-in starts closed.');
    byId('create-session').reset();
    await loadSessions();
  } catch (e) {
    message(e.message, true);
  }
});

async function changeCheckin(status) {
  const id = chooseSession('checkin-session');
  const workshopId = chooseWorkshop();
  if (!workshopId || !id) return message('Choose a workshop and session.', true);
  try {
    await api('/workshops/' + workshopId + '/sessions/' + id + '/checkin', {
      method: 'PATCH', body: { status }
    });
    await loadSessions();
    message('Check-in is now ' + status + '.');
  } catch (e) {
    message(e.message, true);
  }
}

byId('open-checkin').addEventListener('click', () => changeCheckin('open'));
byId('close-checkin').addEventListener('click', () => changeCheckin('closed'));

byId('mark-attendance').addEventListener('click', async () => {
  const workshopId = chooseWorkshop();
  const sessionId = chooseSession('attendance-session');
  const registrationId = Number(byId('registration-select').value);
  if (!workshopId || !sessionId || !registrationId) {
    return message('Choose a workshop, session and registered attendee.', true);
  }
  try {
    await api('/workshops/' + workshopId + '/sessions/' + sessionId + '/attendance', {
      method: 'POST', body: { registrationId }
    });
    message('Attendance recorded successfully.');
  } catch (e) {
    message(e.message, true);
  }
});

byId('load-summary').addEventListener('click', async () => {
  try { await loadSummary(); message('Summary loaded.'); }
  catch (e) { message(e.message, true); }
});

if (token) {
  showSignedIn().catch(error => {
    showSignedOut();
    message('Please sign in again. ' + error.message, true);
  });
} else {
  showSignedOut();
}
