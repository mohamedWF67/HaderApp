// AWS Lambda entry point (Lab 7): runs the same Express app inside Lambda.
// Lambda setting: handler = lambda.handler
const serverless = require('serverless-http');
const app = require('./app');

// Pass the caller's address from API Gateway to Express (used by the rate limiter).
module.exports.handler = serverless(app, {
  request(req, event) {
    req.sourceIp = event?.requestContext?.http?.sourceIp      // HTTP API
                || event?.requestContext?.identity?.sourceIp; // REST API
  }
});
