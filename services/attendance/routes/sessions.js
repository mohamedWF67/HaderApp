const express = require('express');
const pool = require('../db/pool');
const { requireLogin, requireOrganizer } = require('../middleware/auth');

const router = express.Router();

const isoWithZone = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

function parseSession(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'Send a JSON object with title, startTime, and endTime.' };
  }

  const { title, startTime, endTime } = body;
  if (typeof title !== 'string' || title.trim().length < 3 || title.trim().length > 120) {
    return { error: 'title must be between 3 and 120 characters.' };
  }

  for (const [field, value] of [['startTime', startTime], ['endTime', endTime]]) {
    if (typeof value !== 'string' || !isoWithZone.test(value) || !Number.isFinite(Date.parse(value))) {
      return { error: field + ' must be an ISO 8601 date/time with Z or timezone offset.' };
    }
  }

  const start = new Date(startTime);
  const end = new Date(endTime);
  if (end <= start) {
    return { error: 'endTime must be after startTime.' };
  }

  return { data: { title: title.trim(), start, end } };
}

// POST /workshops/:workshopId/sessions
// Logged-in organizer creates a non-overlapping session for their own workshop.
router.post('/:workshopId/sessions', requireLogin, requireOrganizer, async (req, res, next) => {
  const workshopId = Number(req.params.workshopId);
  if (!Number.isInteger(workshopId) || workshopId < 1 || workshopId > 2147483647) {
    return res.status(400).json({ code: 'INVALID_WORKSHOP_ID', error: 'workshopId must be a positive integer.' });
  }

  const parsed = parseSession(req.body);
  if (parsed.error) {
    return res.status(400).json({ code: 'INVALID_SESSION', error: parsed.error });
  }

  const { title, start, end } = parsed.data;
  let client;
  let transactionStarted = false;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    transactionStarted = true;

    // Lock the workshop row: concurrent session creations for this workshop
    // cannot both pass the overlap check and insert conflicting sessions.
    const workshop = await client.query(
      'SELECT organizer_id FROM public.workshops WHERE workshop_id = $1 FOR UPDATE',
      [workshopId]
    );
    if (workshop.rows.length === 0) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(404).json({ code: 'WORKSHOP_NOT_FOUND', error: 'Workshop not found.' });
    }

    if (workshop.rows[0].organizer_id !== req.user.userId) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(403).json({ code: 'NOT_WORKSHOP_OWNER', error: 'You do not own this workshop.' });
    }

    // Endpoints that only touch are allowed; real overlap is forbidden.
    const overlapping = await client.query(
      `SELECT session_id FROM public.sessions
       WHERE workshop_id = $1 AND start_time < $3 AND end_time > $2
       LIMIT 1`,
      [workshopId, start.toISOString(), end.toISOString()]
    );
    if (overlapping.rows.length) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(409).json({ code: 'SESSION_OVERLAP', error: 'This workshop already has a session during that time.' });
    }

    const { rows } = await client.query(
      `INSERT INTO public.sessions (workshop_id, title, start_time, end_time)
       VALUES ($1, $2, $3, $4)
       RETURNING session_id, workshop_id, title, start_time, end_time, checkin_status, created_at`,
      [workshopId, title, start.toISOString(), end.toISOString()]
    );

    await client.query('COMMIT');
    transactionStarted = false;

    const s = rows[0];
    console.log(JSON.stringify({
      event: 'session_created',
      workshopId,
      sessionId: s.session_id,
      userId: req.user.userId
    }));

    return res.status(201).json({
      sessionId: s.session_id,
      workshopId: s.workshop_id,
      title: s.title,
      startTime: s.start_time,
      endTime: s.end_time,
      checkinStatus: s.checkin_status,
      createdAt: s.created_at
    });
  } catch (error) {
    if (transactionStarted && client) {
      await client.query('ROLLBACK').catch(() => {});
    }
    next(error);
  } finally {
    if (client) client.release();
  }
});

