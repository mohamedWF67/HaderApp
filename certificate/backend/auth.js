// Checks the Supabase Auth login token and returns who is calling.
//
// 1. The token's signature is checked against Supabase's public keys (forged or edited -> 401).
// 2. The user's role (attendee / organizer) and name are then read from the team's
//    public.profiles table, using the user id (sub) from the verified token.
//    Sign-up creates every profile as an attendee; organizers are set by the team.
//    Users cannot change their own role (no UPDATE on profiles.role for anon/authenticated),
//    and the role is NEVER taken from the request or from user_metadata (threat 2).

import { createRemoteJWKSet, jwtVerify } from 'jose';
import { getProfile } from './db.js';

const SUPABASE_URL = process.env.SUPABASE_URL; // e.g. https://abcdefghijklmnop.supabase.co
const ISSUER = `${SUPABASE_URL}/auth/v1`;

// New Supabase projects sign tokens with asymmetric keys -> check against the public keys (JWKS).
// Older projects use the legacy shared JWT secret -> set SUPABASE_JWT_SECRET instead.
const key = process.env.SUPABASE_JWT_SECRET
  ? new TextEncoder().encode(process.env.SUPABASE_JWT_SECRET)
  : createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks.json`));

export class AuthError extends Error {}

// req = the Express request (headers are lower-case there)
export async function getUser(req) {
  const header = req.headers?.authorization || '';
  const token = header.replace(/^Bearer /, '');
  if (!token) {
    console.log(JSON.stringify({ event: 'auth_missing' }));
    throw new AuthError('Please log in');
  }

  let claims;
  try {
    ({ payload: claims } = await jwtVerify(token, key, { issuer: ISSUER, audience: 'authenticated' }));
  } catch (err) {
    // Log only the reason code (e.g. ERR_JWT_EXPIRED), never the token itself
    console.log(JSON.stringify({ event: 'auth_failed', reason: err.code || err.message }));
    throw new AuthError('Invalid or expired login, please log in again');
  }

  const profile = await getProfile(claims.sub); // null if the user has no profile
  return {
    userId: claims.sub,
    email: claims.email,
    name: profile?.name || claims.email,
    role: profile?.role || null, // "attendee" or "organizer"; null -> refused with 403
    token,
  };
}
