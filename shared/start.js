// Start page: logged in -> workshops, otherwise -> login.
window.location.replace(sessionStorage.getItem('hader_token')
  ? 'registration/workshops.html' : 'login.html');
