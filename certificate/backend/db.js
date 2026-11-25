import pg from 'pg';
import { readFileSync } from 'node:fs';

// TLS to Supabase (proposal 6.2: "Lambda connects to it only over TLS").
// certs/prod-ca-2021.crt is Supabase's public root certificate (not a secret). With it the
// connection is encrypted AND the server's identity is checked, so a fake server cannot
// pretend to be Supabase. The same file is used by the Registration and Attendance services.
function sslOptions() {
  try {
    const ca = readFileSync(new URL('./certs/prod-ca-2021.crt', import.meta.url), 'utf8');
    return { ca, rejectUnauthorized: true };
  } catch {
    console.log(JSON.stringify({ event: 'db_tls_unverified', reason: 'CA file missing from the package' }));
    return { rejectUnauthorized: false }; // still encrypted, but the server is not verified
  }
}

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: sslOptions(),
  max: 1,
});

const one = async (sql, params) => (await pool.query(sql, params)).rows[0] || null;

// The user's role and name, from the team's profiles table (filled by the sign-up trigger).
// certificate_service may only read the id, name and role columns of profiles.
export const getProfile = (userId) => one('SELECT name, role FROM public.profiles WHERE id = $1', [userId]);

// Certificates joined with their registration, so workshop_id and attendee_id are still available
const SELECT = `SELECT c.*, r.workshop_id, r.attendee_id
                FROM certificates c
                JOIN registrations r ON r.registration_id = c.registration_id`;

export const findById = (id) => one(`${SELECT} WHERE c.certificate_id = $1`, [id]);

export const findByCode = (code) => one(`${SELECT} WHERE c.verification_code = $1`, [code]);

export const findByAttendee = (attendeeId, workshopId) =>
  one(`${SELECT} WHERE r.attendee_id = $1 AND r.workshop_id = $2`, [attendeeId, workshopId]);

export const listByAttendee = async (attendeeId) =>
  (await pool.query(`${SELECT} WHERE r.attendee_id = $1 ORDER BY c.issued_at DESC`, [attendeeId])).rows;

// Looks up the attendee's registration and inserts in one statement.
// Returns null if they aren't registered or already have a certificate.
export const insert = (c) =>
  one(
    `INSERT INTO certificates (certificate_id, registration_id, attendee_name, workshop_title, verification_code)
     SELECT $1, r.registration_id, $4, $5, $6
     FROM registrations r
     WHERE r.workshop_id = $2 AND r.attendee_id = $3
     ON CONFLICT (registration_id) DO NOTHING
     RETURNING *`,
    [c.certificateId, c.workshopId, c.attendeeId, c.attendeeName, c.workshopTitle, c.verificationCode]
  );

// All certificates of one workshop (the organizer's view), newest first.
export const listByWorkshop = async (workshopId) =>
  (await pool.query(`${SELECT} WHERE r.workshop_id = $1 ORDER BY c.issued_at DESC`, [workshopId])).rows;

// Revoke = the only UPDATE this service makes. "AND revoked_at IS NULL" means a certificate can be
// revoked once and never un-revoked; the database policy enforces the same rule (revoke.sql).
// Returns null if it was already revoked.
export const revoke = (certificateId, organizerId, reason) =>
  one(
    `UPDATE certificates
     SET revoked_at = now(), revoked_by = $2, revoke_reason = $3
     WHERE certificate_id = $1 AND revoked_at IS NULL
     RETURNING certificate_id, revoked_at, revoke_reason`,
    [certificateId, organizerId, reason]
  );

// The attendee's email, only for a certificate that is already revoked (see revoke.sql).
export const getRevokedEmail = async (certificateId) =>
  (await one('SELECT public.revoked_certificate_email($1) AS email', [certificateId]))?.email || null;

// ---------- Rate limiting (proposal 6.2, threats 4 and 6) ----------
// Counts requests per caller and route in the current minute. Stored in the database so the
// limit holds across every copy of the Lambda (API Gateway throttling is not enforced on Floci).
// Returns the number of hits in this minute, including this one.
export async function countHit(bucket) {
  const { rows } = await pool.query(
    `INSERT INTO public.certificate_rate_limits (bucket, window_start, hits)
     VALUES ($1, date_trunc('minute', now()), 1)
     ON CONFLICT (bucket, window_start) DO UPDATE SET hits = certificate_rate_limits.hits + 1
     RETURNING hits`,
    [bucket]
  );
  // Now and then, remove counters older than 10 minutes so the table stays tiny.
  if (Math.random() < 0.02) {
    pool.query("DELETE FROM public.certificate_rate_limits WHERE window_start < now() - interval '10 minutes'").catch(() => {});
  }
  return rows[0].hits;
}
