// Starts the API on your laptop. In AWS, lambda.js is used instead.
require('dotenv').config({ quiet: true });
const app = require('./app');

const port = process.env.PORT || 3001;
app.listen(port, () => {
  console.log(`Registration service running on http://localhost:${port}`);
});
