const API = 'https://YOUR_API_GATEWAY_URL'; // printed when the API is deployed
const token = localStorage.getItem('token'); // saved by the shared login page

const $ = (id) => document.getElementById(id);
const show = (text) => ($('message').textContent = text); // textContent, never innerHTML (XSS)

async function api(path, options = {}) {
  const res = await fetch(API + path, {
    ...options,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Error ${res.status}`);
  }
  return res;
}

async function loadList() {
  const { certificates } = await (await api('/certificates/me')).json();
  $('list').replaceChildren();
  if (!certificates.length) $('list').textContent = 'No certificates yet.';
  for (const c of certificates) {
    const row = document.createElement('div');
    row.className = 'card';
    row.textContent = `${c.workshop_title} - code ${c.verification_code} `;
    const btn = document.createElement('button');
    btn.textContent = 'Download PDF';
    btn.onclick = () => download(c.certificate_id);
    row.append(btn);
    $('list').append(row);
  }
}

async function download(id) {
  try {
    const blob = await (await api(`/certificates/${id}`)).blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'certificate.pdf';
    a.click();
  } catch (e) {
    show(e.message);
  }
}

async function checkWorkshop(workshopId) {
  try {
    const e = await (await api(`/certificates/eligibility/${encodeURIComponent(workshopId)}`)).json();
    $('eligibility').textContent = `You attended ${e.attendedSessions} of ${e.totalSessions} sessions. `;
    if (e.eligible && !e.certificateId) {
      const btn = document.createElement('button');
      btn.textContent = 'Generate certificate';
      btn.onclick = () => generate(workshopId);
      $('eligibility').append(btn);
    } else if (e.certificateId) {
      $('eligibility').append('You already have this certificate.');
    }
  } catch (e) {
    $('eligibility').textContent = e.message;
  }
}

async function generate(workshopId) {
  try {
    const c = await (await api('/certificates', { method: 'POST', body: JSON.stringify({ workshopId }) })).json();
    show(c.emailSent ? 'Certificate created and emailed to you.' : 'Certificate created.');
    $('eligibility').textContent = '';
    loadList();
  } catch (e) {
    show(e.message);
  }
}

$('check-form').onsubmit = (ev) => {
  ev.preventDefault();
  checkWorkshop($('workshop-id').value.trim());
};

if (!token) show('Please log in first.');
else loadList().catch((e) => show(e.message));