// PATCH /workshops/:workshopId/sessions/:sessionId/checkin
// Only the workshop owner can OPEN or CLOSE check-in.
// This controls the check-in window, not individual attendee attendance records.
router.patch('/:workshopId/sessions/:sessionId/checkin', requireLogin, requireOrganizer, async (req, res, next) => {
  const workshopId = Number(req.params.workshopId);
  const sessionId = req.params.sessionId;

  if (!Number.isInteger(workshopId) || workshopId < 1 || workshopId > 2147483647 ||
      !/^[1-9]\d*$/.test(sessionId) || sessionId.length > 18) {
    return res.status(400).json({ code: 'INVALID_ID', error: 'Invalid workshop or session ID.' });
  }

  const status = req.body?.status;
  if (status !== 'open' && status !== 'closed') {
    return res.status(400).json({
      code: 'INVALID_STATUS',
      error: 'JSON body must contain status: "open" or "closed".'
    });
  }

  let client;
  let transactionStarted = false;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    transactionStarted = true;

    // Check that the session belongs to this workshop; lock it against
    // concurrent status changes.
    const { rows } = await client.query(
      `SELECT s.session_id, s.checkin_status, w.organizer_id
       FROM public.sessions s
       JOIN public.workshops w ON w.workshop_id = s.workshop_id
       WHERE s.session_id = $1 AND w.workshop_id = $2
       FOR UPDATE OF s`,
      [sessionId, workshopId]
    );

    if (!rows.length) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(404).json({ code: 'SESSION_NOT_FOUND', error: 'Session not found in this workshop.' });
    }

    if (rows[0].organizer_id !== req.user.userId) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(403).json({ code: 'NOT_WORKSHOP_OWNER', error: 'Only this workshop organizer can change check-in.' });
    }

    if (rows[0].checkin_status === status) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(409).json({ code: 'STATUS_UNCHANGED', error: 'Check-in is already ' + status + '.' });
    }

    const updated = await client.query(
      `UPDATE public.sessions
       SET checkin_status = $1
       WHERE session_id = $2
       RETURNING session_id, workshop_id, checkin_status`,
      [status, sessionId]
    );

    await client.query('COMMIT');
    transactionStarted = false;

    console.log(JSON.stringify({
      event: 'checkin_status_changed',
      workshopId,
      sessionId,
      status,
      userId: req.user.userId
    }));

    return res.json({
      sessionId: updated.rows[0].session_id,
      workshopId: updated.rows[0].workshop_id,
      checkinStatus: updated.rows[0].checkin_status
    });
  } catch (error) {
    if (transactionStarted && client) {
      await client.query('ROLLBACK').catch(() => {});
    }
    next(error);
  } finally {
    if (client) client.release();
  }
});

