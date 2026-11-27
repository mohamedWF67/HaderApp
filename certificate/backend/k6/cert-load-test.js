// Certificate Service load / stress test (k6), modelled on Lab 08's social-load-test.js
//
// Run (PowerShell, from certificate\backend):
//   .\k6\set-load-limits.ps1 -Raise          # raise the per-IP rate limits for this run
//   k6 run -e SUPABASE_KEY=<publishable key> -e ATTENDEE_PASSWORD=<password> k6\cert-load-test.js
//   .\k6\set-load-limits.ps1 -Restore        # put the normal limits back
//
// Optional: -e PEAK_VUS=100  -e P95_MS=800  -e CERT_URL=...  -e ATTENDEE_EMAIL=...
//
// The test is read-only: it never generates or revokes certificates and sends no emails,
// so every run starts from the same data (no reset needed).

import http from 'k6/http';
import { check, sleep, fail } from 'k6';
import { Counter, Rate } from 'k6/metrics';

const CERT_URL = __ENV.CERT_URL || 'http://localhost:4566/execute-api/db247435f9/prod';
const SUPABASE_URL = __ENV.SUPABASE_URL || 'https://lydhdtlxodhyqjhvcfdu.supabase.co';
const SUPABASE_KEY = __ENV.SUPABASE_KEY;
const EMAIL = __ENV.ATTENDEE_EMAIL || 'mohamed.wf67@gmail.com';
const PASSWORD = __ENV.ATTENDEE_PASSWORD;
const PEAK = Number(__ENV.PEAK_VUS || 50);
const P95_MS = Number(__ENV.P95_MS || 500);
const LOW = Math.max(1, Math.round(PEAK * 0.2));

// Custom counters, like rate_limited_429 in the lab
const rateLimited = new Counter('rate_limited_429');       // all 429s
const appLimited = new Counter('rate_limited_app_429');    // our limiter (body "Too many requests. Try again in ...")
const gatewayLimited = new Counter('rate_limited_gateway_429'); // anything else: API Gateway throttling
const upstream503 = new Counter('upstream_unavailable_503'); // Attendance/Registration did not answer
const serverErrors = new Counter('server_errors_5xx');
const unexpectedStatus = new Rate('unexpected_status');    // any answer other than the expected one

export const options = {
  scenarios: {
    certificate_mix: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: LOW },  // ramp-up
        { duration: '45s', target: LOW },  // steady
        { duration: '15s', target: PEAK }, // spike
        { duration: '45s', target: PEAK }, // hold
        { duration: '30s', target: 0 },    // ramp-down   (about 3 min in total)
      ],
      gracefulRampDown: '10s',
    },
  },
  thresholds: {
    http_req_duration: [`p(95)<${P95_MS}`], // the slow tail users notice
    http_req_failed: ['rate<0.05'],         // under 5% failed (5xx, 429, no answer)
    unexpected_status: ['rate<0.05'],
    // Always-true thresholds so the summary prints one line per endpoint
    'http_req_duration{endpoint:verify}': ['max>=0'],
    'http_req_duration{endpoint:verify_unknown}': ['max>=0'],
    'http_req_duration{endpoint:me}': ['max>=0'],
    'http_req_duration{endpoint:eligibility}': ['max>=0'],
    'http_req_duration{endpoint:pdf}': ['max>=0'],
    // Where the 429s happened (shown per endpoint in the summary)
    'rate_limited_429{endpoint:verify}': ['count>=0'],
    'rate_limited_429{endpoint:verify_unknown}': ['count>=0'],
    'rate_limited_429{endpoint:me}': ['count>=0'],
    'rate_limited_429{endpoint:eligibility}': ['count>=0'],
    'rate_limited_429{endpoint:pdf}': ['count>=0'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'max'],
};

