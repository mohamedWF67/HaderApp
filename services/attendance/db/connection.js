// Validate without including the connection string in errors or logs.
module.exports = function attendanceConnection(value) {
  let url;
  try { url = new URL(value); } catch (_) {
    throw new Error('Set Attendance DATABASE_URL to a valid PostgreSQL connection URL.');
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) ||
      !['hader_attendance', 'hader_attendance.lydhdtlxodhyqjhvcfdu'].includes(url.username) ||
      !url.password || url.pathname !== '/postgres') {
    throw new Error('Attendance DATABASE_URL must use the dedicated hader_attendance login and postgres database.');
  }
  for (const key of ['sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'ssl']) {
    url.searchParams.delete(key);
  }
  return url.toString();
};
