// One helper for every call to our backend APIs.
// It adds the login token and turns error responses into readable messages.

async function api(baseUrl, path, { method = 'GET', body } = {}) {
  const headers = { Authorization: `Bearer ${getToken()}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let res;
  try {
    res = await fetch(baseUrl + path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
  } catch (e) {
    throw new Error('Cannot reach the server. Is it running?');
  }

  // Login expired or invalid -> log in again.
  if (res.status === 401) {
    logout();
    throw new Error('Please log in again.');
  }

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error((data && data.error && data.error.message) || `Request failed (${res.status}).`);
  }
  return data;
}

// Shows a message in an element. textContent (never innerHTML) means text from the
// server is displayed as plain text and can never run as a script (XSS protection).
function showMessage(el, text, type = 'info') {
  el.textContent = text;
  el.className = `message ${type}`;
  el.hidden = !text;
}

function formatDate(iso) {
  return new Date(iso).toLocaleString(undefined, {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
  });
}

// Small helper to build elements safely: el('td', {}, 'text') or el('button', { className: 'x' }, 'Go')
function el(tag, props = {}, text) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  if (text !== undefined) node.textContent = text;
  return node;
}

// Date pieces for the big date block on each workshop row.
function dateParts(iso) {
  const d = new Date(iso);
  return {
    day: d.toLocaleDateString(undefined, { day: 'numeric' }),
    month: d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' }),
    time: d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  };
}

function dateBlock(iso) {
  const p = dateParts(iso);
  const block = el('div', { className: 'date-block' });
  block.append(el('span', { className: 'day' }, p.day), el('span', { className: 'month' }, p.month),
               el('span', { className: 'time' }, p.time));
  return block;
}

// Seats as blocks: filled = taken, empty = free. Large workshops get a simple bar instead.
function seatStrip(total, left) {
  const taken = total - left;
  const wrap = el('div');
  wrap.setAttribute('role', 'img');
  wrap.setAttribute('aria-label', `${taken} of ${total} seats taken`);
  if (total <= 60) {
    wrap.className = 'seat-strip';
    for (let i = 0; i < total; i++) wrap.append(el('span', { className: i < taken ? 'seat taken' : 'seat' }));
  } else {
    wrap.className = 'seat-bar';
    const fill = el('span');
    fill.style.width = `${Math.round((taken / total) * 100)}%`;
    wrap.append(fill);
  }
  return wrap;
}

// ---------- Shared top navigation (the same on every page) ----------
// Links: Workshops, My seats, Certificates, Attendance, Verify.
// Right side: notifications bell (with unread count), the user's name and role, Log out.
// Each page still checks the role itself and the backend enforces it (403);
// the nav only helps people move around.

const NAV_LINKS = [
  ['Workshops', 'registration/workshops.html'],
  ['My seats', 'registration/my-registrations.html'],
  ['Certificates', 'certificate/certificates.html'],
  ['Attendance', 'attendance/attendance.html'],
  ['Verify', 'certificate/verify.html']
];

function bellIcon() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'bell-icon');
  for (const d of ['M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9', 'M10.3 21a1.94 1.94 0 0 0 3.4 0']) {
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

// Role from the login token, only used when /me cannot be loaded (display only).
function roleFromToken() {
  try {
    const p = JSON.parse(atob(getToken().split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return (p.app_metadata && p.app_metadata.role) || null;
  } catch (e) {
    return null;
  }
}

function renderNav(me, { loggedIn = true, unread = 0 } = {}) {
  const nav = document.getElementById('nav');
  const brand = el('a', { href: appUrl('registration/workshops.html'), className: 'brand' }, 'Hader');
  brand.append(el('span', { lang: 'ar' }, 'حاضر'));

  const links = NAV_LINKS
    .filter(([label]) => loggedIn || label === 'Verify')
    .map(([label, page]) => {
      const a = el('a', { href: appUrl(page) }, label);
      if (new URL(a.href).pathname === window.location.pathname) a.setAttribute('aria-current', 'page');
      return a;
    });
  nav.replaceChildren(brand, ...links);

  const right = el('span', { className: 'nav-right' });
  if (loggedIn) {
    const bell = el('a', { href: appUrl('registration/notifications.html'), className: 'bell' });
    bell.append(bellIcon());
    bell.setAttribute('aria-label', unread > 0 ? `Notifications, ${unread} unread` : 'Notifications');
    bell.title = 'Notifications';
    if (unread > 0) bell.append(el('span', { className: 'badge' }, String(unread)));
    if (new URL(bell.href).pathname === window.location.pathname) bell.setAttribute('aria-current', 'page');
    const who = me && me.name ? `${me.name}, ${me.role}` : (me && me.role ? `Signed in, ${me.role}` : 'Signed in');
    right.append(bell, el('span', { className: 'who' }, who), el('button', { className: 'link', onclick: logout }, 'Log out'));
  } else {
    right.append(el('a', { href: appUrl('login.html') }, 'Log in'));
  }
  nav.append(right);
}

// Pages that need a login call this. Returns the user ({ userId, name, role, ... }).
// If the Registration API cannot be reached, the nav is still drawn (role from the token)
// so the page keeps working; the page itself shows any error.
async function loadNav() {
  let me;
  try {
    me = await api(CONFIG.REGISTRATION_API, '/me');
  } catch (err) {
    if (!getToken()) throw err; // api() already sent the user to the login page
    renderNav({ role: roleFromToken() });
    return { role: roleFromToken(), navFallback: true };
  }
  renderNav(me);
  try {
    const { unread } = await api(CONFIG.REGISTRATION_API, '/notifications/me');
    if (unread > 0) renderNav(me, { unread });
  } catch (e) { /* keep the bell without a number */ }
  return me;
}

// Public pages (verify): full nav if logged in, otherwise just Verify + Log in.
function tokenStillValid() {
  try {
    const p = JSON.parse(atob(getToken().split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return p.exp * 1000 > Date.now() + 10000;
  } catch (e) {
    return false;
  }
}

async function loadPublicNav() {
  // Only use the logged-in nav with a valid token: an expired one would make api()
  // send the visitor to the login page, and this page must stay public.
  if (getToken() && tokenStillValid()) {
    try { return await loadNav(); } catch (e) { /* fall through */ }
  }
  renderNav(null, { loggedIn: false });
  return null;
}
