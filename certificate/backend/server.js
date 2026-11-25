// Run the Certificate Service locally without Lambda:  node --env-file=.env server.js
import app from './app.js';

const port = Number(process.env.PORT || 3003);
app.listen(port, () => console.log(`Certificate Service on http://localhost:${port}`));
