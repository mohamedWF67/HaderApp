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

// Preserve any local developer origins and always include the deployed Hader site.
require('../db/connection')(process.env.DATABASE_URL);
const corsOrigins = new Set([
  'http://localhost:3003',
  'https://hader-app-five.vercel.app',
  ...(process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean)
]);
const variables = {
  DATABASE_URL: process.env.DATABASE_URL,
  SUPABASE_URL: process.env.SUPABASE_URL || 'https://lydhdtlxodhyqjhvcfdu.supabase.co',
  CORS_ORIGINS: [...corsOrigins].join(','),
  NODE_ENV: 'production'
};
process.stdout.write(JSON.stringify({ Variables: variables }));
