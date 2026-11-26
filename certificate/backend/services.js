import { verifyUrl } from './pdf.js';

// Calls to the other two services (through their APIs, never their tables) and to Brevo.

// Another service being down, slow or failing is not this service's fault: answer 503
// ("try again later") naming the service, instead of a vague 500. 404 = "not found" (normal).
export class UpstreamError extends Error {
  constructor(service, reason) {
    super(`The ${service} service is unavailable right now. Please try again in a moment.`);
    this.service = service;
    this.reason = reason;
  }
}

const get = async (service, url, token) => {
  let res;
  try {
    res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(6000) });
  } catch (err) {
    throw new UpstreamError(service, err.name === 'TimeoutError' ? 'timeout after 6 s' : err.message);
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new UpstreamError(service, `returned ${res.status}`);
  return res.json();
};

// Attendance service (Mohamed Ahmed): expected { totalSessions, attendedSessions }
export async function getAttendance(workshopId, attendeeId, token) {
  return get('Attendance', `${process.env.ATTENDANCE_API_URL}/workshops/${workshopId}/attendance/${attendeeId}`, token);
}

// Registration service (Nourhan): find the workshop in GET /workshops to get its title
export async function getWorkshop(workshopId, token) {
  const list = await get('Registration', `${process.env.REGISTRATION_API_URL}/workshops`, token);
  const items = Array.isArray(list) ? list : list?.workshops || [];
  return items.find((w) => String(w.workshopId ?? w.id) === String(workshopId)) || null;
}

// ---------- Brevo email (external API) ----------
// A failed email never blocks the action it reports on. The API key is never logged.
const frontendUrl = () => (process.env.FRONTEND_ORIGIN || '').split(',')[0].trim();

async function sendBrevo(kind, certificateId, toEmail, toName, subject, textContent) {
  if (!process.env.BREVO_API_KEY || !toEmail) {
    console.log(JSON.stringify({ event: 'email_skipped', kind, certificateId, reason: !toEmail ? 'no email address' : 'BREVO_API_KEY not set' }));
    return false;
  }
  try {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': process.env.BREVO_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sender: { email: process.env.BREVO_SENDER_EMAIL, name: 'Workshop Certificates' },
        to: [{ email: toEmail, name: toName }],
        subject,
        textContent,
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      console.log(JSON.stringify({ event: 'email_sent', kind, certificateId }));
      return true;
    }
    // Brevo explains failures in its JSON body (code + message).
    const body = await res.json().catch(() => ({}));
    console.log(JSON.stringify({ event: 'email_failed', kind, certificateId, status: res.status, code: body.code, message: body.message }));
    return false;
  } catch (err) {
    console.log(JSON.stringify({ event: 'email_failed', kind, certificateId, reason: err.name === 'TimeoutError' ? 'timeout' : err.message }));
    return false;
  }
}

// Certificate issued -> tell the attendee, with the public verification link.
export function sendEmail(toEmail, toName, cert) {
  const url = verifyUrl(cert.verification_code); // same link as on the PDF and its QR code
  return sendBrevo('issued', cert.certificate_id, toEmail, toName,
    'Your workshop certificate is ready',
    `Hello ${toName},\n\nYour certificate for "${cert.workshop_title}" is ready. ` +
    `Log in to download it.\n\nAnyone can verify it here: ${url}`);
}

// Certificate revoked by the workshop's organizer -> tell the attendee why.
export function sendRevokedEmail(toEmail, cert, reason) {
  const name = cert.attendee_name;
  return sendBrevo('revoked', cert.certificate_id, toEmail, name,
    'Your workshop certificate was revoked',
    `Hello ${name},\n\nYour certificate for "${cert.workshop_title}" has been revoked by the workshop's organizer ` +
    `and is no longer valid. The public verification page now shows it as revoked.\n\n` +
    `Reason given: ${reason}\n\n` +
    `If you think this is a mistake, please contact the workshop's organizer.\n\n` +
    `Your certificates: ${frontendUrl()}/certificate/certificates.html`);
}
