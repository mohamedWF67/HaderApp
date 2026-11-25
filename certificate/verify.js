// Public verification page: anyone can check that a certificate is genuine by its code.
// Only what is printed on the certificate is shown (the backend returns nothing else).

const CODE_PATTERN = /^[A-Za-z0-9_-]{20}$/;
const form = document.getElementById('verify-form');
const input = document.getElementById('code');
const message = document.getElementById('message');
const result = document.getElementById('result');
const rows = document.getElementById('result-rows');

function detailRow(label, value) {
  const tr = el('tr');
  tr.append(el('th', {}, label), el('td', {}, value));
  return tr;
}

async function verify(code) {
  result.hidden = true;
  if (!CODE_PATTERN.test(code)) {
    showMessage(message, 'A verification code is exactly 20 characters: letters, numbers, - or _.', 'error');
    return;
  }
  showMessage(message, 'Checking...', 'info');
  try {
    const c = await certApi(`/certificates/verify/${encodeURIComponent(code)}`, { auth: false });
    if (c.revoked) {
      showMessage(message, 'This certificate was issued by Hader but has been REVOKED by the workshop organizer. It is no longer valid.', 'error');
    } else {
      showMessage(message, 'This certificate is genuine.', 'success');
    }
    rows.replaceChildren(
      detailRow('Status', c.revoked ? `Revoked on ${formatDate(c.revokedAt)}` : 'Valid'),
      detailRow('Awarded to', c.attendeeName),
      detailRow('Workshop', c.workshopTitle),
      detailRow('Issued', formatDate(c.issuedAt)),
      detailRow('Verification code', code)
    );
    result.hidden = false;
  } catch (err) {
    if (err.status === 404) showMessage(message, 'No certificate matches this code. It may be fake or mistyped.', 'error');
    else if (err.status === 429) showMessage(message, 'Too many checks in a short time. Wait a moment and try again.', 'error');
    else showMessage(message, err.message, 'error');
  }
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const code = input.value.trim();
  history.replaceState(null, '', `?code=${encodeURIComponent(code)}`); // shareable link
  verify(code);
});

// Links on the PDF and in emails look like verify.html?code=XXXX
const fromLink = new URLSearchParams(window.location.search).get('code');
if (fromLink) {
  input.value = fromLink.trim();
  verify(input.value);
}

// Shared nav: full menu when logged in, otherwise Verify + Log in.
loadPublicNav();
