// Manage certificates page (organizers): for each workshop I organize, list the certificates
// that were issued and revoke one with a reason. The backend checks that I am an organizer AND
// the organizer of that workshop (403 otherwise); hiding things here is only for convenience.

const message = document.getElementById('message');
const workshopList = document.getElementById('workshop-list');

function workshopCard(w) {
  const card = el('article', { className: 'workshop cert-manage' });
  const info = el('div');
  info.append(el('h3', {}, w.title));
  const body = el('div', { className: 'cert-manage-body' });
  const btn = el('button', {}, 'Show certificates');
  btn.addEventListener('click', () => loadCertificates(w, body, btn));
  info.append(body);
  const side = el('div', { className: 'side' });
  side.append(btn);
  card.append(dateBlock(w.date), info, side);
  return card;
}

async function loadCertificates(w, body, btn) {
  btn.disabled = true;
  body.replaceChildren(el('p', { className: 'cert-status' }, 'Loading...'));
  try {
    const { certificates } = await certApi(`/certificates/workshop/${encodeURIComponent(w.workshopId)}`);
    if (certificates.length === 0) {
      body.replaceChildren(el('p', { className: 'cert-status' }, 'No certificates issued for this workshop yet.'));
    } else {
      const table = el('table', { className: 'cert-table' });
      const head = el('tr');
      ['Attendee', 'Issued', 'Status', ''].forEach((h) => head.append(el('th', {}, h)));
      table.append(head, ...certificates.map((c) => certificateRow(c, w, body, btn)));
      body.replaceChildren(table);
    }
    btn.textContent = 'Refresh';
  } catch (err) {
    body.replaceChildren(el('p', { className: 'cert-status' }, err.message));
  } finally {
    btn.disabled = false;
  }
}

function certificateRow(c, w, body, btn) {
  const tr = el('tr');
  const status = el('td');
  const action = el('td');
  if (c.revokedAt) {
    status.append(el('span', { className: 'cert-badge revoked' }, 'Revoked'),
      el('span', { className: 'cert-reason' }, ` ${formatDate(c.revokedAt)}: ${c.revokeReason}`));
  } else {
    status.append(el('span', { className: 'cert-badge valid' }, 'Valid'));
    const revokeBtn = el('button', { className: 'danger' }, 'Revoke');
    revokeBtn.addEventListener('click', () => showRevokeForm(c, w, action, body, btn));
    action.append(revokeBtn);
  }
  tr.append(el('td', {}, c.attendeeName), el('td', {}, formatDate(c.issuedAt)), status, action);
  return tr;
}

// Inline form instead of a browser prompt(): the reason is required (3-200 characters).
function showRevokeForm(c, w, cell, body, btn) {
  const form = el('form', { className: 'revoke-form' });
  const input = el('input', { type: 'text', required: true, minLength: 3, maxLength: 200, placeholder: 'Reason (required)' });
  input.setAttribute('aria-label', `Reason for revoking ${c.attendeeName}'s certificate`);
  const confirmBtn = el('button', { type: 'submit', className: 'danger' }, 'Confirm revoke');
  const cancel = el('button', { type: 'button', className: 'link' }, 'Cancel');
  cancel.addEventListener('click', () => loadCertificates(w, body, btn));
  form.append(input, confirmBtn, cancel);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    confirmBtn.disabled = true;
    try {
      const r = await certApi(`/certificates/${encodeURIComponent(c.certificateId)}/revoke`, {
        method: 'PATCH',
        body: { reason: input.value.trim() },
      });
      showMessage(message, `${c.attendeeName}'s certificate for ${w.title} was revoked.` +
        (r.emailSent ? ' They have been emailed the reason.' : ' (The email to the attendee could not be sent.)'), 'success');
      await loadCertificates(w, body, btn);
    } catch (err) {
      showMessage(message, `Could not revoke: ${err.message}`, 'error');
      confirmBtn.disabled = false;
    }
  });
  cell.replaceChildren(form);
  input.focus();
}

// The navbar's "Certificates" link points to My certificates; on this page point it here instead
// (organizers who click it are redirected here anyway) and mark it as the current page.
function markCertificatesLink() {
  const link = [...document.querySelectorAll('#nav a')].find((a) => a.textContent.trim() === 'Certificates');
  if (!link) return;
  link.href = appUrl('certificate/manage.html');
  link.setAttribute('aria-current', 'page');
}

(async function start() {
  if (!requireLoginPage()) return;
  await loadNav().catch(() => null);
  markCertificatesLink();
  try {
    const me = await api(CONFIG.REGISTRATION_API, '/me');
    if (me.role !== 'organizer') {
      // Attendees have their own certificates page
      window.location.replace(appUrl('certificate/certificates.html'));
      return;
    }
    const all = await api(CONFIG.REGISTRATION_API, '/workshops');
    const mine = (Array.isArray(all) ? all : all.workshops || []).filter((w) => w.organizerId === me.userId);
    workshopList.replaceChildren(...(mine.length
      ? mine.map(workshopCard)
      : [el('p', { className: 'empty' }, 'You do not organize any workshops yet.')]));
  } catch (err) {
    workshopList.replaceChildren();
    showMessage(message, `Your workshops come from the Registration service, which cannot be reached right now (${err.message}).`, 'error');
  }
})();
