// One shared connection pool to the Supabase database.
// The connection string comes ONLY from the DATABASE_URL environment variable.
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

// Supabase's CA certificate (public, not a secret). With it, the connection is encrypted
// AND the server's identity is checked, so a fake server cannot pretend to be Supabase.
// The path is fixed so that Vercel and Lambda always pack the file with the code.
const CA_FILE = path.join(__dirname, '..', 'certs', 'prod-ca-2021.crt');

let ssl;
if (process.env.DB_SSL === 'off') {
  ssl = false; // only for a local test database
} else if (process.env.DB_CA_PATH) {
  ssl = { ca: fs.readFileSync(path.resolve(__dirname, '..', process.env.DB_CA_PATH), 'utf8') };
} else if (fs.existsSync(CA_FILE)) {
  ssl = { ca: fs.readFileSync(CA_FILE, 'utf8') };
} else {
  ssl = { rejectUnauthorized: false }; // still encrypted, but the server is not verified
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl,
  max: 3 // small: every serverless copy opens its own pool
});

module.exports = pool;