// Runs once before the virtual users start: log in and find a certificate to use
export function setup() {
  if (!SUPABASE_KEY || !PASSWORD) {
    fail('Pass -e SUPABASE_KEY=<publishable key> -e ATTENDEE_PASSWORD=<password>');
  }
  const login = http.post(
    `${SUPABASE_URL}/auth/v1/token?grant_type=password`,
    JSON.stringify({ email: EMAIL, password: PASSWORD }),
    { headers: { apikey: SUPABASE_KEY, 'Content-Type': 'application/json' }, tags: { endpoint: 'setup' } },
  );
  if (login.status !== 200) fail(`Supabase login failed: ${login.status} ${login.body}`);
  const token = login.json('access_token');

  const me = http.get(`${CERT_URL}/certificates/me`, {
    headers: { Authorization: `Bearer ${token}` },
    tags: { endpoint: 'setup' },
  });
  if (me.status === 429) fail('Got 429 in setup: run .\\k6\\set-load-limits.ps1 -Raise first');
  if (me.status !== 200) fail(`GET /certificates/me failed: ${me.status} ${me.body}`);
  const cert = (me.json('certificates') || []).find((c) => !c.revoked_at);
  if (!cert) fail(`${EMAIL} has no valid certificate: generate one in the app first`);

  return {
    token,
    certId: cert.certificate_id,
    code: cert.verification_code,
    workshopId: String(cert.workshop_id),
  };
}

let shown429 = false; // print one gateway 429 per user so we can see who sent it

function record(res, expected, endpoint) {
  const ok = check(res, { [`status is ${expected}`]: (r) => r.status === expected });
  unexpectedStatus.add(!ok);
  if (res.status === 429) {
    const tags = { endpoint };
    rateLimited.add(1, tags);
    if (String(res.body || '').includes('Too many requests. Try again in')) appLimited.add(1, tags);
    else {
      gatewayLimited.add(1, tags);
      if (!shown429) {
        shown429 = true;
        console.warn(`gateway 429 on ${endpoint}: headers=${JSON.stringify(res.headers)} body=${String(res.body).slice(0, 300)}`);
      }
    }
  }
  if (res.status === 503) upstream503.add(1);
  if (res.status >= 500) serverErrors.add(1);
}

// What each virtual user does per loop (realistic mix: most traffic is public verification)
//   50% verify a real certificate (public, what employers do)
//   20% attendee lists "my certificates"
//   15% attendee checks eligibility (calls the Attendance + Registration services)
//   10% attendee downloads the PDF (heaviest: builds the PDF and QR code)
//    5% verify an unknown code (expected 404)
export default function (data) {
  const auth = { Authorization: `Bearer ${data.token}` };
  const r = Math.random();

  if (r < 0.5) {
    const res = http.get(`${CERT_URL}/certificates/verify/${data.code}`, { tags: { endpoint: 'verify' } });
    record(res, 200, 'verify');
  } else if (r < 0.7) {
    const res = http.get(`${CERT_URL}/certificates/me`, { headers: auth, tags: { endpoint: 'me' } });
    record(res, 200, 'me');
  } else if (r < 0.85) {
    const res = http.get(`${CERT_URL}/certificates/eligibility/${data.workshopId}`, {
      headers: auth,
      tags: { endpoint: 'eligibility' },
    });
    record(res, 200, 'eligibility');
  } else if (r < 0.95) {
    const res = http.get(`${CERT_URL}/certificates/${data.certId}`, {
      headers: auth,
      tags: { endpoint: 'pdf' },
    });
    record(res, 200, 'pdf');
  } else {
    const res = http.get(`${CERT_URL}/certificates/verify/AAAAAAAAAAAAAAAAAAAA`, {
      tags: { endpoint: 'verify_unknown' },
      responseCallback: http.expectedStatuses(404), // a 404 here is the correct answer, not a failure
    });
    record(res, 404, 'verify_unknown');
  }

  sleep(0.5 + Math.random()); // think time between clicks
}
