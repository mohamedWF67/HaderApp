// Isolated tests of the REAL check-in route using fake database records.
// No Hader accounts, Supabase credentials, or database changes are needed.
// Run: node --test tests/attendance-checkin.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const poolPath = require.resolve('../db/pool');
const authPath = require.resolve('../middleware/auth');
const routesPath = require.resolve('../routes/sessions');

let fixture;
let statements;

function setup(changes = {}) {
  fixture = {
    sessionExists: true,
    organizerId: 'owner',
    status: 'open',
    registrationExists: true,
    duplicate: false,
    ...changes
  };
  statements = [];
}

// This mock replaces PostgreSQL *only in this test process*.
// It verifies the business decisions made by the actual Express route.
const fakePool = {
  async connect() {
    return {
      async query(sql, params) {
        statements.push(sql.trim());
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
          return { rows: [] };
        }
        if (sql.includes('FROM public.sessions s') &&
            sql.includes('FOR UPDATE OF s')) {
          return {
            rows: fixture.sessionExists
              ? [{ session_id: '1', checkin_status: fixture.status, organizer_id: fixture.organizerId }]
              : []
          };
        }
        if (sql.includes('FROM public.registrations WHERE registration_id')) {
          return {
            rows: fixture.registrationExists ? [{ attendee_id: 'attendee-1' }] : []
          };
        }
        if (sql.includes('INSERT INTO public.attendance')) {
          return {
            rows: fixture.duplicate
              ? []
              : [{ attendance_id: '17', session_id: '1', registration_id: 9,
                   checked_in_at: '2026-11-22T20:00:00.000Z' }]
          };
        }
        throw new Error('Unexpected SQL in check-in test');
      },
      release() { statements.push('RELEASE'); }
    };
  }
};

// Mock auth only to isolate the attendance business rules.
// Real JWT verification still runs in production; this test does not replace it there.
require.cache[poolPath] = {
  id: poolPath, filename: poolPath, loaded: true, exports: fakePool
};
require.cache[authPath] = {
  id: authPath, filename: authPath, loaded: true,
  exports: {
    requireLogin(req, res, next) {
      req.user = { userId: 'owner', role: 'organizer' };
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

async function checkIn({ registrationId = 9, path = '/workshops/1/sessions/1/attendance' } = {}) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  try {
    const response = await fetch('http://127.0.0.1:' + server.address().port + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ registrationId })
    });
    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise((resolve, reject) =>
      server.close(err => err ? reject(err) : resolve())
    );
  }
}

function didInsert() {
  return statements.some(sql => sql.includes('INSERT INTO public.attendance'));
}

test('records attendance when owner, registration and open check-in are valid', async () => {
  setup();
  const result = await checkIn();
  assert.equal(result.status, 201);
  assert.equal(result.body.status, 'present');
  assert.equal(result.body.registrationId, 9);
  assert.ok(didInsert());
  assert.ok(statements.includes('COMMIT'));
});

test('rejects check-in when session is closed', async () => {
  setup({ status: 'closed' });
  const result = await checkIn();
  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'CHECKIN_CLOSED');
  assert.equal(didInsert(), false);
});

test('rejects check-in by an organizer who does not own the workshop', async () => {
  setup({ organizerId: 'another-organizer' });
  const result = await checkIn();
  assert.equal(result.status, 403);
  assert.equal(result.body.code, 'NOT_WORKSHOP_OWNER');
  assert.equal(didInsert(), false);
});

test('rejects registration that does not belong to the workshop', async () => {
  setup({ registrationExists: false });
  const result = await checkIn();
  assert.equal(result.status, 404);
  assert.equal(result.body.code, 'REGISTRATION_NOT_FOUND');
  assert.equal(didInsert(), false);
});

test('rejects duplicate attendance without committing another row', async () => {
  setup({ duplicate: true });
  const result = await checkIn();
  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'ALREADY_CHECKED_IN');
  assert.ok(didInsert());
  assert.equal(statements.includes('COMMIT'), false);
  assert.ok(statements.includes('ROLLBACK'));
});

test('rejects a session that does not exist', async () => {
  setup({ sessionExists: false });
  const result = await checkIn();
  assert.equal(result.status, 404);
  assert.equal(result.body.code, 'SESSION_NOT_FOUND');
  assert.equal(didInsert(), false);
});

test('rejects an invalid registration ID before querying the database', async () => {
  setup();
  const result = await checkIn({ registrationId: -5 });
  assert.equal(result.status, 400);
  assert.equal(result.body.code, 'INVALID_REGISTRATION_ID');
  assert.equal(statements.length, 0);
});