// POST /workshops/:workshopId/sessions/:sessionId/attendance
// An organizer marks a REGISTERED attendee present while check-in is OPEN.
// Requires { "registrationId": number }. Enforces ownership, matching workshop,
// and one check-in per registration per session.
router.post('/:workshopId/sessions/:sessionId/attendance', requireLogin, requireOrganizer, async (req, res, next) => {
  const workshopId = Number(req.params.workshopId);
  const sessionId = req.params.sessionId;
  const registrationId = req.body?.registrationId;

  if (!Number.isInteger(workshopId) || workshopId < 1 || workshopId > 2147483647 ||
      !/^[1-9]\d*$/.test(sessionId) || sessionId.length > 18) {
    return res.status(400).json({ code: 'INVALID_ID', error: 'Invalid workshop or session ID.' });
  }
  if (!Number.isInteger(registrationId) || registrationId < 1 || registrationId > 2147483647) {
    return res.status(400).json({ code: 'INVALID_REGISTRATION_ID', error: 'registrationId must be a positive integer.' });
  }

  let client;
  let inTransaction = false;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    inTransaction = true;

    // Locking the session prevents a concurrent check-in CLOSE from racing this insert.
    const { rows: sessions } = await client.query(
      `SELECT s.session_id, s.checkin_status, w.organizer_id
       FROM public.sessions s
       JOIN public.workshops w ON w.workshop_id = s.workshop_id
       WHERE s.session_id = $1 AND s.workshop_id = $2
       FOR UPDATE OF s`,
      [sessionId, workshopId]
    );

    if (!sessions.length) {
      await client.query('ROLLBACK');
      inTransaction = false;
      return res.status(404).json({ code: 'SESSION_NOT_FOUND', error: 'Session not found in this workshop.' });
    }

    if (sessions[0].organizer_id !== req.user.userId) {
      await client.query('ROLLBACK');
      inTransaction = false;
      return res.status(403).json({ code: 'NOT_WORKSHOP_OWNER', error: 'Only the workshop organizer can mark attendance.' });
    }

    if (sessions[0].checkin_status !== 'open') {
      await client.query('ROLLBACK');
      inTransaction = false;
      return res.status(409).json({ code: 'CHECKIN_CLOSED', error: 'Open session check-in before marking attendance.' });
    }

    // Never trust a registrationId by itself: it must belong to this workshop.
    const { rows: registrations } = await client.query(
      'SELECT attendee_id FROM public.registrations WHERE registration_id = $1 AND workshop_id = $2',
      [registrationId, workshopId]
    );
    if (!registrations.length) {
      await client.query('ROLLBACK');
      inTransaction = false;
      return res.status(404).json({ code: 'REGISTRATION_NOT_FOUND', error: 'No matching registration for this workshop.' });
    }

    // The database UNIQUE(session_id, registration_id) makes this safe even
    // if the same request arrives twice. No duplicate attendance rows.
    const result = await client.query(
      `INSERT INTO public.attendance (session_id, registration_id, checked_in_by)
       VALUES ($1, $2, $3)
       ON CONFLICT (session_id, registration_id) DO NOTHING
       RETURNING attendance_id, session_id, registration_id, checked_in_at`,
      [sessionId, registrationId, req.user.userId]
    );

    if (!result.rows.length) {
      await client.query('ROLLBACK');
      inTransaction = false;
      return res.status(409).json({ code: 'ALREADY_CHECKED_IN', error: 'This attendee is already marked present for the session.' });
    }

    await client.query('COMMIT');
    inTransaction = false;
    const attendance = result.rows[0];

    console.log(JSON.stringify({
      event: 'attendance_checked_in',
      workshopId, sessionId, registrationId,
      userId: req.user.userId
    }));

    return res.status(201).json({
      attendanceId: attendance.attendance_id,
      sessionId: attendance.session_id,
      registrationId: attendance.registration_id,
      attendeeId: registrations[0].attendee_id,
      checkedInAt: attendance.checked_in_at,
      status: 'present'
    });
  } catch (error) {
    if (inTransaction && client) await client.query('ROLLBACK').catch(() => {});
    next(error);
  } finally {
    if (client) client.release();
  }
});

