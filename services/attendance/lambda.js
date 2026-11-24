// Handler used by AWS Lambda and Floci. Keep this file at the root of the ZIP.
// Lambda configuration: Handler = lambda.handler, Runtime = nodejs22.x.
require('dotenv').config({ quiet: true });

const serverless = require('serverless-http');
const app = require('./app');

module.exports.handler = serverless(app);
