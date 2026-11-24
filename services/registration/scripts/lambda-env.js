// Prints the Lambda environment variables as JSON, read from .env.
// The deploy script passes this straight to AWS, so the secrets never go into a file in the repo.
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env'), quiet: true });

const corsOrigins = process.argv[2] || process.env.CORS_ORIGINS;
const required = ['DATABASE_URL', 'SUPABASE_URL'];
for (const name of required) {
  if (!process.env[name]) {
    console.error(`Missing ${name} in .env`);
    process.exit(1);
  }
}

const variables = {
  DATABASE_URL: process.env.DATABASE_URL,
  SUPABASE_URL: process.env.SUPABASE_URL,
  CORS_ORIGINS: corsOrigins,
  NODE_ENV: 'production'
};
if (process.env.DB_CA_PATH) variables.DB_CA_PATH = process.env.DB_CA_PATH;
if (process.env.RATE_LIMIT_PER_MINUTE) variables.RATE_LIMIT_PER_MINUTE = process.env.RATE_LIMIT_PER_MINUTE;

process.stdout.write(JSON.stringify({ Variables: variables }));
