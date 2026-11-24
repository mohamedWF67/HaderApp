// AWS Lambda entry point for the SCHEDULED checks (handler = scheduler.handler).
// EventBridge Scheduler runs it every minute. It has no API Gateway route, so nobody
// can call it from the internet. Same code package as the API, different entry point.
const { runScheduledChecks } = require('./services/notificationService');

module.exports.handler = async () => {
  const result = await runScheduledChecks();
  console.log(JSON.stringify({ event: 'scheduled_checks', ...result }));
  return result;
};
