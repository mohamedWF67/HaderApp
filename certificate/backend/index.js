// Certificate Service - AWS Lambda entry point (handler = index.handler).
// Runs the Express app in app.js inside Lambda, the same way as the other team services.
import serverless from 'serverless-http';
import app from './app.js';

const run = serverless(app, {
  binary: ['application/pdf'], // the certificate PDF goes back base64-encoded
  request(req, event) {
    // Caller's IP from API Gateway, used by the rate limiter
    req.sourceIp = event?.requestContext?.http?.sourceIp // HTTP API
      || event?.requestContext?.identity?.sourceIp; // REST API
    // Floci/REST paths can carry a stage prefix ("/prod/certificates/..."): keep only "/certificates/..."
    req.url = req.url.replace(/^.*?(?=\/certificates)/, '');
  },
});

export async function handler(event, context) {
  // Events in the HTTP API shape (rawPath + requestContext.http.method) that don't say
  // version "2.0" - e.g. ones built by hand for `aws lambda invoke` in the test script -
  // would otherwise be read as REST events with no path. Mark them so they route correctly.
  if (!event.httpMethod && event.rawPath && event.requestContext?.http?.method && !event.version) {
    event.version = '2.0';
    event.rawQueryString ??= '';
    event.headers ??= {};
  }
  return run(event, context);
}
