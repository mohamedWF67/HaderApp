// The waiting list: when a workshop is full, attendees can queue for a seat.
// When a seat is freed (someone cancels, or the organizer adds seats), the first
// person in the queue gets it automatically, inside the same transaction.
const pool = require('../db/pool');
const { ApiError } = require('../middleware/errors');
const { notify } = require('./notificationService');

// Give free seats to the people at the front of the queue.
// Must be called inside a transaction that already holds the workshop row lock
// (SELECT ... FOR UPDATE), so nobody else can take the seat at the same moment.
// Returns the list of attendees who got a seat.
async function promoteFromWaitlist(client, workshopId) {
  const promoted = [];
  for (;;) {
    const { rows: w } = await client.query(
      'SELECT seats_left, workshop_date, title FROM public.workshops WHERE workshop_id = $1',
      [workshopId]
    );
    if (w.length === 0 || w[0].seats_left <= 0) break;
    if (new Date(w[0].workshop_date) <= new Date()) break; // too late to give out seats

    // First in line = earliest join time (ties broken by id).
    const { rows: next } = await client.query(
      `SELECT waitlist_id, attendee_id FROM public.waitlist
       WHERE workshop_id = $1
       ORDER BY joined_at ASC, waitlist_id ASC
       LIMIT 1`,
      [workshopId]
    );
    if (next.length === 0) break;

    const { rows: reg } = await client.query(
      `INSERT INTO public.registrations (workshop_id, attendee_id)
       VALUES ($1, $2)
       RETURNING registration_id`,
      [workshopId, next[0].attendee_id]
    );
    await client.query('DELETE FROM public.waitlist WHERE waitlist_id = $1', [next[0].waitlist_id]);
    await client.query(
      'UPDATE public.workshops SET seats_left = seats_left - 1 WHERE workshop_id = $1',
      [workshopId]
    );
    await notify(client, next[0].attendee_id, workshopId, 'waitlist_promoted',
      `Good news: a seat in "${w[0].title}" became free, and it is now yours. You are registered.`);
    promoted.push({ attendeeId: next[0].attendee_id, registrationId: reg[0].registration_id });
    console.log(JSON.stringify({
      event: 'waitlist_promoted', workshopId,
      registrationId: reg[0].registration_id, userId: next[0].attendee_id
    }));
  }
  return promoted;
}

// Join the queue for a FULL workshop.
async function join(workshopId, attendeeId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Lock the workshop so "is it full?" cannot change while we decide.
    const { rows } = await client.query(
      'SELECT workshop_date, seats_left, registration_deadline FROM public.workshops WHERE workshop_id = $1 FOR UPDATE',
      [workshopId]
    );
    if (rows.length === 0) throw new ApiError(404, 'NOT_FOUND', 'Workshop not found.');
    if (new Date(rows[0].workshop_date) <= new Date()) {
      throw new ApiError(400, 'WORKSHOP_STARTED', 'This workshop has already started.');
    }
    if (rows[0].registration_deadline && new Date(rows[0].registration_deadline) <= new Date()) {
      throw new ApiError(400, 'REGISTRATION_CLOSED', 'Registration for this workshop has closed.');
    }
    if (rows[0].seats_left > 0) {
      throw new ApiError(409, 'SEATS_AVAILABLE', 'This workshop still has free seats. Register instead.');
    }
    const reg = await client.query(
      'SELECT 1 FROM public.registrations WHERE workshop_id = $1 AND attendee_id = $2',
      [workshopId, attendeeId]
    );
    if (reg.rows.length > 0) {
      throw new ApiError(409, 'ALREADY_REGISTERED', 'You are already registered for this workshop.');
    }

    const { rows: created } = await client.query(
      `INSERT INTO public.waitlist (workshop_id, attendee_id)
       VALUES ($1, $2)
       RETURNING waitlist_id, workshop_id, attendee_id, joined_at`,
      [workshopId, attendeeId]
    );
    const position = await positionOf(client, created[0].waitlist_id);
    await client.query('COMMIT');
    return {
      waitlistId: created[0].waitlist_id,
      workshopId: created[0].workshop_id,
      attendeeId: created[0].attendee_id,
      joinedAt: created[0].joined_at,
      position
    };
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') { // UNIQUE (workshop_id, attendee_id)
      throw new ApiError(409, 'ALREADY_WAITING', 'You are already on the waiting list for this workshop.');
    }
    throw err;
  } finally {
    client.release();
  }
}

// Leave the queue. Only the attendee who joined can remove their own entry.
async function leave(waitlistId, attendeeId) {
  const { rows } = await pool.query(
    'SELECT workshop_id, attendee_id FROM public.waitlist WHERE waitlist_id = $1',
    [waitlistId]
  );
  if (rows.length === 0) throw new ApiError(404, 'NOT_FOUND', 'Waiting list entry not found.');
  if (rows[0].attendee_id !== attendeeId) {
    throw new ApiError(403, 'FORBIDDEN', 'You can only leave your own place in the queue.');
  }
  await pool.query('DELETE FROM public.waitlist WHERE waitlist_id = $1', [waitlistId]);
  return { waitlistId, workshopId: rows[0].workshop_id, status: 'left' };
}

// My places in queues, with my position (1 = next to get a seat).
async function listMine(attendeeId) {
  const { rows } = await pool.query(
    `SELECT q.waitlist_id, q.joined_at, w.workshop_id, w.title, w.workshop_date,
            (SELECT COUNT(*)::int FROM public.waitlist q2
              WHERE q2.workshop_id = q.workshop_id
                AND (q2.joined_at, q2.waitlist_id) <= (q.joined_at, q.waitlist_id)) AS position
     FROM public.waitlist q
     JOIN public.workshops w ON w.workshop_id = q.workshop_id
     WHERE q.attendee_id = $1
     ORDER BY w.workshop_date ASC`,
    [attendeeId]
  );
  return rows.map(r => ({
    waitlistId: r.waitlist_id,
    joinedAt: r.joined_at,
    position: r.position,
    workshop: { workshopId: r.workshop_id, title: r.title, date: r.workshop_date }
  }));
}

async function positionOf(client, waitlistId) {
  const { rows } = await client.query(
    `SELECT COUNT(*)::int AS position FROM public.waitlist q2, public.waitlist q
     WHERE q.waitlist_id = $1 AND q2.workshop_id = q.workshop_id
       AND (q2.joined_at, q2.waitlist_id) <= (q.joined_at, q.waitlist_id)`,
    [waitlistId]
  );
  return rows[0].position;
}

module.exports = { promoteFromWaitlist, join, leave, listMine };
