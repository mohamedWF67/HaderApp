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