// GET /workshops/:workshopId/attendance/summary
// Only the workshop owner may see attendee attendance information.
// Count each attendee only for sessions belonging to the SAME workshop.
router.get('/:workshopId/attendance/summary', requireLogin, requireOrganizer, async (req, res, next) => {
  const workshopId = Number(req.params.workshopId);
  if (!Number.isInteger(workshopId) || workshopId < 1 || workshopId > 2147483647) {
    return res.status(400).json({ code: 'INVALID_WORKSHOP_ID', error: 'workshopId must be a positive integer.' });
  }

  try {
    const { rows: workshops } = await pool.query(
      'SELECT workshop_id, title, organizer_id FROM public.workshops WHERE workshop_id = $1',
      [workshopId]
    );
    if (!workshops.length) {
      return res.status(404).json({ code: 'WORKSHOP_NOT_FOUND', error: 'Workshop not found.' });
    }
    if (workshops[0].organizer_id !== req.user.userId) {
      return res.status(403).json({
        code: 'NOT_WORKSHOP_OWNER',
        error: 'Only the workshop organizer can view the attendance summary.'
      });
    }

    const { rows: counts } = await pool.query(
      'SELECT COUNT(*)::int AS total_sessions FROM public.sessions WHERE workshop_id = $1',
      [workshopId]
    );
    const totalSessions = counts[0].total_sessions;

    const { rows: attendees } = await pool.query(
      `SELECT r.registration_id, r.attendee_id, p.name AS attendee_name,
              COUNT(DISTINCT s.session_id)::int AS attended_sessions
       FROM public.registrations r
       JOIN public.profiles p ON p.id = r.attendee_id
       LEFT JOIN public.attendance a ON a.registration_id = r.registration_id
       LEFT JOIN public.sessions s
         ON s.session_id = a.session_id AND s.workshop_id = r.workshop_id
       WHERE r.workshop_id = $1
       GROUP BY r.registration_id, r.attendee_id, p.name
       ORDER BY p.name ASC, r.registration_id ASC`,
      [workshopId]
    );

    return res.json({
      workshopId,
      workshopTitle: workshops[0].title,
      totalSessions,
      registeredAttendees: attendees.length,
      // Percentages use all created sessions, including future ones. They are
      // provisional until the workshop is complete. No sessions => null, not 0%.
      attendees: attendees.map(row => ({
        registrationId: row.registration_id,
        attendeeId: row.attendee_id,
        attendeeName: row.attendee_name,
        attendedSessions: row.attended_sessions,
        totalSessions,
        attendancePercentage: totalSessions
          ? Math.round((row.attended_sessions / totalSessions) * 1000) / 10
          : null
      }))
    });
  } catch (error) {
    next(error);
  }
});

// GET /workshops/:workshopId/sessions
// The workshop's organizer or a registered attendee can list its sessions.
// Only basic session data is returned; individual attendance stays private.
router.get('/:workshopId/sessions', requireLogin, async (req, res, next) => {
  const workshopId = Number(req.params.workshopId);
  if (!Number.isInteger(workshopId) || workshopId < 1 || workshopId > 2147483647) {
    return res.status(400).json({ code: 'INVALID_WORKSHOP_ID', error: 'workshopId must be a positive integer.' });
  }

  try {
    const { rows: workshops } = await pool.query(
      'SELECT workshop_id, organizer_id FROM public.workshops WHERE workshop_id = $1',
      [workshopId]
    );
    if (!workshops.length) {
      return res.status(404).json({ code: 'WORKSHOP_NOT_FOUND', error: 'Workshop not found.' });
    }

    const ownsWorkshop = req.user.role === 'organizer'
      && workshops[0].organizer_id === req.user.userId;

    if (!ownsWorkshop) {
      // Avoid exposing private workshop sessions to other organizers or
      // attendees who are not registered for this workshop.
      if (req.user.role !== 'attendee') {
        return res.status(403).json({ code: 'FORBIDDEN', error: 'You cannot view these workshop sessions.' });
      }
      const { rows: registrations } = await pool.query(
        'SELECT 1 FROM public.registrations WHERE workshop_id = $1 AND attendee_id = $2 LIMIT 1',
        [workshopId, req.user.userId]
      );
      if (!registrations.length) {
        return res.status(403).json({ code: 'NOT_REGISTERED', error: 'Register for this workshop to view its sessions.' });
      }
    }

    const { rows: sessions } = await pool.query(
      `SELECT session_id, workshop_id, title, start_time, end_time, checkin_status
       FROM public.sessions
       WHERE workshop_id = $1
       ORDER BY start_time, session_id`,
      [workshopId]
    );

    return res.json({
      workshopId,
      sessions: sessions.map(s => ({
        sessionId: s.session_id,
        title: s.title,
        startTime: s.start_time,
        endTime: s.end_time,
        checkinStatus: s.checkin_status
      }))
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
