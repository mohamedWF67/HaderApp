// End-to-end load test across all three services (k6):
//   Registration -> Attendance -> Certificates, the same flow as Bruno folder 6, but many at once.
//
// Each virtual user repeats one complete flow:
//   1. organizer creates a workshop          (Registration)
//   2. attendee registers                    (Registration)
//   3. organizer adds a session              (Attendance)
//   4. organizer opens check-in              (Attendance)
//   5. organizer marks the attendee present  (Attendance)
//   6. attendee checks eligibility           (Certificates -> Attendance)
//   7. attendee generates the certificate    (Certificates -> Attendance + Registration)
//   8. attendee downloads the PDF            (Certificates)
//   9. public verify of the code             (Certificates)
//
// Run (PowerShell, from certificate\backend):
//   .\k6\set-load-limits.ps1 -Raise -NoEmail
//   k6 run -e SUPABASE_KEY=<key> -e ORGANIZER_PASSWORD=<pw> -e ATTENDEE_PASSWORD=<attendee pw> k6\e2e-load-test.js
//   .\k6\set-load-limits.ps1 -Restore
//   then run k6\e2e-cleanup.sql in the Supabase SQL editor (removes the test workshops)
//
// Optional: -e PEAK_VUS=10  -e ORGANIZER_EMAIL=...  -e ATTENDEE_EMAIL=...
// Uses testorganizer@hader.test and the attendee mohamed.wf67@gmail.com (run e2e-cleanup.sql afterwards).

import http from 'k6/http';
import { check, fail, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

const CERT_URL = __ENV.CERT_URL || 'http://localhost:4566/execute-api/db247435f9/prod';
const REG_URL = __ENV.REGISTRATION_URL || 'http://localhost:4566/execute-api/28d22b6d02/$default';
const ATT_URL = __ENV.ATTENDANCE_URL || 'http://localhost:4566/execute-api/06d5250b39/$default';
const SUPABASE_URL = __ENV.SUPABASE_URL || 'https://lydhdtlxodhyqjhvcfdu.supabase.co';
const SUPABASE_KEY = __ENV.SUPABASE_KEY;
const ORGANIZER_EMAIL = __ENV.ORGANIZER_EMAIL || 'testorganizer@hader.test';
const ATTENDEE_EMAIL = __ENV.ATTENDEE_EMAIL || 'mohamed.wf67@gmail.com';
const PEAK = Number(__ENV.PEAK_VUS || 5);
const LOW = Math.max(1, Math.round(PEAK * 0.4));
const TITLE_PREFIX = 'k6 load test'; // e2e-cleanup.sql deletes workshops with this prefix

const flowOk = new Rate('e2e_flow_success');        // share of flows that reached the end
const flowTime = new Trend('e2e_flow_duration', true); // one complete flow, all 9 steps
const stepFailed = new Counter('e2e_step_failed');  // tagged with the step that broke the flow
const rateLimited = new Counter('rate_limited_429');

const STEPS = ['1_create_workshop', '2_register', '3_add_session', '4_open_checkin', '5_mark_present',
  '6_eligibility', '7_generate', '8_pdf', '9_verify'];
const perStep = {};
for (const s of STEPS) {
  perStep[`http_req_duration{step:${s}}`] = ['max>=0'];
  perStep[`e2e_step_failed{step:${s}}`] = ['count>=0'];
}

export const options = {
  scenarios: {
    e2e_flow: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: LOW },  // ramp-up
        { duration: '60s', target: LOW },  // steady
        { duration: '15s', target: PEAK }, // spike
        { duration: '45s', target: PEAK }, // hold
        { duration: '20s', target: 0 },    // ramp-down
      ],
      gracefulRampDown: '30s',
    },
  },
  thresholds: {
    e2e_flow_success: ['rate>0.95'],
    http_req_failed: ['rate<0.05'],
    e2e_flow_duration: ['p(95)<10000'], // one full flow (9 requests across 3 services) under 10 s
    ...perStep,
  },
  summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'max'],
};

function login(email, password) {
  const res = http.post(
    `${SUPABASE_URL}/auth/v1/token?grant_type=password`,
    JSON.stringify({ email, password }),
    { headers: { apikey: SUPABASE_KEY, 'Content-Type': 'application/json' }, tags: { step: 'setup' } },
  );
  if (res.status !== 200) fail(`Login failed for ${email}: ${res.status} ${res.body}`);
  return res.json('access_token');
}

