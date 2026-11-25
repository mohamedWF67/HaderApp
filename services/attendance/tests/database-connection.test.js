const { test } = require('node:test');
const assert = require('node:assert/strict');
const connection = require('../db/connection');

test('accepts the dedicated direct and pooler login with verified TLS config', () => {
  for (const user of ['hader_attendance', 'hader_attendance.lydhdtlxodhyqjhvcfdu']) {
    const url = new URL(connection(`postgresql://${user}:test-only@localhost:5432/postgres?sslmode=disable&ssl=false`));
    assert.equal(url.username, user);
    assert.equal(url.search, '');
  }
});

test('rejects privileged, foreign, missing and malformed connection settings without leaking secrets', () => {
  for (const value of [undefined, 'malformed-secret',
    'postgresql://postgres:private-secret@localhost/postgres',
    'postgresql://hader_attendance.other:private-secret@localhost/postgres',
    'postgresql://hader_attendance@localhost/postgres',
    'postgresql://hader_attendance:private-secret@localhost/other']) {
    assert.throws(() => connection(value), error => !error.message.includes('private-secret') && !error.message.includes('malformed-secret'));
  }
});
