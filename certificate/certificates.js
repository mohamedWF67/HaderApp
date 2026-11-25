// My certificates page (attendees): list my certificates, download them as PDF,
// and generate a certificate for a workshop once every session has been attended.

const message = document.getElementById('message');
const certList = document.getElementById('certificate-list');
const eligibilityList = document.getElementById('eligibility-list');


// ---------- My certificates ----------
function certificateRow(c) {
  const row = el('article', { className: 'workshop' });

  const info = el('div');
  const code = el('p', { className: 'host' }, 'Verification code: ');
  code.append(el('code', { className: 'cert-code' }, c.verification_code));
  info.append(el('h3', {}, c.workshop_title), el('p', { className: 'host' }, `Awarded to ${c.attendee_name}`), code);

  const side = el('div', { className: 'side' });
  const download = el('button', {}, 'Download PDF');
  download.addEventListener('click', () => downloadCertificate(c, download));
  side.append(download, el('a', { href: verifyPageUrl(c.verification_code), className: 'cert-link' }, 'Public verification page'));

  row.append(dateBlock(c.issued_at), info, side);
  return row;
}

async function loadCertificates() {
  try {
    const { certificates } = await certApi('/certificates/me');
    if (certificates.length === 0) {
      certList.replaceChildren(el('p', { className: 'empty' }, 'You have no certificates yet.'));
      return [];
    }
    certList.replaceChildren(...certificates.map(certificateRow));
    return certificates;
  } catch (err) {
    certList.replaceChildren();
    showMessage(message, err.message, 'error');
    return [];
  }
}

// API Gateway may return the PDF as raw bytes or as base64 text, depending on its settings.
async function downloadCertificate(c, btn) {
  btn.disabled = true;
  try {
    const res = await certFetch(`/certificates/${encodeURIComponent(c.certificate_id)}`);
    let bytes = new Uint8Array(await res.arrayBuffer());
    const isPdf = bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46; // "%PDF"
    if (!isPdf) {
      const text = new TextDecoder().decode(bytes).trim();
      bytes = Uint8Array.from(atob(text), ch => ch.charCodeAt(0));
    }
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    const a = el('a', { href: url, download: `certificate-${c.workshop_title.replace(/[^\w-]+/g, '_')}.pdf` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  } catch (err) {
    showMessage(message, `Could not download the certificate: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
  }
}

// ---------- Get a certificate ----------
function eligibilityRow(r, issued) {
  const w = r.workshop || {};
  const workshopId = w.workshopId ?? r.workshopId;
  const row = el('article', { className: 'workshop' });

  const info = el('div');
  info.append(el('h3', {}, w.title || 'Workshop'));
  const status = el('p', { className: 'cert-status' }, 'Checking your attendance...');
  info.append(status);

  const side = el('div', { className: 'side' });
  row.append(dateBlock(w.date), info, side);

  if (issued.has(String(workshopId))) {
    status.textContent = 'Certificate issued. See "My certificates" above.';
    status.className = 'cert-status done';
  } else if (workshopId === undefined) {
    status.textContent = 'Workshop id missing, cannot check attendance.';
  } else {
    checkEligibility(workshopId, w.title, status, side);
  }
  return row;
}

async function checkEligibility(workshopId, title, status, side) {
  try {
    const e = await certApi(`/certificates/eligibility/${encodeURIComponent(workshopId)}`);
    if (e.totalSessions === 0) {
      status.textContent = 'No sessions have been added to this workshop yet.';
      return;
    }
    status.textContent = `You attended ${e.attendedSessions} of ${e.totalSessions} sessions.`;
    if (e.certificateId) {
      status.textContent += ' Certificate issued.';
      status.className = 'cert-status done';
    } else if (e.eligible) {
      const btn = el('button', {}, 'Generate certificate');
      btn.addEventListener('click', () => generateCertificate(workshopId, title, btn));
      side.append(btn);
    } else {
      status.textContent += ' You need to attend all of them to get a certificate.';
    }
  } catch (err) {
    status.textContent = err.status === 404
      ? 'No attendance record found for this workshop.'
      : 'Attendance cannot be checked right now. Try again later.';
  }
}

async function generateCertificate(workshopId, title, btn) {
  btn.disabled = true;
  showMessage(message, `Generating your certificate for ${title}...`, 'info');
  try {
    const c = await certApi('/certificates', { method: 'POST', body: { workshopId: Number(workshopId) } });
    showMessage(message, c.emailSent
      ? `Certificate created for ${title}. We also emailed you a link.`
      : `Certificate created for ${title}. You can download it below.`, 'success');
  } catch (err) {
    showMessage(message, err.status === 409 ? 'You already have a certificate for this workshop.' : err.message,
      err.status === 409 ? 'info' : 'error');
    btn.disabled = false;
  }
  await loadAll();
}

async function loadEligibility(certificates) {
  try {
    const regs = await api(CONFIG.REGISTRATION_API, '/registrations/me');
    if (regs.length === 0) {
      const empty = el('p', { className: 'empty' }, 'You have not registered for any workshops yet. ');
      empty.append(el('a', { href: appUrl('registration/workshops.html') }, 'Find a workshop'));
      eligibilityList.replaceChildren(empty);
      return;
    }
    const issued = new Set(certificates.map(c => String(c.workshop_id)));
    eligibilityList.replaceChildren(...regs.map(r => eligibilityRow(r, issued)));
  } catch (err) {
    eligibilityList.replaceChildren(el('p', { className: 'empty' },
      `Your workshops come from the Registration service, which cannot be reached from ${window.location.origin} right now.`));
  }
}

async function loadAll() {
  const certificates = await loadCertificates();
  await loadEligibility(certificates);
}

(async function start() {
  if (!requireLoginPage()) return;
  // Shared nav (same on every page). If the Registration API is down it still draws a
  // nav and returns the role from the token when known; the backend enforces roles anyway.
  const me = await loadNav();
  if (me.role && me.role !== 'attendee') {
    showMessage(message, 'Certificates are for attendees. Organizers can see their workshops on the Workshops page.', 'info');
    certList.replaceChildren();
    eligibilityList.replaceChildren();
    return;
  }
  await loadAll();
})();
