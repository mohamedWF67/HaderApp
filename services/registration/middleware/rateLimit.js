// Rate limiting: at most RATE_LIMIT_PER_MINUTE requests per minute from one address.
// Extra requests get 429 Too Many Requests.
//
// The count is kept in the DATABASE, not in memory: Lambda can run several copies of
// this code at once, and each copy has its own memory, so an in-memory counter could be
// bypassed by sending requests in parallel. One shared counter per minute cannot.
// (API Gateway throttling is also configured: on real AWS it blocks floods even earlier.)
const pool = require('../db/pool');

const LIMIT = Number(process.env.RATE_LIMIT_PER_MINUTE) || 100;

// The caller's address. Through API Gateway it comes from the Lambda event (lambda.js);
// on a laptop it comes from the network connection.
function clientAddress(req) {
  return req.sourceIp || req.socket?.remoteAddress || 'unknown';
}

async function rateLimit(req, res, next) {
  const bucket = `ip:${clientAddress(req)}`;
  let hits;
  try {
    // One row per address per minute; +1 for every request, in one atomic step.
    const { rows } = await pool.query(
      `INSERT INTO public.rate_limits (bucket, window_start, hits)
       VALUES ($1, date_trunc('minute', NOW()), 1)
       ON CONFLICT (bucket, window_start) DO UPDATE SET hits = public.rate_limits.hits + 1
       RETURNING hits, EXTRACT(EPOCH FROM (date_trunc('minute', NOW()) + INTERVAL '1 minute' - NOW()))::int AS reset`,
      [bucket]
    );
    hits = rows[0].hits;
    res.set('RateLimit-Limit', String(LIMIT));
    res.set('RateLimit-Remaining', String(Math.max(0, LIMIT - hits)));
    if (hits > LIMIT) {
      res.set('Retry-After', String(Math.max(1, rows[0].reset)));
      if (hits === LIMIT + 1) { // log once per address per minute, not for every blocked request
        console.log(JSON.stringify({ event: 'rate_limited', bucket, limit: LIMIT, path: req.path }));
      }
      return res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many requests. Please wait a minute and try again.' } });
    }
  } catch (err) {
    // If the counter itself fails, let the request through (the API stays available)
    // but record it, so the problem is visible in CloudWatch.
    console.error(JSON.stringify({ event: 'rate_limit_error', message: err.message }));
  }
  next();
}

module.exports = { rateLimit };
