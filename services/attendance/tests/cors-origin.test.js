// Validates the Vercel frontend CORS contract without any Supabase credentials.
// The real Express app and CORS middleware run with mocked DB and session router.
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const poolPath = require.resolve('../db/pool');
const routesPath = require.resolve('../routes/sessions');
const appPath = require.resolve('../app');
require.cache[poolPath] = {
  id: poolPath, filename: poolPath, loaded: true,
  exports: { query: async () => ({ rows: [{ '?column?': 1 }] }) }
};
require.cache[routesPath] = {
  id: routesPath, filename: routesPath, loaded: true,
  exports: express.Router()
};

const previousCors = process.env.CORS_ORIGINS;
// Simulate a developer's existing local-only .env configuration.
process.env.CORS_ORIGINS = 'http://localhost:8080';
delete require.cache[appPath];
const app = require('../app');
if (previousCors === undefined) delete process.env.CORS_ORIGINS;
else process.env.CORS_ORIGINS = previousCors;

async function call(origin, method = 'GET') {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  try {
    const headers = { Origin: origin };
    if (method === 'OPTIONS') {
      headers['Access-Control-Request-Method'] = 'GET';
      headers['Access-Control-Request-Headers'] = 'Authorization';
    }
    const response = await fetch(
      'http://127.0.0.1:' + server.address().port + '/health',
      { method, headers }
    );
    return response;
  } finally {
    await new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  }
}

test('allows Vercel frontend to read Attendance API responses', async () => {
  const response = await call('https://hader-app-five.vercel.app');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://hader-app-five.vercel.app');
  assert.equal(response.headers.get('vary'), 'Origin');
});

test('allows Vercel preflight with Authorization header', async () => {
  const response = await call('https://hader-app-five.vercel.app', 'OPTIONS');
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://hader-app-five.vercel.app');
  assert.match(response.headers.get('access-control-allow-headers'), /Authorization/);
});

test('preserves configured local frontend origin', async () => {
  const response = await call('http://localhost:8080');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), 'http://localhost:8080');
});

test('does not allow an arbitrary origin', async () => {
  const response = await call('https://not-the-hader-site.example');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
});
