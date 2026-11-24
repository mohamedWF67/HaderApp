// Integration contract for Waleed's Certificate service.
// Real Express route, stubbed JWT middleware and PostgreSQL. No credentials needed.
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const poolPath = require.resolve('../db/pool');
const authPath = require.resolve('../middleware/auth');
const routesPath = require.resolve('../routes/sessions');

let fixture = {};
let databaseCalls = 0;
function setup(changes = {}) {
  fixture = { registered: true, totalSessions: 3, attendedSessions: 3, ...changes };
  databaseCalls = 0;
}

require.cache[poolPath] = {
  id: poolPath, filename: poolPath, loaded: true,
  exports: {
    async query(sql, params) {
      databaseCalls++;
      assert.match(sql, /FROM public.registrations r/);
      assert.match(sql, /JOIN public.sessions s/);
      assert.match(sql, /COUNT\(DISTINCT a.session_id\)/);
      assert.deepEqual(params, [1, 'student-a']);
      return { rows: fixture.registered
        ? [{ total_sessions: fixture.totalSessions, attended_sessions: fixture.attendedSessions }]
        : [] };
    }
  }
};
require.cache[authPath] = {
  id: authPath, filename: authPath, loaded: true,
  exports: {
    requireLogin(req, res, next) {
      if (!req.get('X-Test-User')) return res.status(401).json({ code: 'UNAUTHENTICATED' });
      req.user = { userId: req.get('X-Test-User'), role: req.get('X-Test-Role') || 'attendee' };
      next();
    },
    requireOrganizer(req, res, next) {
      if (req.user.role !== 'organizer') return res.sendStatus(403);
      next();
    }
  }
};

delete require.cache[routesPath];
const router = require('../routes/sessions');
const app = express();
app.use(express.json());
app.use('/workshops', router);
app.use((error, req, res, next) => res.status(500).json({ error: error.message }));

async function request(path = '/workshops/1/attendance/student-a', user = 'student-a', role = 'attendee') {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  try {
    const response = await fetch('http://127.0.0.1:' + server.address().port + path, {
      headers: { 'X-Test-User': user, 'X-Test-Role': role }
    });
    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  }
}

test('returns the exact attendance counts the Certificate service expects', async () => {
  setup();
  const { status, body } = await request();
  assert.equal(status, 200);
  assert.equal(body.totalSessions, 3);
  assert.equal(body.attendedSessions, 3);
  assert.equal(body.attendeeId, 'student-a');
  assert.equal(databaseCalls, 1);
});

test('returns partial attendance, without deciding certificate eligibility', async () => {
  setup({ totalSessions: 4, attendedSessions: 2 });
  const { status, body } = await request();
  assert.equal(status, 200);
  assert.equal(body.totalSessions, 4);
  assert.equal(body.attendedSessions, 2);
});

test('returns zero counts for a registered workshop with no sessions', async () => {
  setup({ totalSessions: 0, attendedSessions: 0 });
  const { status, body } = await request();
  assert.equal(status, 200);
  assert.equal(body.totalSessions, 0);
  assert.equal(body.attendedSessions, 0);
});

test('does not disclose another attendee\'s attendance', async () => {
  setup();
  const { status, body } = await request('/workshops/1/attendance/student-b');
  assert.equal(status, 403);
  assert.equal(body.code, 'FORBIDDEN');
  assert.equal(databaseCalls, 0);
});

test('organizers cannot impersonate attendees', async () => {
  setup();
  const { status } = await request('/workshops/1/attendance/student-a', 'student-a', 'organizer');
  assert.equal(status, 403);
  assert.equal(databaseCalls, 0);
});

test('requires authentication', async () => {
  setup();
  const { status } = await request('/workshops/1/attendance/student-a', '');
  assert.equal(status, 401);
  assert.equal(databaseCalls, 0);
});

test('returns 404 for an unregistered attendee', async () => {
  setup({ registered: false });
  const { status, body } = await request();
  assert.equal(status, 404);
  assert.equal(body.code, 'REGISTRATION_NOT_FOUND');
});

test('rejects invalid workshop IDs before database access', async () => {
  setup();
  const { status, body } = await request('/workshops/-1/attendance/student-a');
  assert.equal(status, 400);
  assert.equal(body.code, 'INVALID_WORKSHOP_ID');
  assert.equal(databaseCalls, 0);
});
