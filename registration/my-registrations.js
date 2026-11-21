// My registrations page (attendees): see the workshops I registered for, and cancel.

const API = CONFIG.REGISTRATION_API;
const message = document.getElementById('message');
const list = document.getElementById('registration-list');

function registrationRow(r) {
  const upcoming = new Date(r.workshop.date) > new Date();
  const row = el('article', { className: upcoming ? 'workshop' : 'workshop is-past' });

  const info = el('div');
  info.append(el('h3', {}, r.workshop.title), el('p', { className: 'host' }, `Registered on ${formatDate(r.registeredAt)}`));

  const side = el('div', { className: 'side' });
  if (upcoming) {
    const cancel = el('button', { className: 'danger' }, 'Cancel registration');
    cancel.addEventListener('click', () => cancelRegistration(r, cancel));
    side.append(cancel);
  } else {
    side.append(el('span', { className: 'host' }, 'This workshop has taken place.'));
  }

  row.append(dateBlock(r.workshop.date), info, side);
  return row;
}

async function loadRegistrations() {
  try {
    const regs = await api(API, '/registrations/me');
    if (regs.length === 0) {
      const empty = el('p', { className: 'empty' }, 'You have no seats yet. ');
      empty.append(el('a', { href: appUrl('registration/workshops.html') }, 'Find a workshop'));
      list.replaceChildren(empty);
      return;
    }
    list.replaceChildren(...regs.map(registrationRow));
  } catch (err) {
    showMessage(message, err.message, 'error');
  }
}

async function cancelRegistration(r, btn) {
  if (!window.confirm(`Cancel your registration for "${r.workshop.title}"? Your seat will be given to someone else.`)) return;
  btn.disabled = true;
  try {
    await api(API, `/registrations/${r.registrationId}`, { method: 'DELETE' });
    showMessage(message, `Registration cancelled. Your seat at ${r.workshop.title} is free for someone else.`, 'success');
  } catch (err) {
    showMessage(message, err.message, 'error');
    btn.disabled = false;
  }
  await loadRegistrations();
}

(async function start() {
  if (!requireLoginPage()) return;
  try {
    const me = await loadNav();
    if (me.role !== 'attendee') {
      showMessage(message, 'Organizers do not register for workshops. Go to Workshops to manage yours.', 'info');
      list.replaceChildren();
      return;
    }
  } catch (err) {
    showMessage(message, err.message, 'error');
    return;
  }
  await loadRegistrations();
})();
