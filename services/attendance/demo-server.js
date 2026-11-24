// Hader Attendance browser demo.
// Runs separately from the existing server.js, so it cannot disrupt port 3002.
// Usage: node demo-server.js -> http://localhost:3003

require('dotenv').config();
const express = require('express');
const path = require('path');
const pool = require('./db/pool');
const { requireLogin, requireOrganizer } = require('./middleware/auth');
const sessionsRouter = require('./routes/sessions');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '10kb' }));
app.use('/workshops', sessionsRouter);

app.get('/api/me', requireLogin, (req, res) => {
  res.json({ userId: req.user.userId, role: req.user.role });
});

// Workshop chooser: organizers see their own workshops;
// attendees see only those they are registered for.
app.get('/api/workshops', requireLogin, async (req, res, next) => {
  try {
    const sql = req.user.role === 'organizer'
      ? `SELECT workshop_id, title, workshop_date
         FROM public.workshops WHERE organizer_id = $1
         ORDER BY workshop_date, workshop_id`
      : `SELECT w.workshop_id, w.title, w.workshop_date
         FROM public.workshops w
         JOIN public.registrations r ON r.workshop_id = w.workshop_id
         WHERE r.attendee_id = $1
         ORDER BY w.workshop_date, w.workshop_id`;
    const { rows } = await pool.query(sql, [req.user.userId]);
    res.json(rows.map(w => ({
      workshopId: w.workshop_id,
      title: w.title,
      date: w.workshop_date
    })));
  } catch (error) {
    next(error);
  }
});

// Only workshop owners may see the attendee/registration list.
app.get('/api/workshops/:workshopId/registrations',
  requireLogin, requireOrganizer, async (req, res, next) => {
    const workshopId = Number(req.params.workshopId);
    if (!Number.isInteger(workshopId) || workshopId < 1 || workshopId > 2147483647) {
      return res.status(400).json({ code: 'INVALID_WORKSHOP_ID' });
    }
    try {
      const { rows: owners } = await pool.query(
        'SELECT organizer_id FROM public.workshops WHERE workshop_id = $1',
        [workshopId]
      );
      if (!owners.length) return res.status(404).json({ code: 'WORKSHOP_NOT_FOUND' });
      if (owners[0].organizer_id !== req.user.userId) {
        return res.status(403).json({ code: 'NOT_WORKSHOP_OWNER' });
      }
      const { rows } = await pool.query(
        `SELECT r.registration_id, p.name AS attendee_name
         FROM public.registrations r
         JOIN public.profiles p ON p.id = r.attendee_id
         WHERE r.workshop_id = $1
         ORDER BY r.registration_id`,
        [workshopId]
      );
      return res.json(rows.map(r => ({
        registrationId: r.registration_id,
        attendeeName: r.attendee_name
      })));
    } catch (error) {
      next(error);
    }
  }
);

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'attendance.html'));
});

// Consistent API errors, without leaking database/server details to browsers.
app.use((error, req, res, next) => {
  console.error('Attendance demo error:', error.message);
  res.status(error.status || 500).json({
    code: error.status ? 'REQUEST_ERROR' : 'SERVER_ERROR',
    error: error.status ? error.message : 'Internal server error'
  });
});

const PORT = Number(process.env.DEMO_PORT || 3003);
app.listen(PORT, '127.0.0.1', () => {
  console.log('Hader Attendance dashboard: http://localhost:' + PORT);
});
