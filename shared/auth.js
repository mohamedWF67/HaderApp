// Login, sign-up and logout with Supabase Auth, using plain fetch().
// The login token is kept in sessionStorage: it disappears when the browser tab is closed.

const TOKEN_KEY = 'hader_token';

async function supabaseAuth(path, body) {
  const res = await fetch(`${CONFIG.SUPABASE_URL}/auth/v1/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: CONFIG.SUPABASE_PUBLISHABLE_KEY },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.msg || data.error_description || data.message || 'Login service error.');
  }
  return data;
}

async function login(email, password) {
  const data = await supabaseAuth('token?grant_type=password', { email, password });
  sessionStorage.setItem(TOKEN_KEY, data.access_token);
}

// New accounts are always attendees. The name is stored in the profile automatically.
async function signup(name, email, password) {
  const data = await supabaseAuth('signup', { email, password, data: { name } });
  // If email confirmation is on, there is no token until the user confirms their email.
  if (data.access_token) sessionStorage.setItem(TOKEN_KEY, data.access_token);
  return Boolean(data.access_token);
}

function getToken() {
  return sessionStorage.getItem(TOKEN_KEY);
}

function logout() {
  sessionStorage.removeItem(TOKEN_KEY);
  window.location.href = appUrl('login.html');
}

// Pages that need a login call this first. No token -> back to the login page.
function requireLoginPage() {
  if (!getToken()) {
    window.location.href = appUrl('login.html');
    return false;
  }
  return true;
}
