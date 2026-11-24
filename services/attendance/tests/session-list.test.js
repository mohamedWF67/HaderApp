// Isolated tests for GET workshop sessions. Uses fake records, not Supabase.
// Run: node --test tests/session-list.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const poolPath = require.resolve('../db/pool');
const authPath = require.resolve('../middleware/auth');
const routePath = require.resolve('../routes/sessions');

let fixture;
function setup(data = {}) {
  fixture = {
    workshop: { workshop_id: 1, organizer_id: 'owner' },
    registrationExists: false,
    sessions: [{ session_id: '7', title: 'Session A',
                 start_time: '2026-11-25T10:00:00Z',
                 end_time: '2026-11-25T11:00:00Z',
                 checkin_status: 'closed' }],
    ...data
  };
}

const fakePool = {
  async query(sql, args) {
    if (sql.includes('SELECT workshop_id, organizer_id FROM public.workshops')) {
      return { rows: fixture.workshop ? [fixture.workshop] : [] };
    }
    if (sql.includes('SELECT 1 FROM public.registrations')) {
      return { rows: fixture.registrationExists ? [{ '?column?': 1 }] : [] };
    }
    if (sql.includes('SELECT session_id, workshop_id, title, start_time')) {
      return { rows: fixture.sessions.map(s => ({ ...s, workshop_id: 1 })) };
    }
    throw new Error('Unexpected SQL query in isolated test');
  }
};
require.cache[poolPath] = {
  id: poolPath, filename: poolPath, loaded: true, exports: fakePool
};
require.cache[authPath] = {
  id: authPath, filename: authPath, loaded: true,
  exports: {
    requireLogin(req, res, next) {
      req.user = { role: req.get('X-Test-Role') || 'organizer',
                   userId: req.get('X-Test-User') || 'owner' };
      next();
    },
    requireOrganizer(req, res, next) {
      if (req.user.role !== 'organizer') return res.sendStatus(403);
      next();
    }
  }
};
delete require.cache[routePath];
const router = require('../routes/sessions');
const app = express();
app.use(express.json());
app.use('/workshops', router);
app.use((err, req, res, next) => res.status(500).json({ error: err.message }));

async function request(role, user = 'owner') {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  try {
    const result = await fetch(
      'http://127.0.0.1:' + server.address().port + '/workshops/1/sessions',
      { headers: { 'X-Test-Role': role, 'X-Test-User': user } }
    );
    return { status: result.status, body: await result.json() };
  } finally {
    await new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  }
}

test('owner organizer can list sessions', async () => {
  setup();
  const { status, body } = await request('organizer');
  assert.equal(status, 200);
  assert.equal(body.sessions.length, 1);
  assert.equal(body.sessions[0].checkinStatus, 'closed');
});

test('registered attendee can list their workshop sessions', async () => {
  setup({ registrationExists: true });
  const { status, body } = await request('attendee', 'student');
  assert.equal(status, 200);
  assert.equal(body.sessions[0].title, 'Session A');
});

test('unregistered attendee cannot list workshop sessions', async () => {
  setup();
  const { status, body } = await request('attendee', 'outsider');
  assert.equal(status, 403);
  assert.equal(body.code, 'NOT_REGISTERED');
});

test('organizer who does not own workshop is forbidden', async () => {
  setup();
  const { status } = await request('organizer', 'other-organizer');
  assert.equal(status, 403);
});

test('unknown workshop returns not found', async () => {
  setup({ workshop: null });
  const { status, body } = await request('organizer');
  assert.equal(status, 404);
  assert.equal(body.code, 'WORKSHOP_NOT_FOUND');
});
