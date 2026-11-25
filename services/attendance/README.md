# Hader Attendance & Check-in microservice

Individual service by Mohamed Mousa, added to the shared HaderApp repository on branch `attendance-service` only.

This folder contains the **working Attendance Express backend** copied from [melabd017/Hader-attendance-backend](https://github.com/melabd017/Hader-attendance-backend), including:
- organizer-owned sessions and non-overlap scheduling
- open/close session check-in
- one-time check-in per registered attendee
- protected organizer attendance summaries
- attendee/organizer session listing
- Supabase JWT verification, PostgreSQL data persistence and automated tests
- local Floci AWS Lambda + API Gateway + CloudWatch Logs + IAM deployment

No secrets or `.env` files are committed.

## Dedicated PostgreSQL login

Attendance uses `hader_attendance` in Supabase project `lydhdtlxodhyqjhvcfdu`.
The connection pool and Lambda configuration generator reject other database
logins. Keep the generated password only in this service's private `.env` or
deployment secret setting. Never put it in frontend configuration or share the
main `postgres` password with Attendance.

For this project's existing session pooler, set the username to
`hader_attendance.lydhdtlxodhyqjhvcfdu`, host to
`aws-0-eu-west-1.pooler.supabase.com`, port to `5432`, and database to `postgres`.
The direct host uses username `hader_attendance`; see `.env.example`.
Percent-encode passwords when composing a URL. Both connections use the
existing Supabase CA with certificate verification enabled.

`db/attendance-login.sql` records the one-time administrator setup. It creates
the role without a password; provision a cryptographically random password
separately through a private administrator connection. Do not commit password
SQL or a password verifier. Do not rerun the setup against an existing role.

| Object | Allowed access |
| --- | --- |
| `profiles` | Read `id`, `name`, `role` |
| `workshops` | Read `workshop_id`, `title`, `workshop_date`, `organizer_id`; lock rows |
| `registrations` | Read `registration_id`, `workshop_id`, `attendee_id` |
| `sessions` | Read; insert `workshop_id`, `title`, `start_time`, `end_time`; update `checkin_status` |
| `attendance` | Read `attendance_id`, `session_id`, `registration_id`, `checked_in_at`; insert `session_id`, `registration_id`, `checked_in_by` |

The role has no memberships, ownership, DDL privileges, DELETE, BYPASSRLS,
or rights on Certificate/Registration writes, Auth data, notifications, waitlist,
or rate limits. Identity inserts need no sequence grants. To preserve the
existing workshop `SELECT FOR UPDATE`, PostgreSQL requires an UPDATE privilege
on one column and an UPDATE visibility policy. `WITH CHECK (false)` rejects
every actual workshop update, including a no-op assignment.

Policies apply only to this backend login. It can read the listed columns across
rows because JWT identity, organizer ownership and attendee registration are
checked by the existing API. It is a backend secret, not an end-user login.
RLS remains enabled and existing service policies are preserved. PostgreSQL's
existing PUBLIC privileges (including database CONNECT/TEMP and public-schema
USAGE) remain inherited; removing them globally would affect other services.

Run `npm test` and `npm run test:database` from this folder. The latter verifies
the real login and TLS, session creation/check-in, attendance insertion and
duplicate handling, summary/eligibility queries, and denial of unrelated reads,
writes and DDL. It requires an existing workshop/registration fixture and rolls
back every row change. Identity sequences can advance during testing.

After changing the private `.env`, restart Attendance or update only its Lambda
environment. The existing Floci deploy script reads that `.env`; it never
packages it. To roll back configuration, restore the previous private setting
and the preceding version of the connection validation together. Do not reset
the project's `postgres` password or modify another service's settings.

Verified on 2026-11-25: 30 automated tests and 25 live database checks passed,
using the dedicated login through the session pooler with verified TLS.

## Local demo
```powershell
cd services/attendance
npm install
# configure .env locally with the working DATABASE_URL, PORT and Supabase endpoint
node demo-server.js
```
Open http://localhost:3003

## Certificate service integration
The Certificate backend calls `GET /workshops/{workshopId}/attendance/{attendeeId}`
with the **attendee's Supabase Bearer access token**. The route returns
`{ workshopId, attendeeId, totalSessions, attendedSessions }`.
The authenticated caller must be an attendee and their JWT user ID must match
the URL attendee ID. Unregistered attendees receive 404; other users receive 403.
Zero sessions means `totalSessions: 0`, so the Certificate service treats the
workshop as ineligible. The organizer-only `/attendance/summary` route is unchanged.

After deploying to Floci again, update Waleed's `ATTENDANCE_API_URL` setting
to the URL printed by `deploy-attendance.ps1`. This local address only works
on the same laptop/Floci environment.

## Local Floci
```powershell
cd services/attendance
docker compose -f infra/docker-compose.floci.yml up -d
.\infra\deploy-attendance.ps1
```
The PowerShell deployment script targets localhost:4566 only and rejects real AWS accounts. The Lambda ZIP omits secrets.

## Vercel frontend origin (CORS)
The public Hader frontend is hosted at **https://hader-app-five.vercel.app**.
The Attendance Lambda Express API explicitly allows that browser origin, while preserving
`http://localhost:3003` for the demo and any additional local origins listed in `.env`.
For example, this optional setting also allows the shared frontend on port 8080:
```dotenv
CORS_ORIGINS=http://localhost:8080,http://localhost:3003,https://hader-app-five.vercel.app
```
The Floci packaging script carries the Vercel origin into Lambda settings even if an
older local `.env` specifies only localhost. Run `.\\infra\\deploy-attendance.ps1` again
after pulling these changes to update the running Lambda.

**CORS does not publish your API.** `attendance/attendance-config.js` still points to a
localhost Floci API, which is not reachable by visitors on Vercel (and plain HTTP
is blocked from an HTTPS site). To make the live Attendance page work, deploy the
Attendance API to a public HTTPS host and update `ATTENDANCE_API` to that **backend**
URL. Do not set `ATTENDANCE_API` to the Vercel **frontend** address. Also allow
that backend host in the frontend's Content-Security-Policy `connect-src` if CSP
is enabled on the Attendance page.

This branch has the full backend code. The separate shared frontend lives under `/attendance/`. **A local Floci URL is not a public HTTPS endpoint.** When the team deploys the frontend publicly, host the Attendance API over HTTPS and change `attendance/attendance-config.js` accordingly. The full three-service workflow and certificate integration still need end-to-end testing.
