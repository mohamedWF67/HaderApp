# Certificate Service load test (k6)

Modelled on Lab 08 (Scale and Secure, Floci).

## Install once
```powershell
winget install k6 --source winget   # then close and reopen PowerShell
k6 version
```

## Run A: load / stress test (about 3 min)
From `certificate\backend`, with Floci running:
```powershell
.\k6\set-load-limits.ps1 -Raise
k6 run -e SUPABASE_KEY=<publishable key> -e ATTENDEE_PASSWORD=<password> k6\cert-load-test.js
.\k6\set-load-limits.ps1 -Restore
```
Stages: ramp-up, steady (20% of peak), spike, hold at peak (`PEAK_VUS`, default 50), ramp-down.

Mix per loop: 50% public verify, 20% my certificates, 15% eligibility (calls Attendance and Registration), 10% PDF download, 5% unknown code (404 expected).

Thresholds: p(95) < 500 ms (`-e P95_MS=...` to change), http_req_failed < 5%.

Record in the results: p(95) (overall and per endpoint), http_req_failed, http_reqs/s, rate_limited_429, upstream_unavailable_503.

## Run S: show the limiter working
Run the same command **without** `-Raise`. You should see many `rate_limited_429` and the `CertificateRateLimited` alarm fire. That is the security control doing its job.

## Optional: find the ceiling
```powershell
k6 run -e VERIFY_CODE=<code> k6\cert-rps-capacity-test.js
```
The stage where p(95) jumps and `dropped_iterations` appears is the laptop's ceiling.

## Notes
- Read-only: it creates, revokes and emails nothing, so no data reset is needed between runs.
- The 5% unknown-code requests log `certificate_verify_failed`, so the VerifyFailed alarm may fire during the run.
- Floci does not enforce the API Gateway throttling settings; only the app's rate limiter is in play.
- Save a machine-readable copy with `--summary-export k6\results-runA.json`.

## End-to-end load test (Registration -> Attendance -> Certificates)
Each virtual user repeats the full Bruno folder 6 flow: create workshop, register, add session,
open check-in, mark present, eligibility, generate certificate, download PDF, verify.
Uses `testorganizer@hader.test` and the attendee `mohamed.wf67@gmail.com`.
```powershell
.\k6\set-load-limits.ps1 -Raise -NoEmail
k6 run -e SUPABASE_KEY=<key> -e ORGANIZER_PASSWORD=<pw> -e ATTENDEE_PASSWORD=<attendee pw> k6\e2e-load-test.js
.\k6\set-load-limits.ps1 -Restore
```
Then run `k6\e2e-cleanup.sql` in the Supabase SQL editor: it removes every workshop titled
`k6 load test ...` with its sessions, attendance, registrations, notifications and certificates.

Read: `e2e_flow_success` (share of complete flows), `e2e_flow_duration` (one full flow),
`http_req_duration{step:...}` (time per step) and `e2e_step_failed{step:...}` (where flows broke).
