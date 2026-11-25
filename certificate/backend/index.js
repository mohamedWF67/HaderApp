// Certificate Service - AWS Lambda entry point (handler = index.handler).
// Runs the Express app in app.js inside Lambda, the same way as the other team services.
import serverless from 'serverless-http';
import app from './app.js';

export const handler = serverless(app, {
  binary: ['application/pdf'], // the certificate PDF goes back base64-encoded
  request(req, event) {
    // Caller's IP from API Gateway, used by the rate limiter
    req.sourceIp = event?.requestContext?.http?.sourceIp // HTTP API
      || event?.requestContext?.identity?.sourceIp; // REST API
    // Floci/REST paths can carry a stage prefix ("/prod/certificates/..."): keep only "/certificates/..."
    req.url = req.url.replace(/^.*?(?=\/certificates)/, '');
  },
});
