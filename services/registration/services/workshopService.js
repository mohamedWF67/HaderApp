// Database work for workshops. Every query uses placeholders ($1, $2 ...),
// never text built from user input, so SQL injection is not possible.
const pool = require('../db/pool');
const { ApiError } = require('../middleware/errors');
const { promoteFromWaitlist } = require('./waitlistService');
const { notify } = require('./notificationService');

// Turns a database row into the JSON shape in the API contract.
function toWorkshop(row) {
  return {
    workshopId: row.workshop_id,
    title: row.title,
    description: row.description,
    date: row.workshop_date,
    registrationDeadline: row.registration_deadline,
    totalSeats: row.total_seats,
    seatsLeft: row.seats_left,
    organizerId: row.organizer_id,
    organizerName: row.organizer_name,
    waitingCount: row.waiting_count || 0,
    createdAt: row.created_at
  };
}

async function createWorkshop(organizerId, w) {
  const { rows } = await pool.query(
    `INSERT INTO public.workshops (title, description, workshop_date, total_seats, seats_left, organizer_id, registration_deadline)
     VALUES ($1, $2, $3, $4, $4, $5, $6)
     RETURNING *`,
    [w.title, w.description, w.date, w.totalSeats, organizerId, w.registrationDeadline]
  );
  return toWorkshop(rows[0]);
}

async function listWorkshops() {
  const { rows } = await pool.query(
    `SELECT w.*, p.name AS organizer_name,
            (SELECT COUNT(*)::int FROM public.waitlist q WHERE q.workshop_id = w.workshop_id) AS waiting_count
     FROM public.workshops w
     JOIN public.profiles p ON p.id = w.organizer_id
     ORDER BY w.workshop_date ASC`
  );
  return rows.map(toWorkshop);
}

// Edit a workshop. Only its organizer may do this, and the new seat total
// cannot be lower than the number of people already registered.
async function updateWorkshop(workshopId, organizerId, w) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // FOR UPDATE locks this workshop row so no registration can sneak in mid-edit.
    const { rows } = await client.query(
      'SELECT * FROM public.workshops WHERE workshop_id = $1 FOR UPDATE',
      [workshopId]
    );
    if (rows.length === 0) throw new ApiError(404, 'NOT_FOUND', 'Workshop not found.');
    const current = rows[0];
    if (current.organizer_id !== organizerId) {
      throw new ApiError(403, 'FORBIDDEN', 'Only the organizer who created this workshop can edit it.');
    }

    const registered = current.total_seats - current.seats_left;
    if (w.totalSeats < registered) {
      throw new ApiError(409, 'SEATS_BELOW_REGISTERED',
        `${registered} people are already registered, so totalSeats cannot be lower than ${registered}.`);
    }

    const { rows: updated } = await client.query(
      `UPDATE public.workshops
       SET title = $1, description = $2, workshop_date = $3,
           total_seats = $4::int, seats_left = $4::int - $5::int,
           registration_deadline = $7
       WHERE workshop_id = $6
       RETURNING *`,
      [w.title, w.description, w.date, w.totalSeats, registered, workshopId, w.registrationDeadline]
    );
    // If the organizer added seats, people waiting in the queue get them now.
    const promoted = await promoteFromWaitlist(client, workshopId);
    let result = updated[0];
    if (promoted.length > 0) {
      ({ rows: [result] } = await client.query(
        'SELECT * FROM public.workshops WHERE workshop_id = $1', [workshopId]
      ));
    }
    await client.query('COMMIT');
    return { ...toWorkshop(result), promotedFromWaitlist: promoted.length };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Delete a workshop. Only its organizer may do this, and only BEFORE it starts:
// after that, attendance and certificates depend on it, so it must stay as a record.
// Its registrations and waiting list are removed with it (ON DELETE CASCADE).
async function deleteWorkshop(workshopId, organizerId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'SELECT organizer_id, workshop_date, total_seats, seats_left, title FROM public.workshops WHERE workshop_id = $1 FOR UPDATE',
      [workshopId]
    );
    if (rows.length === 0) throw new ApiError(404, 'NOT_FOUND', 'Workshop not found.');
    const w = rows[0];
    if (w.organizer_id !== organizerId) {
      throw new ApiError(403, 'FORBIDDEN', 'Only the organizer who created this workshop can delete it.');
    }
    if (new Date(w.workshop_date) <= new Date()) {
      throw new ApiError(409, 'WORKSHOP_STARTED', 'This workshop has already started, so it is kept as a record and cannot be deleted.');
    }

    // Tell everyone with a seat or a place in the queue, in the same transaction.
    const { rows: people } = await client.query(
      `SELECT attendee_id, 'registered' AS kind FROM public.registrations WHERE workshop_id = $1
       UNION ALL
       SELECT attendee_id, 'waiting' AS kind FROM public.waitlist WHERE workshop_id = $1`,
      [workshopId]
    );
    for (const p of people) {
      await notify(client, p.attendee_id, workshopId, 'workshop_deleted',
        p.kind === 'registered'
          ? `"${w.title}" was cancelled by the organizer, so your registration was removed.`
          : `"${w.title}" was cancelled by the organizer, so your place in its waiting list was removed.`);
    }

    await client.query('DELETE FROM public.workshops WHERE workshop_id = $1', [workshopId]);
    await client.query('COMMIT');
    return { workshopId, status: 'deleted', registrationsRemoved: w.total_seats - w.seats_left };
  } catch (err) {
    await client.query('ROLLBACK');
    // Another service's table (sessions, attendance, certificates) still points at
    // this workshop and does not allow it to be removed.
    if (err.code === '23503') {
      throw new ApiError(409, 'WORKSHOP_IN_USE', 'This workshop already has sessions or attendance records, so it cannot be deleted.');
    }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { createWorkshop, listWorkshops, updateWorkshop, deleteWorkshop };
