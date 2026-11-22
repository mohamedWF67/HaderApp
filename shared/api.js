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

// Shared top navigation: links for the user's role, their name and role, and log out.
async function loadNav() {
  const me = await api(CONFIG.REGISTRATION_API, '/me');
  const nav = document.getElementById('nav');
  const brand = el('a', { href: appUrl('registration/workshops.html'), className: 'brand' }, 'Hader');
  brand.append(el('span', { lang: 'ar' }, 'حاضر'));
  const links = [brand, el('a', { href: appUrl('registration/workshops.html') }, 'Workshops')];
  if (me.role === 'attendee') {
    links.push(el('a', { href: appUrl('registration/my-registrations.html') }, 'My seats'));
  }
  for (const a of links.slice(1)) {
    if (new URL(a.href).pathname === window.location.pathname) a.setAttribute('aria-current', 'page');
  }
  nav.replaceChildren(...links);
  const right = el('span', { className: 'nav-right' });
  right.append(
    el('span', { className: 'who' }, `${me.name || 'Signed in'}, ${me.role}`),
    el('button', { className: 'link', onclick: logout }, 'Log out')
  );
  nav.append(right);
  return me;
}
