// Addresses the frontend talks to. Nothing secret here:
// the publishable key is designed to be public (tables are protected by RLS).
// Where the site lives (works on localhost:8080 and inside an S3 bucket folder).
const SITE_BASE = new URL('../', document.currentScript.src);

// Builds an address inside the site, for example appUrl('login.html').
function appUrl(page) {
  return new URL(page, SITE_BASE).href;
}

const CONFIG = {
  // Each service's API. Locally each runs on its own port; in AWS they become API Gateway addresses.
  REGISTRATION_API: 'http://localhost:3001',

  // Supabase Auth (login and sign-up)
  SUPABASE_URL: 'https://lydhdtlxodhyqjhvcfdu.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_RwEDDrJWI8dfQLh1k54qoQ_XduP2Bjv'
};
