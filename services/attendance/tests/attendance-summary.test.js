// Automated tests for the REAL attendance summary route, using FAKE records.
// No Supabase connection, .env, passwords, or server.js required.
// Usage from the project folder: node --test tests/attendance-summary.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const poolPath = require.resolve('../db/pool');
const authPath = require.resolve('../middleware/auth');
const routePath = require.resolve('../routes/sessions');

let fixture = {};

const fakePool = {
  async query(sql, params) {
    if (!Array.isArray(params) || params.length !== 1) {
      throw new Error('Unexpected query parameters in test');
    }
    if (sql.includes('FROM public.workshops WHERE workshop_id = $1')) {
      return { rows: fixture.workshop ? [fixture.workshop] : [] };
    }
    if (sql.includes('COUNT(*)::int AS total_sessions FROM public.sessions')) {
      return { rows: [{ total_sessions: fixture.totalSessions }] };
    }
    if (sql.includes('FROM public.registrations r') && sql.includes('LEFT JOIN public.attendance')) {
      return { rows: fixture.attendees };
    }
    throw new Error('Unexpected SQL statement in test: ' + sql.slice(0, 70));
  }
};

// Replace the database and login modules *only in this test process*.
// The real backend files and their security are not modified.
require.cache[poolPath] = {
  id: poolPath, filename: poolPath, loaded: true, exports: fakePool
};
require.cache[authPath] = {
  id: authPath, filename: authPath, loaded: true,
  exports: {
    requireLogin(req, res, next) {
      req.user = { userId: req.get('X-Test-User') || 'owner', role: 'organizer' };
      next();
    },
    requireOrganizer(req, res, next) {
      if (req.user.role !== 'organizer') return res.sendStatus(403);
      next();
    }
  }
};

delete require.cache[routePath];
const sessionsRouter = require('../routes/sessions');

const app = express();
app.use(express.json());
app.use('/workshops', sessionsRouter);
app.use((err, req, res, next) => {
  res.status(500).json({ error: err.message });
});

async function requestSummary() {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  try {
    const url = 'http://127.0.0.1:' + server.address().port
      + '/workshops/1/attendance/summary';
    const response = await fetch(url);
    const body = await response.json();
    return { status: response.status, body };
  } finally {
    await new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  }
}

function setFixture({ workshop = { workshop_id: 1, title: 'Cloud Security', organizer_id: 'owner' },
                      totalSessions = 4, attendees = [] } = {}) {
  fixture = { workshop, totalSessions, attendees };
}

test('calculates 75% and 100% attendance for two registered attendees', async () => {
  setFixture({
    totalSessions: 4,
    attendees: [
      { registration_id: 11, attendee_id: 'student-a', attendee_name: 'Student A', attended_sessions: 3 },
      { registration_id: 12, attendee_id: 'student-b', attendee_name: 'Student B', attended_sessions: 4 }
    ]
  });

  const { status, body } = await requestSummary();
  assert.equal(status, 200);
  assert.equal(body.totalSessions, 4);
  assert.equal(body.registeredAttendees, 2);
  assert.equal(body.attendees[0].attendancePercentage, 75);
  assert.equal(body.attendees[1].attendancePercentage, 100);
});

test('returns null attendance percentage when a workshop has no sessions', async () => {
  setFixture({
    totalSessions: 0,
    attendees: [
      { registration_id: 11, attendee_id: 'student-a', attendee_name: 'Student A', attended_sessions: 0 }
    ]
  });

  const { status, body } = await requestSummary();
  assert.equal(status, 200);
  assert.equal(body.attendees[0].attendancePercentage, null);
});

test('rejects a non-owner organizer with HTTP 403', async () => {
  setFixture({ workshop: { workshop_id: 1, title: 'Other Workshop', organizer_id: 'somebody-else' } });
  const { status, body } = await requestSummary();
  assert.equal(status, 403);
  assert.equal(body.code, 'NOT_WORKSHOP_OWNER');
});

test('returns HTTP 404 for an unknown workshop', async () => {
  setFixture({ workshop: null });
  const { status, body } = await requestSummary();
  assert.equal(status, 404);
  assert.equal(body.code, 'WORKSHOP_NOT_FOUND');
});
