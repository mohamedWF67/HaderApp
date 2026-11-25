// Certificate Service - Express app (Mohamed Waleed)
//
//   GET  /certificates/eligibility/:workshopId   attendee
//   POST /certificates   { "workshopId": "..." } attendee
//   GET  /certificates/me                        attendee
//   GET  /certificates/:id                       attendee who owns it  -> PDF
//   GET  /certificates/verify/:code              anyone (no login)
//
// Runs inside Lambda through index.js (serverless-http), or locally with server.js.

import crypto from 'node:crypto';
import express from 'express';
import { getUser, AuthError } from './auth.js';
import * as db from './db.js';
import { getAttendance, getWorkshop, sendEmail } from './services.js';
import { makePdf } from './pdf.js';

const ALLOWED_ORIGINS = (process.env.FRONTEND_ORIGIN || '').split(',').map((o) => o.trim()).filter(Boolean);

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const app = express();
app.disable('x-powered-by'); // don't advertise the framework
app.set('trust proxy', false); // the caller IP comes from API Gateway (req.sourceIp), not from headers

// ---------- CORS: echo the caller's origin only if it is on the list, never "*" ----------
app.use((req, res, next) => {
  const origin = req.headers.origin;
  res.set({
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    Vary: 'Origin',
  });
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

// ---------- rate limits (per caller IP, per minute) ----------
// Stricter on /verify (stops verification codes being guessed, threat 4) and on generating;
// a general limit on everything else (floods, threat 6). Values can be changed with env vars.
const LIMITS = {
  verify: Number(process.env.RATE_LIMIT_VERIFY || 10),
  generate: Number(process.env.RATE_LIMIT_GENERATE || 10),
  other: Number(process.env.RATE_LIMIT_OTHER || 60),
};

async function rateLimit(req, res, next) {
  const ip = req.sourceIp || req.socket?.remoteAddress || 'unknown';
  const route = req.method === 'GET' && req.path.startsWith('/certificates/verify/') ? 'verify'
    : req.method === 'POST' && req.path.replace(/\/$/, '') === '/certificates' ? 'generate' : 'other';
  let hits;
  try {
    hits = await db.countHit(`cert:${route}:${ip}`);
  } catch (err) {
    // If the counter cannot be reached, let the request through rather than block everyone.
    console.log(JSON.stringify({ event: 'rate_limit_error', message: err.message }));
    return next();
  }
  if (hits <= LIMITS[route]) return next();
  console.log(JSON.stringify({ event: 'rate_limited', route, ip, hits }));
  const retryAfter = 60 - new Date().getUTCSeconds();
  res.set('Retry-After', String(retryAfter));
  res.status(429).json({ error: `Too many requests. Try again in ${retryAfter} seconds.` });
}
app.use(rateLimit); // 429 before any other work

// ---------- auth middleware ----------
async function requireAttendee(req, res, next) {
  req.user = await getUser(req); // checks the Supabase login token (401 if missing/invalid)
  if (req.user.role !== 'attendee') {
    console.log(JSON.stringify({ event: 'role_denied', userId: req.user.userId, role: req.user.role || 'none' }));
    throw new ApiError(403, 'Only attendees can do this');
  }
  next();
}

// ---------- business logic ----------
async function checkEligibility(user, workshopId) {
  const a = await getAttendance(workshopId, user.userId, user.token);
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

const validWorkshopId = (id) => /^\d{1,9}$/.test(id); // workshop_id is int4

// ---------- routes ----------
const router = express.Router();

// Public: anyone can check a certificate code (only what is printed on it is returned)
router.get('/verify/:code', async (req, res) => {
  const { code } = req.params;
  const cert = /^[A-Za-z0-9_-]{20}$/.test(code) ? await db.findByCode(code) : null;
  if (!cert) {
    console.log(JSON.stringify({ event: 'certificate_verify_failed' }));
    throw new ApiError(404, 'No certificate matches this code');
  }
  res.json({ valid: true, attendeeName: cert.attendee_name, workshopTitle: cert.workshop_title, issuedAt: cert.issued_at });
});

// Everything below needs a logged-in attendee
router.use(requireAttendee);

router.get('/eligibility/:workshopId', async (req, res) => {
  if (!validWorkshopId(req.params.workshopId)) throw new ApiError(400, 'workshopId is not valid');
  res.json(await checkEligibility(req.user, req.params.workshopId));
});

router.post('/', async (req, res) => {
  const user = req.user;
  const workshopId = String(req.body?.workshopId ?? '');
  if (!validWorkshopId(workshopId)) throw new ApiError(400, 'workshopId is not valid');

  if (await db.findByAttendee(user.userId, workshopId)) {
    throw new ApiError(409, 'You already have a certificate for this workshop');
  }
  const e = await checkEligibility(user, workshopId);
  if (!e.eligible) {
    throw new ApiError(403, `You attended ${e.attendedSessions} of ${e.totalSessions} sessions; all are required`);
  }
  const workshop = await getWorkshop(workshopId, user.token);
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
  res.status(201).json({ ...cert, emailSent });
});

router.get('/me', async (req, res) => {
  res.json({ certificates: await db.listByAttendee(req.user.userId) });
});

router.get('/:id', async (req, res) => {
  const { id } = req.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new ApiError(404, 'Certificate not found');
  const cert = await db.findById(id);
  if (!cert) throw new ApiError(404, 'Certificate not found');
  if (cert.attendee_id !== req.user.userId) {
    console.log(JSON.stringify({ event: 'certificate_access_denied', certificateId: id, userId: req.user.userId }));
    throw new ApiError(403, 'This certificate belongs to another user'); // threat 3
  }
  console.log(JSON.stringify({ event: 'certificate_downloaded', certificateId: id, userId: req.user.userId }));
  res.set('Content-Disposition', 'attachment; filename="certificate.pdf"');
  res.type('application/pdf').send(Buffer.from(await makePdf(cert)));
});

// JSON bodies. Locally express.json() parses them; through Lambda, serverless-http hands
// Express the raw body as a Buffer, so it is parsed here (same 10 kB cap, 400 on bad JSON).
const MAX_BODY = 10 * 1024;
function lambdaBody(req, res, next) {
  if (!Buffer.isBuffer(req.body) && typeof req.body !== 'string') return next();
  const raw = req.body.toString('utf8');
  if (Buffer.byteLength(raw) > MAX_BODY) return next(new ApiError(413, 'Request body is too large'));
  if (raw.trim() === '') { req.body = undefined; return next(); }
  try { req.body = JSON.parse(raw); } catch { return next(new ApiError(400, 'Body must be JSON')); }
  next();
}

app.use('/certificates', express.json({ limit: '10kb' }), lambdaBody, router);

// ---------- 404 + errors (Express 5 passes async errors here automatically) ----------
app.use((req, res) => res.status(404).json({ error: 'Route not found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof AuthError) return res.status(401).json({ error: err.message });
  if (err instanceof ApiError) return res.status(err.status).json({ error: err.message });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Body must be JSON' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request body is too large' });
  console.error(JSON.stringify({ event: 'error', message: err.message }));
  res.status(500).json({ error: 'Something went wrong' }); // never leak internal details
});

export default app;
