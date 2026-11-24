// In-app notifications: short messages for one user, shown under the bell on the website.
// They are written by the backend only (the browser can read its own, never write).
const pool = require('../db/pool');

// Add one notification. Call it with the open transaction's client, so the message is
// saved together with the change it describes (or not at all, if that change fails).
async function notify(client, userId, workshopId, type, message) {
  await client.query(
    `INSERT INTO public.notifications (user_id, workshop_id, type, message)
     VALUES ($1, $2, $3, $4)`,
    [userId, workshopId, type, message]
  );
}

// My latest notifications (newest first) and how many are unread.
async function listMine(userId) {
  const { rows } = await pool.query(
    `SELECT notification_id, workshop_id, type, message, created_at, read_at
     FROM public.notifications
     WHERE user_id = $1
     ORDER BY created_at DESC, notification_id DESC
     LIMIT 50`,
    [userId]
  );
  const { rows: count } = await pool.query(
    'SELECT COUNT(*)::int AS unread FROM public.notifications WHERE user_id = $1 AND read_at IS NULL',
    [userId]
  );
  return {
    unread: count[0].unread,
    notifications: rows.map(n => ({
      notificationId: n.notification_id,
      workshopId: n.workshop_id,
      type: n.type,
      message: n.message,
      createdAt: n.created_at,
      read: n.read_at !== null
    }))
  };
}

// Mark all of MY notifications as read (the WHERE user_id = me is the ownership rule).
async function markAllRead(userId) {
  const { rowCount } = await pool.query(
    'UPDATE public.notifications SET read_at = NOW() WHERE user_id = $1 AND read_at IS NULL',
    [userId]
  );
  return { markedRead: rowCount };
}

// ---------------------------------------------------------------------------
// Scheduled checks: run by the scheduler Lambda every minute (EventBridge Scheduler).
// Safe to run again and again: the unique index on (user, workshop, type) for these
// three types means each message is created only once (ON CONFLICT DO NOTHING).
// ---------------------------------------------------------------------------
async function runScheduledChecks() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1) Registration deadline passed -> tell the organizer how many seats were taken.
    const closed = await client.query(
      `INSERT INTO public.notifications (user_id, workshop_id, type, message)
       SELECT w.organizer_id, w.workshop_id, 'registration_closed',
              format('Registration for "%s" has closed: %s of %s seats taken, %s still waiting.',
                     w.title, w.total_seats - w.seats_left, w.total_seats,
                     (SELECT COUNT(*) FROM public.waitlist q WHERE q.workshop_id = w.workshop_id))
       FROM public.workshops w
       WHERE w.registration_deadline IS NOT NULL
         AND w.registration_deadline <= NOW()
         AND w.workshop_date > NOW()
       ON CONFLICT (user_id, workshop_id, type)
         WHERE type IN ('registration_closed', 'workshop_reminder', 'waitlist_expired')
       DO NOTHING`
    );

    // 2) Workshop starts within 24 hours -> remind everyone who has a seat.
    const reminders = await client.query(
      `INSERT INTO public.notifications (user_id, workshop_id, type, message)
       SELECT r.attendee_id, w.workshop_id, 'workshop_reminder',
              format('Reminder: "%s" starts within 24 hours. See you there!', w.title)
       FROM public.workshops w
       JOIN public.registrations r ON r.workshop_id = w.workshop_id
       WHERE w.workshop_date > NOW()
         AND w.workshop_date <= NOW() + INTERVAL '24 hours'
       ON CONFLICT (user_id, workshop_id, type)
         WHERE type IN ('registration_closed', 'workshop_reminder', 'waitlist_expired')
       DO NOTHING`
    );

    // 3) Workshop has started -> people still waiting will not get a seat any more:
    //    tell them, then close the queue.
    const expired = await client.query(
      `INSERT INTO public.notifications (user_id, workshop_id, type, message)
       SELECT q.attendee_id, w.workshop_id, 'waitlist_expired',
              format('"%s" has started, so its waiting list is closed. Sorry, no seat became free.', w.title)
       FROM public.waitlist q
       JOIN public.workshops w ON w.workshop_id = q.workshop_id
       WHERE w.workshop_date <= NOW()
       ON CONFLICT (user_id, workshop_id, type)
         WHERE type IN ('registration_closed', 'workshop_reminder', 'waitlist_expired')
       DO NOTHING`
    );
    const cleared = await client.query(
      `DELETE FROM public.waitlist q
       USING public.workshops w
       WHERE w.workshop_id = q.workshop_id AND w.workshop_date <= NOW()`
    );

    // 4) Housekeeping: rate-limit counters older than 10 minutes are no longer needed.
    await client.query("DELETE FROM public.rate_limits WHERE window_start < NOW() - INTERVAL '10 minutes'");

    await client.query('COMMIT');
    return {
      registrationClosedNotices: closed.rowCount,
      reminders: reminders.rowCount,
      waitlistExpiredNotices: expired.rowCount,
      waitlistEntriesCleared: cleared.rowCount
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { notify, listMine, markAllRead, runScheduledChecks };
