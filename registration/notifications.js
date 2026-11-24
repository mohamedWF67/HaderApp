// Notifications page: my messages, newest first. Opening the page marks them as read
// (the ones that were new keep a "New" tag until the page is opened again).

const API = CONFIG.REGISTRATION_API;
const message = document.getElementById('message');
const list = document.getElementById('note-list');

// A short label for each kind of message.
const LABELS = {
  waitlist_promoted: 'Seat confirmed',
  removed_by_organizer: 'Removed',
  workshop_deleted: 'Cancelled',
  registration_closed: 'Registration closed',
  workshop_reminder: 'Reminder',
  waitlist_expired: 'Waiting list closed'
};

function noteRow(n) {
  const row = el('article', { className: n.read ? 'note' : 'note is-new' });
  row.dataset.type = n.type;
  const head = el('p', { className: 'note-head' });
  head.append(el('span', { className: 'note-label' }, LABELS[n.type] || 'Update'));
  if (!n.read) head.append(el('span', { className: 'badge' }, 'New'));
  head.append(el('span', { className: 'note-time' }, formatDate(n.createdAt)));
  row.append(head, el('p', { className: 'note-text' }, n.message));
  return row;
}

(async function start() {
  if (!requireLoginPage()) return;
  try {
    await loadNav();
    const { notifications, unread } = await api(API, '/notifications/me');
    if (notifications.length === 0) {
      list.replaceChildren(el('p', { className: 'empty' }, 'Nothing yet. When something changes about your workshops, it will appear here.'));
      return;
    }
    list.replaceChildren(...notifications.map(noteRow));
    if (unread > 0) {
      await api(API, '/notifications/read', { method: 'POST' });
      const badge = document.querySelector('#nav .bell .badge');
      if (badge) badge.remove();
    }
  } catch (err) {
    showMessage(message, err.message, 'error');
  }
})();