export function setup() {
  if (!SUPABASE_KEY || !__ENV.ORGANIZER_PASSWORD || !__ENV.ATTENDEE_PASSWORD) {
    fail('Pass -e SUPABASE_KEY=... -e ORGANIZER_PASSWORD=... -e ATTENDEE_PASSWORD=... (attendee = mohamed.wf67@gmail.com)');
  }
  return {
    organizer: login(ORGANIZER_EMAIL, __ENV.ORGANIZER_PASSWORD),
    attendee: login(ATTENDEE_EMAIL, __ENV.ATTENDEE_PASSWORD),
  };
}

function params(token, step, json = true) {
  const headers = { Authorization: `Bearer ${token}` };
  if (json) headers['Content-Type'] = 'application/json';
  return { headers, tags: { step } };
}

// Returns true if the step answered with the expected status; otherwise records where the flow broke.
function ok(res, step, expected) {
  const passed = check(res, { [`${step} -> ${expected}`]: (r) => r.status === expected });
  if (res.status === 429) rateLimited.add(1, { step });
  if (!passed) {
    stepFailed.add(1, { step });
    console.warn(`${step} failed: ${res.status} ${String(res.body || res.error).slice(0, 200)}`);
  }
  return passed;
}

export default function (data) {
  const org = data.organizer;
  const att = data.attendee;
  const started = Date.now();
  const finish = (success) => {
    flowOk.add(success);
    if (success) flowTime.add(Date.now() - started);
  };

  // 1. organizer creates a workshop (one week ahead, so it is still open for registration)
  let res = http.post(`${REG_URL}/workshops`, JSON.stringify({
    title: `${TITLE_PREFIX} ${__VU}-${__ITER} ${Date.now()}`,
    description: 'Created by the k6 end-to-end load test',
    date: new Date(Date.now() + 7 * 864e5).toISOString(),
    totalSeats: 5,
  }), params(org, STEPS[0]));
  if (!ok(res, STEPS[0], 201)) return finish(false);
  const workshopId = res.json('workshopId');

  // 2. attendee registers
  res = http.post(`${REG_URL}/workshops/${workshopId}/registrations`, null, params(att, STEPS[1], false));
  if (!ok(res, STEPS[1], 201)) return finish(false);
  const registrationId = res.json('registrationId');

  // 3. organizer adds a session
  const start = Date.now() + 60000;
  res = http.post(`${ATT_URL}/workshops/${workshopId}/sessions`, JSON.stringify({
    title: 'Session 1',
    startTime: new Date(start).toISOString(),
    endTime: new Date(start + 3600000).toISOString(),
  }), params(org, STEPS[2]));
  if (!ok(res, STEPS[2], 201)) return finish(false);
  const sessionId = res.json('sessionId');

  // 4. organizer opens check-in
  res = http.patch(`${ATT_URL}/workshops/${workshopId}/sessions/${sessionId}/checkin`,
    JSON.stringify({ status: 'open' }), params(org, STEPS[3]));
  if (!ok(res, STEPS[3], 200)) return finish(false);

  // 5. organizer marks the attendee present
  res = http.post(`${ATT_URL}/workshops/${workshopId}/sessions/${sessionId}/attendance`,
    JSON.stringify({ registrationId }), params(org, STEPS[4]));
  if (!ok(res, STEPS[4], 201)) return finish(false);

  // 6. attendee checks eligibility (Certificates calls Attendance)
  res = http.get(`${CERT_URL}/certificates/eligibility/${workshopId}`, params(att, STEPS[5], false));
  if (!ok(res, STEPS[5], 200)) return finish(false);

  // 7. attendee generates the certificate (Certificates calls Attendance and Registration)
  res = http.post(`${CERT_URL}/certificates`, JSON.stringify({ workshopId }), params(att, STEPS[6]));
  if (!ok(res, STEPS[6], 201)) return finish(false);
  const certId = res.json('certificate_id');
  const code = res.json('verification_code');

  // 8. attendee downloads the PDF
  res = http.get(`${CERT_URL}/certificates/${certId}`, params(att, STEPS[7], false));
  if (!ok(res, STEPS[7], 200)) return finish(false);

  // 9. anyone verifies the code (public)
  res = http.get(`${CERT_URL}/certificates/verify/${code}`, { tags: { step: STEPS[8] } });
  if (!ok(res, STEPS[8], 200)) return finish(false);

  finish(true);
  sleep(1); // pause before the next flow
}
