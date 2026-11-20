const API = 'https://YOUR_API_GATEWAY_URL';

async function verify(code) {
  const result = document.getElementById('result');
  const res = await fetch(`${API}/certificates/verify/${encodeURIComponent(code)}`);
  if (!res.ok) {
    result.textContent = res.status === 429 ? 'Too many tries, wait a moment.' : 'No certificate matches this code.';
    return;
  }
  const c = await res.json();
  result.textContent = `Genuine: awarded to ${c.attendeeName} for "${c.workshopTitle}" on ${new Date(c.issuedAt).toDateString()}.`;
}

document.getElementById('verify-form').onsubmit = (ev) => {
  ev.preventDefault();
  verify(document.getElementById('code').value.trim());
};

// Links in emails look like verify.html?code=XXXX
const code = new URLSearchParams(location.search).get('code');
if (code) {
  document.getElementById('code').value = code;
  verify(code);
}
