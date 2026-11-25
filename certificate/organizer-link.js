// On "My certificates": organizers get a link to the Manage certificates page.
// Kept in its own file so certificates.js stays the same for attendees.
(async function organizerLink() {
  try {
    const me = await api(CONFIG.REGISTRATION_API, '/me');
    if (me.role !== 'organizer') return;
    const p = document.getElementById('organizer-link');
    p.replaceChildren(el('a', { href: appUrl('certificate/manage.html') }, 'Manage the certificates of your workshops (revoke)'));
    p.hidden = false;
  } catch (e) { /* no link if the Registration API cannot be reached */ }
})();
