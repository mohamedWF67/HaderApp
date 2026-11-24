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

## Local demo
```powershell
cd services/attendance
npm install
# configure .env locally with the working DATABASE_URL, PORT and Supabase endpoint
node demo-server.js
```
Open http://localhost:3003

## Local Floci
```powershell
cd services/attendance
docker compose -f infra/docker-compose.floci.yml up -d
.\infra\deploy-attendance.ps1
```
The PowerShell deployment script targets localhost:4566 only and rejects real AWS accounts. The Lambda ZIP omits secrets. Configure `CORS_ORIGINS=http://localhost:8080,http://localhost:3003` in your local `.env` before deploying if you test the shared frontend on port 8080.

This branch has the full backend code. The separate shared frontend lives under `/attendance/`. **A local Floci URL is not a public HTTPS endpoint.** When the team deploys the frontend publicly, host the Attendance API over HTTPS and change `attendance/attendance-config.js` accordingly. The full three-service workflow and certificate integration still need end-to-end testing.
