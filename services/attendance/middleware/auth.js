// Authentication shared with Nourhan's Registration Service.
// Verify the Supabase access token, then read the trusted role from public.profiles.
// Requires: npm install jose

const pool = require('../db/pool');

const projectUrl = process.env.SUPABASE_URL || 'https://lydhdtlxodhyqjhvcfdu.supabase.co';
const issuer = projectUrl.replace(/\/$/, '') + '/auth/v1';
let jwks;

async function requireLogin(req, res, next) {
  const authorization = req.get('Authorization') || '';
  const match = /^Bearer (\S+)$/i.exec(authorization);
  if (!match) {
    return res.status(401).json({ code: 'UNAUTHENTICATED', error: 'Log in and supply a Bearer access token.' });
  }

  let payload;
  try {
    // Dynamic import works with current versions of jose (ESM) on Node.js 22.
    const { createRemoteJWKSet, jwtVerify } = await import('jose');
    if (!jwks) jwks = createRemoteJWKSet(new URL(issuer + '/.well-known/jwks.json'));

    ({ payload } = await jwtVerify(match[1], jwks, {
      issuer,
      audience: 'authenticated'
    }));
    if (typeof payload.sub !== 'string') throw new Error('Missing subject');
  } catch (_) {
    return res.status(401).json({ code: 'UNAUTHENTICATED', error: 'Invalid or expired access token.' });
  }

  try {
    // This is the trusted source for organizer/attendee roles, not user_metadata.
    const { rows } = await pool.query(
      'SELECT role FROM public.profiles WHERE id = $1',
      [payload.sub]
    );
    if (rows.length === 0) {
      return res.status(401).json({ code: 'UNAUTHENTICATED', error: 'Account profile not found.' });
    }

    req.user = { userId: payload.sub, role: rows[0].role };
    next();
  } catch (error) {
    next(error);
  }
}

function requireOrganizer(req, res, next) {
  if (!req.user || req.user.role !== 'organizer') {
    return res.status(403).json({ code: 'FORBIDDEN', error: 'Only organizers may create sessions.' });
  }
  next();
}

module.exports = { requireLogin, requireOrganizer };
