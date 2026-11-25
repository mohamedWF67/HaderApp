// Login and role checks using Supabase Auth.
//
// 1. The browser logs in with Supabase Auth and gets an access token (a JWT).
// 2. It sends the token with every request:  Authorization: Bearer <token>
// 3. We check the token's signature here -> 401 if missing, invalid or expired.
// 4. We read the user's ROLE from our own profiles table, never from the token
//    or the request body, so a user cannot make themselves an organizer.
const { jwtVerify, createRemoteJWKSet } = require('jose');
const pool = require('../db/pool');
const { ApiError } = require('./errors');

// Supabase signs tokens either with signing keys (published at a JWKS address)
// or, on older projects, with one shared secret. We support both.
let jwks = null;
function getKey() {
  if (process.env.SUPABASE_JWT_SECRET) {
    return new TextEncoder().encode(process.env.SUPABASE_JWT_SECRET);
  }
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${process.env.SUPABASE_URL}/auth/v1/.well-known/jwks.json`));
  }
  return jwks;
}

async function requireLogin(req, res, next) {
  const header = req.get('Authorization') || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return next(new ApiError(401, 'UNAUTHENTICATED', 'Please log in first.'));
  }

  let payload;
  try {
    ({ payload } = await jwtVerify(token, getKey(), {
      issuer: `${process.env.SUPABASE_URL}/auth/v1`,
      audience: 'authenticated'
    }));
  } catch (e) {
    return next(new ApiError(401, 'UNAUTHENTICATED', 'Your login has expired or is invalid. Please log in again.'));
  }

  try {
    const { rows } = await pool.query('SELECT role FROM public.profiles WHERE id = $1', [payload.sub]);
    if (rows.length === 0) {
      return next(new ApiError(401, 'UNAUTHENTICATED', 'No profile found for this account.'));
    }
    req.user = { userId: payload.sub, role: rows[0].role };
    next();
  } catch (e) {
    next(e);
  }
}

// 403 if the logged-in user does not have one of the allowed roles.
function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return next(new ApiError(403, 'FORBIDDEN', 'You are not allowed to do this.'));
    }
    next();
  };
}

module.exports = { requireLogin, requireRole };
