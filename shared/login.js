// Login and sign-up page logic.
const loginForm = document.getElementById('login-form');
const signupForm = document.getElementById('signup-form');
const tabLogin = document.getElementById('tab-login');
const tabSignup = document.getElementById('tab-signup');
const message = document.getElementById('message');

function showTab(which) {
  loginForm.hidden = which !== 'login';
  signupForm.hidden = which !== 'signup';
  showMessage(message, '');
}
tabLogin.addEventListener('click', () => showTab('login'));
tabSignup.addEventListener('click', () => showTab('signup'));

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const button = loginForm.querySelector('button');
  button.disabled = true;
  try {
    await login(document.getElementById('login-email').value.trim(),
                document.getElementById('login-password').value);
    window.location.href = appUrl('registration/workshops.html');
  } catch (err) {
    showMessage(message, err.message, 'error');
  } finally {
    button.disabled = false;
  }
});

signupForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const button = signupForm.querySelector('button');
  button.disabled = true;
  try {
    const loggedIn = await signup(document.getElementById('signup-name').value.trim(),
                                  document.getElementById('signup-email').value.trim(),
                                  document.getElementById('signup-password').value);
    if (loggedIn) {
      window.location.href = appUrl('registration/workshops.html');
    } else {
      showTab('login');
      showMessage(message, 'Account created. Check your email to confirm it, then log in.', 'success');
    }
  } catch (err) {
    showMessage(message, err.message, 'error');
  } finally {
    button.disabled = false;
  }
});

// Already logged in? Go straight to the workshops.
if (getToken()) window.location.href = appUrl('registration/workshops.html');
