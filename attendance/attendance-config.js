// Team integration: local Floci endpoint from Mohamed's Attendance deployment.
// Floci is LOCAL ONLY: change this to the team's HTTPS Attendance API before
// publishing the Attendance page on Vercel. Do not store credentials here.
// Browsers must use localhost: host.docker.internal only works inside Docker containers,
// and other http:// addresses are blocked as mixed content on the https site.
const ATTENDANCE_API = "http://localhost:4566/execute-api/06d5250b39/$default";
