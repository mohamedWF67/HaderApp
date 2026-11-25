// Runs the API tests in tests/ against a deployed Registration API (Floci, Vercel or local).
//
//   npm run test:api -- --api http://XXXX.execute-api.localhost.floci.io:4566 --key <publishable key> --password <test password>
//
// Options:
//   --api URL         the API address (required)
//   --key KEY         Supabase publishable key, used by the test logins (required)
//   --password PW     password of the test users organizer1, nour, nada, nayera @hader.test (required)
//   --supabase URL    Supabase project URL (default: SUPABASE_URL from .env)
//   --security        also run the two security bursts below (each blocks/alarms for ~1 minute):
//                       * 25 requests without a login  -> 25 x 401, trips the access-denied alarm
//                       * 130 requests in fast waves   -> the ones after the 100th get 429 (limit 100/minute)
//   --security-only   run only the security bursts (skip the Postman collections)
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env'), quiet: true });
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const opt = name => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const api = (opt('api') || '').replace(/\/$/, '');
const key = opt('key');
const password = opt('password');
const supabase = opt('supabase') || process.env.SUPABASE_URL;
const securityOnly = args.includes('--security-only');
if (!api || (!securityOnly && (!key || !password || !supabase))) {
  console.error('Usage: npm run test:api -- --api URL --key SUPABASE_PUBLISHABLE_KEY --password TEST_PASSWORD [--security | --security-only]');
  process.exit(2);
}

const dir = path.resolve(__dirname, '..', 'tests');
const collections = securityOnly ? []
  : fs.readdirSync(dir).filter(f => f.endsWith('.postman_collection.json')).sort();
let failed = 0;
const q = v => `"${String(v).replace(/"/g, '')}"`;   // quote one argument for the shell
for (const file of collections) {
  console.log(`\n=== ${file}`);
  const cmd = ['npx', '-y', 'newman@6', 'run', q(path.join(dir, file)),
    '--env-var', q(`baseUrl=${api}`), '--env-var', q(`supabaseUrl=${supabase}`),
    '--env-var', q(`supabaseKey=${key}`), '--env-var', q(`testPassword=${password}`)].join(' ');
  const r = spawnSync(cmd, { stdio: 'inherit', shell: true });
  if (r.status !== 0) failed++;
}

// Sends n requests in small waves (Floci on a laptop cannot start many Lambda copies
// at the same instant: too many at once come back as 500 from Floci itself),
// and counts the answers by status code.
async function burst(label, n, url, headers, wave = 3) {
  const count = {};
  let firstError;
  for (let sent = 0; sent < n; sent += wave) {
    const codes = await Promise.all(Array.from({ length: Math.min(wave, n - sent) }, () =>
      fetch(url, { headers }).then(r => r.status).catch(e => { firstError = firstError || (e.cause?.code || e.message); return 'error'; })));
    codes.forEach(c => { count[c] = (count[c] || 0) + 1; });
  }
  console.log(`${label}:`, count);
  if (firstError) console.log(`  (connection errors, first one: ${firstError})`);
  return count;
}

(async () => {
  if (args.includes('--security') || securityOnly) {
    console.log('\n=== Security bursts');
    const denied = await burst('25 requests to /me without a login (expect 401)', 25, `${api}/me`, {});
    if (denied[401] !== 25) failed++;
    console.log('  -> within 1-2 minutes: aws cloudwatch describe-alarms --alarm-name-prefix hader-registration');
    console.log('     shows hader-registration-access-denied in ALARM');
    // The limit counts per calendar minute, so start at the beginning of a fresh minute:
    // then all 130 requests fall in the same minute and the ones after the 100th get 429.
    const wait = (60 - new Date().getSeconds()) % 60;
    if (wait > 0) {
      console.log(`Waiting ${wait} s for a fresh minute, so all requests count in the same minute...`);
      await new Promise(r => setTimeout(r, wait * 1000 + 300));
    }
    const started = Date.now();
    const flood = await burst('130 requests in fast waves to /health (expect 429 after the 100th this minute)', 130, `${api}/health`, {});
    console.log(`  (took ${((Date.now() - started) / 1000).toFixed(1)} s)`);
    if (!flood[429]) failed++;
    console.log('  -> wait one minute before using the API again (this minute\'s 100 requests are used up)');
  }
  console.log(failed ? `\n${failed} test group(s) FAILED` : '\nAll API tests passed');
  process.exit(failed ? 1 : 0);
})();
