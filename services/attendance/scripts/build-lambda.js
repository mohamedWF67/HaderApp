// Package the Lambda without exposing .env, tokens, local tests, or the dashboard.
// Prerequisites: npm install serverless-http archiver
// Usage: node scripts/build-lambda.js
const fs = require('fs');
const path = require('path');
// Archiver v8 exports ZipArchive as a class, not a callable function.
const { ZipArchive } = require('archiver');
const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
const outputFile = path.join(dist, 'attendance-lambda.zip');
fs.mkdirSync(dist, { recursive: true });
for (const essential of ['app.js', 'lambda.js', 'db/pool.js',
  'middleware/auth.js', 'routes/sessions.js', 'certs/prod-ca-2021.crt',
  'node_modules/serverless-http']) {
  if (!fs.existsSync(path.join(root, essential))) {
    console.error('Missing required file/package:', essential);
    console.error('Run npm install serverless-http archiver and try again.');
    process.exit(1);
  }
}
const target = fs.createWriteStream(outputFile);
const zip = new ZipArchive({ zlib: { level: 7 } });
target.on('close', () => {
  console.log('Lambda package ready: dist/attendance-lambda.zip (' +
    (zip.pointer() / 1024 / 1024).toFixed(2) + ' MB)');
});
zip.on('warning', err => { if (err.code !== 'ENOENT') throw err; });
zip.on('error', err => { throw err; });
zip.pipe(target);
for (const filename of ['app.js', 'lambda.js', 'package.json']) {
  const loc = path.join(root, filename);
  if (fs.existsSync(loc)) zip.file(loc, { name: filename });
}
for (const directory of ['db', 'middleware', 'routes', 'certs', 'node_modules']) {
  zip.directory(path.join(root, directory), directory);
}
zip.finalize();
