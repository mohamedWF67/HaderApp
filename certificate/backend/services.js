// Calls to the other two services (through their APIs, never their tables) and to Brevo.

const get = async (url, token) => {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(4000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return res.json();
};

// Attendance service (Mohamed Ahmed): expected { totalSessions, attendedSessions }
export async function getAttendance(workshopId, attendeeId, token) {
  return get(`${process.env.ATTENDANCE_API_URL}/workshops/${workshopId}/attendance/${attendeeId}`, token);
}

// Registration service (Nourhan): find the workshop in GET /workshops to get its title
export async function getWorkshop(workshopId, token) {
  const list = await get(`${process.env.REGISTRATION_API_URL}/workshops`, token);
  const items = Array.isArray(list) ? list : list?.workshops || [];
  return items.find((w) => String(w.workshopId ?? w.id) === String(workshopId)) || null;
}

// Brevo email (external API). A failed email never blocks the certificate.
export async function sendEmail(toEmail, toName, cert) {
  const certificateId = cert.certificate_id;
  if (!process.env.BREVO_API_KEY || !toEmail) {
    console.log(JSON.stringify({ event: 'email_skipped', certificateId, reason: !toEmail ? 'no email in login token' : 'BREVO_API_KEY not set' }));
    return false;
  }
  const verifyUrl = `${(process.env.FRONTEND_ORIGIN || '').split(',')[0].trim()}/certificate/verify.html?code=${cert.verification_code}`;
  try {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': process.env.BREVO_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sender: { email: process.env.BREVO_SENDER_EMAIL, name: 'Workshop Certificates' },
        to: [{ email: toEmail, name: toName }],
        subject: 'Your workshop certificate is ready',
        textContent:
          `Hello ${toName},\n\nYour certificate for "${cert.workshop_title}" is ready. ` +
          `Log in to download it.\n\nAnyone can verify it here: ${verifyUrl}`,
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      console.log(JSON.stringify({ event: 'email_sent', certificateId }));
      return true;
    }
    // Brevo explains failures in its JSON body (code + message). The API key is never logged.
    const body = await res.json().catch(() => ({}));
    console.log(JSON.stringify({ event: 'email_failed', certificateId, status: res.status, code: body.code, message: body.message }));
    return false;
  } catch (err) {
    console.log(JSON.stringify({ event: 'email_failed', certificateId, reason: err.name === 'TimeoutError' ? 'timeout' : err.message }));
    return false;
  }
}
