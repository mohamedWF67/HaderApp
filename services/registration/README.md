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
Then `db/006_service_role.sql`: the service's **own limited login** `hader_registration` (least privilege).
Set its password in a separate query that you never save: `ALTER ROLE hader_registration WITH PASSWORD '...';`
and use it in `DATABASE_URL` (user `hader_registration.PROJECTREF`). That login can only use this service's
tables (read-only on `profiles`), cannot read Supabase's `auth` schema, and RLS still blocks the browser.

## Deploy to Floci
Needs Docker Desktop (running), the AWS CLI and Node.js, plus `services/registration/.env`.
Run from the ROOT of this repo. Both scripts do the same thing; pick one.

**Windows PowerShell** (easiest for teammates: no AWS profile needed, starts Floci if it is stopped):
```
powershell -ExecutionPolicy Bypass -File services\registration\infra\deploy-registration.ps1
```

**Git Bash** (uses the `floci` AWS profile from the labs):
```
export AWS_PROFILE=floci
bash services/registration/infra/deploy-registration.sh
```
At the end it prints the API address: put it in `shared/config.js` as `REGISTRATION_API`.
A brand-new Floci starts empty, so its API address is different from yours.
Creates: IAM role (logs only) -> 2 Lambda functions (`hader-registration-api`, `hader-registration-checks`)
-> API Gateway HTTP API (routes + throttling) -> EventBridge Scheduler (checks every minute, own IAM role)
-> CloudWatch metric filters + alarms -> SNS topic for alerts.

## Tests
`tests/` holds the Postman collections (import them into Postman, or run them all at once):
```
cd services/registration
npm run test:api -- --api <API address> --key <Supabase publishable key> --password <test users' password> --security
```
Test users: `organizer1@hader.test`, `nour@hader.test` (organizers), `nada@hader.test`, `nayera@hader.test` (attendees).
`--security` also sends 25 requests without a login (401, trips the access-denied alarm) and 150 at once (429).

## Monitoring
CloudWatch Logs get one JSON line per security event (`access_denied`, `rate_limited`, `server_error`, ...).
Metric filters count them, and two CloudWatch alarms notify the SNS topic `hader-registration-alerts`:
`hader-registration-server-errors` (any 500 within 5 minutes) and `hader-registration-access-denied` (20+ refused requests within 5 minutes).
```
aws cloudwatch describe-alarms --alarm-name-prefix hader-registration --query "MetricAlarms[].[AlarmName,StateValue]" --output table
```

## Security in short
Supabase login token checked on every route (401), role read from the database (403), ownership checks
on every record (403), server-side input validation (400), parameterized SQL, rate limit 100 requests
per minute per address (429), Row Level Security on all tables, its own limited database login,
CloudWatch alarms on errors and refused requests, secrets only in `.env` / Lambda settings.
