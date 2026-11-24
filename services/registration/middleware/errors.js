// One error format for every failure (Lab 3):
//   { "error": { "code": "VALIDATION_ERROR", "message": "..." } }

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// Unknown route -> 404
function notFoundRoute(req, res) {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found.' } });
}

// Central error handler (Lab 4). Known errors keep their status.
// Anything unexpected becomes 500 WITHOUT leaking internal details to the user.
function errorHandler(err, req, res, next) {
  if (err instanceof ApiError) {
    if (err.status === 401 || err.status === 403) {
      console.log(JSON.stringify({
        event: 'access_denied', status: err.status, method: req.method,
        path: req.path, userId: req.user ? req.user.userId : null
      }));
    }
    return res.status(err.status).json({ error: { code: err.code, message: err.message } });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Request body must be valid JSON.' } });
  }
  console.error(JSON.stringify({ event: 'server_error', method: req.method, path: req.path, message: err.message }));
  res.status(500).json({ error: { code: 'SERVER_ERROR', message: 'Something went wrong. Please try again.' } });
}

module.exports = { ApiError, notFoundRoute, errorHandler };
