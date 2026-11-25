// The Express application. Used by server.js (on your laptop) and lambda.js (in AWS).
const express = require('express');
const pool = require('./db/pool');
const { ApiError, notFoundRoute, errorHandler } = require('./middleware/errors');
const { rateLimit } = require('./middleware/rateLimit');

const app = express();

// CORS: only our own frontend may call this API from a browser.
const allowedOrigins = (process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
app.use((req, res, next) => {
  const origin = req.get('Origin');
  if (origin && allowedOrigins.includes(origin)) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Rate limit every request except the browser's CORS check (answered above).
app.use(rateLimit);

app.use(express.json({ limit: '10kb' }));

// Through API Gateway the body can arrive without a Content-Type that Express recognises.
// Express then leaves it as raw bytes, so we unpack it as JSON here (same 10 kB limit).
const MAX_BODY = 10 * 1024;
app.use((req, res, next) => {
  if (!Buffer.isBuffer(req.body) && typeof req.body !== 'string') return next();
  const raw = req.body.toString('utf8');
  if (raw.trim() === '') { req.body = undefined; return next(); }
  if (Buffer.byteLength(raw) > MAX_BODY) {
    return next(new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large.'));
  }
  // Plain JSON first; some gateways send it base64-encoded without saying so.
  for (const text of [raw, Buffer.from(raw, 'base64').toString('utf8')]) {
    try {
      req.body = JSON.parse(text);
      return next();
    } catch (e) { /* try the next form */ }
  }
  next(new ApiError(400, 'INVALID_JSON', 'Request body must be valid JSON.'));
});

// Health check: proves the API is running AND can reach the database.
// It is public, so it reveals nothing about the data (no counts, no names).
app.get('/health', async (req, res, next) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', database: 'connected' });
  } catch (err) {
    next(err);
  }
});

// The service's routes. Express 5 sends any error thrown in them to errorHandler.
app.use('/me', require('./routes/me'));
app.use('/workshops', require('./routes/workshops'));
app.use('/registrations', require('./routes/registrations'));
app.use('/waitlist', require('./routes/waitlist'));
app.use('/notifications', require('./routes/notifications'));

app.use(notFoundRoute);
app.use(errorHandler);

module.exports = app;
