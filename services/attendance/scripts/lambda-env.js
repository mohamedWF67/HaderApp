// Emits an AWS Lambda environment variable JSON object for the local deploy script.
// Never paste this output into chat or commit it to GitHub: it contains DATABASE_URL.
// Usage: node scripts/lambda-env.js (deploy PowerShell captures output in a temp file)
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env'), quiet: true });
const required = ['DATABASE_URL'];
for (const key of required) {
  if (!process.env[key]) {
    console.error('Missing ' + key + ' in local .env');
    process.exit(1);
  }
}

const variables = {
  DATABASE_URL: process.env.DATABASE_URL,
  SUPABASE_URL: process.env.SUPABASE_URL || 'https://lydhdtlxodhyqjhvcfdu.supabase.co',
  CORS_ORIGINS: process.env.CORS_ORIGINS || 'http://localhost:3003',
  NODE_ENV: 'production'
};
process.stdout.write(JSON.stringify({ Variables: variables }));
