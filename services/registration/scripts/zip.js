// Builds lambda.zip for AWS Lambda: the code, the certificate and the libraries.
// It never includes .env (secrets), tests or the zip itself.
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');

const root = path.resolve(__dirname, '..');
const out = path.join(root, 'lambda.zip');
const include = ['app.js', 'lambda.js', 'scheduler.js', 'package.json', 'db', 'middleware', 'routes', 'services', 'validators', 'certs', 'node_modules'];

const output = fs.createWriteStream(out);
const zip = archiver('zip', { zlib: { level: 9 } });
output.on('close', () => console.log(`lambda.zip ready (${(zip.pointer() / 1024 / 1024).toFixed(1)} MB)`));
zip.on('error', (err) => { throw err; });
zip.pipe(output);

for (const item of include) {
  const full = path.join(root, item);
  if (!fs.existsSync(full)) continue;
  if (fs.statSync(full).isDirectory()) {
    zip.directory(full, item, (entry) => (entry.name.startsWith('archiver') ? false : entry));
  } else {
    zip.file(full, { name: item });
  }
}
zip.finalize();
