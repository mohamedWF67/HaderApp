// Certificate Service - Lambda entry point (Mohamed Waleed)
//
//   GET  /certificates/eligibility/{workshopId}   attendee
//   POST /certificates   { "workshopId": "..." } attendee
//   GET  /certificates/me                         attendee
//   GET  /certificates/{id}                       attendee who owns it  -> PDF
//   GET  /certificates/verify/{code}              anyone (no login)

import crypto from 'node:crypto';
import { getUser, AuthError } from './auth.js';
import * as db from './db.js';
import { getAttendance, getWorkshop, sendEmail } from './services.js';
import { makePdf } from './pdf.js';

const ORIGIN = process.env.FRONTEND_ORIGIN; // your Vercel URL, never "*"

// ---------- small helpers ----------
const headers = {
  'Access-Control-Allow-Origin': ORIGIN,
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
};

const reply = (status, body) => ({
  statusCode: status,
  headers: { ...headers, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function mustBeAttendee(user) {
  if (user.role !== 'attendee') {
    console.log(JSON.stringify({ event: 'role_denied', userId: user.userId, role: user.role || 'none' }));
    throw new ApiError(403, 'Only attendees can do this');
  }
}

// ---------- the five actions ----------
async function checkEligibility(user, workshopId, token) {
  const a = await getAttendance(workshopId, user.userId, token);
  if (!a) throw new ApiError(404, 'Workshop not found or you are not registered');
  const existing = await db.findByAttendee(user.userId, workshopId);
  return {
    workshopId,
    totalSessions: a.totalSessions,
    attendedSessions: a.attendedSessions,
    eligible: a.totalSessions > 0 && a.attendedSessions >= a.totalSessions,
    certificateId: existing?.certificate_id || null,
  };
}

async function generate(user, workshopId, token) {
  if (await db.findByAttendee(user.userId, workshopId)) {
    throw new ApiError(409, 'You already have a certificate for this workshop');
  }
  const e = await checkEligibility(user, workshopId, token);
  if (!e.eligible) {
    throw new ApiError(403, `You attended ${e.attendedSessions} of ${e.totalSessions} sessions; all are required`);
  }
  const workshop = await getWorkshop(workshopId, token);
  if (!workshop) throw new ApiError(404, 'Workshop not found');

  const cert = await db.insert({
    certificateId: crypto.randomUUID(), // hard to guess (threat 3)
    workshopId,
    attendeeId: user.userId,
    attendeeName: user.name,
    workshopTitle: workshop.title,
    verificationCode: crypto.randomBytes(15).toString('base64url'), // 20 chars, hard to guess (threat 4)
  });
  if (!cert) throw new ApiError(409, 'You already have a certificate for this workshop'); // two clicks at once

  console.log(JSON.stringify({ event: 'certificate_issued', certificateId: cert.certificate_id, userId: user.userId }));
  const emailSent = await sendEmail(user.email, user.name, cert);
  return { ...cert, emailSent };
}

async function download(user, id) {
  const cert = await db.findById(id);
  if (!cert) throw new ApiError(404, 'Certificate not found');
  if (cert.attendee_id !== user.userId) {
    console.log(JSON.stringify({ event: 'certificate_access_denied', certificateId: id, userId: user.userId }));
    throw new ApiError(403, 'This certificate belongs to another user'); // threat 3
  }
  console.log(JSON.stringify({ event: 'certificate_downloaded', certificateId: id, userId: user.userId }));
  return {
    statusCode: 200,
    headers: { ...headers, 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="certificate.pdf"' },
    body: Buffer.from(await makePdf(cert)).toString('base64'),
    isBase64Encoded: true,
  };
}

async function verify(code) {
  const cert = /^[A-Za-z0-9_-]{20}$/.test(code) ? await db.findByCode(code) : null;
  if (!cert) {
    console.log(JSON.stringify({ event: 'certificate_verify_failed' }));
    throw new ApiError(404, 'No certificate matches this code');
  }
  // Public: only what is printed on the certificate
  return { valid: true, attendeeName: cert.attendee_name, workshopTitle: cert.workshop_title, issuedAt: cert.issued_at };
}

// ---------- router ----------
export async function handler(event) {
  const method = event.requestContext?.http?.method || event.httpMethod;
  const path = (event.rawPath || event.path || '').replace(/^.*(?=\/certificates)/, ''); // drop stage prefix
  const parts = path.split('/').filter(Boolean); // e.g. ["certificates", "verify", "abc"]

  try {
    if (method === 'OPTIONS') return { statusCode: 204, headers, body: '' };

    if (method === 'GET' && parts[1] === 'verify') return reply(200, await verify(parts[2] || ''));

    const user = await getUser(event); // checks the Supabase login token
    mustBeAttendee(user);
    const token = user.token; // passed on to the Attendance and Registration services

    if (method === 'GET' && parts[1] === 'eligibility') {
      return reply(200, await checkEligibility(user, parts[2], token));
    }
    if (method === 'POST' && parts.length === 1) {
      const workshopId = String(JSON.parse(event.body || '{}').workshopId || '');
      if (!/^\d{1,9}$/.test(workshopId)) throw new ApiError(400, 'workshopId is not valid'); // workshop_id is int4
      return reply(201, await generate(user, workshopId, token));
    }
    if (method === 'GET' && parts[1] === 'me') {
      return reply(200, { certificates: await db.listByAttendee(user.userId) });
    }
    if (method === 'GET' && parts.length === 2) {
      if (!/^[0-9a-f-]{36}$/i.test(parts[1])) throw new ApiError(404, 'Certificate not found');
      return await download(user, parts[1]);
    }
    throw new ApiError(404, 'Route not found');
  } catch (err) {
    if (err instanceof AuthError) return reply(401, { error: err.message });
    if (err instanceof SyntaxError) return reply(400, { error: 'Body must be JSON' });
    if (err instanceof ApiError) return reply(err.status, { error: err.message });
    console.error(JSON.stringify({ event: 'error', message: err.message }));
    return reply(500, { error: 'Something went wrong' }); // never leak internal details
  }
}
