// Calls to the Certificate Service. Uses the same login token as the rest of the site
// (getToken / logout from shared/auth.js). The certificate backend returns errors as
// { "error": "message" }, so they are read here instead of in shared/api.js.

async function certFetch(path, { method = 'GET', body, auth = true } = {}) {
  const headers = {};
  if (auth) headers.Authorization = `Bearer ${getToken()}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let res;
  try {
    res = await fetch(CERTIFICATE_API + path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
  } catch (e) {
    throw new Error('Cannot reach the certificate service. Check that Floci is running, and that ' +
      `FRONTEND_ORIGIN in the backend is set to ${window.location.origin}.`);
  }

  // Login expired or invalid -> log in again (same behaviour as the other pages).
  if (res.status === 401 && auth) {
    logout();
    throw new Error('Please log in again.');
  }

  if (!res.ok) {
    const data = await res.json().catch(() => null);
    const text = data && (typeof data.error === 'string' ? data.error : data.error && data.error.message);
    const err = new Error(text || `Request failed (${res.status}).`);
    err.status = res.status;
    throw err;
  }
  return res;
}

async function certApi(path, options) {
  return (await certFetch(path, options)).json();
}

// Public link anyone can open to check a certificate.
function verifyPageUrl(code) {
  return appUrl(`certificate/verify.html?code=${encodeURIComponent(code)}`);
}
