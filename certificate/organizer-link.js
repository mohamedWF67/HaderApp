// "Certificates" is one navbar link for everyone, but the pages differ by role:
// attendees get My certificates (this page), organizers get Manage certificates.
// Loaded before certificates.js so organizers are sent on as early as possible.
// (Only which page to show - the backend still enforces every role check.)
(async function sendOrganizersToManage() {
  try {
    const me = await api(CONFIG.REGISTRATION_API, '/me');
    if (me.role === 'organizer') window.location.replace(appUrl('certificate/manage.html'));
  } catch (e) { /* Registration API unreachable: stay here, certificates.js shows the message */ }
})();
