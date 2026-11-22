// Workshops page.
// Attendees: see workshops and register.
// Organizers: create and edit their workshops, and see who registered.
// (Hidden buttons are only for convenience: the backend checks every role and owner itself.)

const API = CONFIG.REGISTRATION_API;
const message = document.getElementById('message');
const list = document.getElementById('workshop-list');
const form = document.getElementById('workshop-form');
const formTitle = document.getElementById('form-title');
const saveButton = document.getElementById('save-button');
const cancelEdit = document.getElementById('cancel-edit');
const attendeesPanel = document.getElementById('attendees-panel');

let me = null;
let editingId = null; // null = creating a new workshop

// datetime-local input <-> ISO date string
function toInputDate(iso) {
  const d = new Date(iso);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

function seatCount(w) {
  if (w.seatsLeft === 0) return 'Full';
  return w.seatsLeft === 1 ? '1 seat left' : `${w.seatsLeft} of ${w.totalSeats} seats left`;
}

function workshopRow(w) {
  const row = el('article', { className: 'workshop' });
  if (w.seatsLeft === 0) row.classList.add('is-full');

  const info = el('div');
  info.append(el('h3', {}, w.title), el('p', { className: 'host' }, `Hosted by ${w.organizerName || 'an organizer'}`));
  if (w.description) info.append(el('p', { className: 'desc' }, w.description));

  const side = el('div', { className: 'side' });
  side.append(seatStrip(w.totalSeats, w.seatsLeft), el('span', { className: 'seat-count' }, seatCount(w)));

  const buttons = el('div', { className: 'buttons' });
  if (me.role === 'attendee') {
    const btn = el('button', {}, w.seatsLeft === 0 ? 'No seats left' : 'Register');
    btn.disabled = w.seatsLeft === 0;
    btn.addEventListener('click', () => register(w, btn));
    buttons.append(btn);
  }
  if (me.role === 'organizer' && w.organizerId === me.userId) {
    const edit = el('button', { className: 'secondary' }, 'Edit');
    edit.addEventListener('click', () => startEdit(w));
    const who = el('button', { className: 'secondary' }, 'See attendees');
    who.addEventListener('click', () => showAttendees(w));
    buttons.append(edit, who);
  }
  if (buttons.children.length) side.append(buttons);

  row.append(dateBlock(w.date), info, side);
  return row;
}

async function loadWorkshops() {
  try {
    const workshops = await api(API, '/workshops');
    const upcoming = workshops.filter(w => new Date(w.date) > new Date());
    if (upcoming.length === 0) {
      list.replaceChildren(el('p', { className: 'empty' }, me.role === 'organizer' ? 'No upcoming workshops. Create the first one above.' : 'No upcoming workshops yet. Check back soon.'));
      return;
    }
    list.replaceChildren(...upcoming.map(workshopRow));
  } catch (err) {
    showMessage(message, err.message, 'error');
  }
}

async function register(w, btn) {
  btn.disabled = true;
  try {
    await api(API, `/workshops/${w.workshopId}/registrations`, { method: 'POST' });
    showMessage(message, `Seat saved. You are registered for ${w.title}.`, 'success');
  } catch (err) {
    showMessage(message, err.message, 'error');
  }
  await loadWorkshops();
}

function resetForm() {
  editingId = null;
  form.reset();
  formTitle.textContent = 'New workshop';
  saveButton.textContent = 'Create workshop';
  cancelEdit.hidden = true;
}

function startEdit(w) {
  editingId = w.workshopId;
  document.getElementById('title').value = w.title;
  document.getElementById('description').value = w.description;
  document.getElementById('date').value = toInputDate(w.date);
  document.getElementById('seats').value = w.totalSeats;
  formTitle.textContent = `Editing: ${w.title}`;
  saveButton.textContent = 'Save changes';
  cancelEdit.hidden = false;
  form.scrollIntoView({ behavior: 'smooth' });
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {
    title: document.getElementById('title').value.trim(),
    description: document.getElementById('description').value.trim(),
    date: new Date(document.getElementById('date').value).toISOString(),
    totalSeats: Number(document.getElementById('seats').value)
  };
  saveButton.disabled = true;
  try {
    if (editingId) {
      await api(API, `/workshops/${editingId}`, { method: 'PUT', body });
      showMessage(message, 'Workshop updated.', 'success');
    } else {
      await api(API, '/workshops', { method: 'POST', body });
      showMessage(message, 'Workshop created.', 'success');
    }
    resetForm();
    await loadWorkshops();
  } catch (err) {
    showMessage(message, err.message, 'error');
  } finally {
    saveButton.disabled = false;
  }
});

cancelEdit.addEventListener('click', resetForm);

async function showAttendees(w) {
  const box = document.getElementById('attendees');
  document.getElementById('attendees-title').textContent = `Attendees for ${w.title}`;
  attendeesPanel.hidden = false;
  box.replaceChildren(el('p', { className: 'empty' }, 'Loading...'));
  try {
    const people = await api(API, `/workshops/${w.workshopId}/registrations`);
    if (people.length === 0) {
      box.replaceChildren(el('p', { className: 'empty' }, 'Nobody has registered yet.'));
    } else {
      const table = el('table');
      const head = el('tr');
      head.append(el('th', {}, 'Name'), el('th', {}, 'Email'), el('th', {}, 'Registered on'));
      table.append(head);
      for (const p of people) {
        const row = el('tr');
        row.append(el('td', {}, p.name || '-'), el('td', {}, p.email), el('td', {}, formatDate(p.registeredAt)));
        table.append(row);
      }
      box.replaceChildren(table);
    }
  } catch (err) {
    box.replaceChildren(el('p', { className: 'message error' }, err.message));
  }
  attendeesPanel.scrollIntoView({ behavior: 'smooth' });
}

document.getElementById('close-attendees').addEventListener('click', () => { attendeesPanel.hidden = true; });

(async function start() {
  if (!requireLoginPage()) return;
  try {
    me = await loadNav();
  } catch (err) {
    showMessage(message, err.message, 'error');
    return;
  }
  document.getElementById('organizer-panel').hidden = me.role !== 'organizer';
  if (me.role === 'organizer') {
    document.getElementById('lead').textContent = 'Create workshops, edit your own, and see who has registered.';
  }
  await loadWorkshops();
})();
