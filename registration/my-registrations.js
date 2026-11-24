// My registrations page (attendees): see the workshops I registered for, and cancel.
// Also shows the waiting lists I am in, with my place in line.

const API = CONFIG.REGISTRATION_API;
const message = document.getElementById('message');
const list = document.getElementById('registration-list');
const queueList = document.getElementById('queue-list');

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

function queueRow(q) {
  const row = el('article', { className: 'workshop is-full' });
  const info = el('div');
  info.append(el('h3', {}, q.workshop.title), el('p', { className: 'host' }, `Joined the queue on ${formatDate(q.joinedAt)}`));
  const side = el('div', { className: 'side' });
  side.append(el('span', { className: 'queue-note' }, q.position === 1 ? 'You are next in line' : `You are number ${q.position} in line`));
  const leave = el('button', { className: 'secondary' }, 'Leave queue');
  leave.addEventListener('click', () => leaveQueue(q, leave));
  side.append(leave);
  row.append(dateBlock(q.workshop.date), info, side);
  return row;
}

async function loadQueue() {
  try {
    const queue = await api(API, '/waitlist/me');
    const show = queue.length > 0;
    for (const id of ['queue-title', 'queue-lead', 'queue-list']) document.getElementById(id).hidden = !show;
    queueList.replaceChildren(...queue.map(queueRow));
  } catch (err) {
    showMessage(message, err.message, 'error');
  }
}

async function leaveQueue(q, btn) {
  if (!window.confirm(`Leave the waiting list for "${q.workshop.title}"? You will lose your place in line.`)) return;
  btn.disabled = true;
  try {
    await api(API, `/waitlist/${q.waitlistId}`, { method: 'DELETE' });
    showMessage(message, `You left the waiting list for ${q.workshop.title}.`, 'success');
  } catch (err) {
    showMessage(message, err.message, 'error');
    btn.disabled = false;
  }
  await loadQueue();
}

async function cancelRegistration(r, btn) {
  if (!window.confirm(`Cancel your registration for "${r.workshop.title}"? Your seat will be given to someone else.`)) return;
  btn.disabled = true;
  try {
    const result = await api(API, `/registrations/${r.registrationId}`, { method: 'DELETE' });
    showMessage(message, result.seatGivenToWaitlist
      ? `Registration cancelled. Your seat at ${r.workshop.title} went to the next person in the waiting list.`
      : `Registration cancelled. Your seat at ${r.workshop.title} is free for someone else.`, 'success');
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
  await Promise.all([loadRegistrations(), loadQueue()]);
})();
