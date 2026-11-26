// Shared PostgreSQL connection pool for Hader Attendance.
// Keep DATABASE_URL in the local .env, NEVER in GitHub.

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

if (!process.env.DATABASE_URL) {
  throw new Error('Missing DATABASE_URL in .env. Load dotenv before requiring db/pool.');
}

const connectionString = require('./connection')(process.env.DATABASE_URL);

const ca = fs.readFileSync(path.join(__dirname, '..', 'certs', 'prod-ca-2021.crt'), 'utf8');

module.exports = new Pool({
  connectionString,
  ssl: { ca, rejectUnauthorized: true },
  max: 3,
  connectionTimeoutMillis: 10000
});
