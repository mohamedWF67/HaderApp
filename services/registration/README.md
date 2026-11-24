# Workshop & Registration Service (Nourhan Ibrahim)

Backend for workshops, seats, the waiting list, the registration deadline and in-app notifications.
Node.js + Express, deployed to AWS Lambda on Floci, data in Supabase PostgreSQL.

## Run on your laptop
```
cd services/registration
cp .env.example .env        # then fill in DATABASE_URL and SUPABASE_URL (never commit .env)
npm install
npm run dev                 # http://localhost:3001
```

## Database
Run in the Supabase SQL Editor, in order: `db/schema.sql` (new database), or for an existing one
`db/002_waitlist.sql`, `db/003_registration_deadline.sql`, `db/004_notifications.sql`, `db/005_rate_limits.sql`.

## Deploy to Floci (from the ROOT of this repo, in Git Bash)
```
export AWS_PROFILE=floci
bash services/registration/infra/deploy-registration.sh
```
Creates: IAM role (logs only) -> 2 Lambda functions (`hader-registration-api`, `hader-registration-checks`)
-> API Gateway HTTP API (routes + throttling) -> EventBridge Scheduler (checks every minute, own IAM role).

## Security in short
Supabase login token checked on every route (401), role read from the database (403), ownership checks
on every record (403), server-side input validation (400), parameterized SQL, rate limit 100 requests
per minute per address (429), Row Level Security on all tables, secrets only in `.env` / Lambda settings.
