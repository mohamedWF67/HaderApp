// Runs the scheduled checks once on your laptop:  npm run checks
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env'), quiet: true });
require('../scheduler').handler().then(r => { console.log(r); process.exit(0); })
  .catch(e => { console.error(e.message); process.exit(1); });
