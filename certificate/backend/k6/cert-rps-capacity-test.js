// Optional: find the ceiling (like Lab 08's rps-capacity-test.js)
// Drives a fixed number of requests per second (not users) at the public verify endpoint and
// raises it every 30 s. The summary shows, for each rate, how many requests failed and who refused
// them, so you can see the rate where the ceiling is reached.
//
// Run (PowerShell, from certificate\backend), with the limits raised first:
//   .\k6\set-load-limits.ps1 -Raise
//   k6 run -e VERIFY_CODE=<a real 20-character code> k6\cert-rps-capacity-test.js
//   .\k6\set-load-limits.ps1 -Restore
// Optional: -e START_RATE=5  -e STEP=10  (requests/s)

import http from 'k6/http';
import { check, fail } from 'k6';
import { Counter } from 'k6/metrics';

const CERT_URL = __ENV.CERT_URL || 'http://localhost:4566/execute-api/db247435f9/prod';
const CODE = __ENV.VERIFY_CODE;
const START = Number(__ENV.START_RATE || 5);
const STEP = Number(__ENV.STEP || 10);
const STAGE_SECONDS = 30;
const RATES = [0, 1, 2, 3, 4, 5].map((i) => START + STEP * i);

const rateLimited = new Counter('rate_limited_429');
const lambdaLimited = new Counter('rate_limited_lambda_429');   // "Rate Exceeded": Floci Lambda concurrency
const gatewayLimited = new Counter('rate_limited_gateway_429'); // "Too Many Requests": API Gateway throttle
const appLimited = new Counter('rate_limited_app_429');         // our limiter: limits not raised
const timeouts = new Counter('timeouts');

const perStage = {};
for (const r of RATES) {
  perStage[`http_req_failed{stage:${r}/s}`] = ['rate>=0'];
  perStage[`http_req_duration{stage:${r}/s,expected_response:true}`] = ['max>=0'];
  perStage[`rate_limited_429{stage:${r}/s}`] = ['count>=0'];
}

export const options = {
  scenarios: {
    verify_capacity: {
      executor: 'ramping-arrival-rate',
      startRate: START,
      timeUnit: '1s',
      preAllocatedVUs: 50,
      maxVUs: 300,
      stages: RATES.map((r) => ({ duration: `${STAGE_SECONDS}s`, target: r })),
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.05'],
    http_req_duration: ['p(95)<1000'],
    ...perStage,
  },
  summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'max'],
};

export function setup() {
  if (!CODE) fail('Pass -e VERIFY_CODE=<code> (copy it from a certificate or from Bruno 0. Setup)');
  return { start: Date.now() };
}

export default function (data) {
  const i = Math.min(RATES.length - 1, Math.floor((Date.now() - data.start) / 1000 / STAGE_SECONDS));
  const stage = `${RATES[i]}/s`;
  const res = http.get(`${CERT_URL}/certificates/verify/${CODE}`, { tags: { stage } });
  check(res, { 'status is 200': (r) => r.status === 200 });

  if (res.status === 0) timeouts.add(1, { stage });
  if (res.status === 429) {
    rateLimited.add(1, { stage });
    const body = String(res.body || '');
    if (body.includes('Try again in')) appLimited.add(1, { stage });
    else if (body.includes('Rate Exceeded')) lambdaLimited.add(1, { stage });
    else gatewayLimited.add(1, { stage });
  }
}
