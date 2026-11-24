// Workshop routes. Each line says: method + path -> who may call it -> what runs.
const express = require('express');
const { requireLogin, requireRole } = require('../middleware/auth');
const { parseId, validateWorkshop } = require('../validators/workshopValidator');
const workshops = require('../services/workshopService');
const registrations = require('../services/registrationService');
const waitlist = require('../services/waitlistService');

const router = express.Router();

// Every route here needs a login first (401 if not logged in).
router.use(requireLogin);

// POST /workshops -> organizer creates a workshop -> 201
router.post('/', requireRole('organizer'), async (req, res) => {
  const data = validateWorkshop(req.body);
  const created = await workshops.createWorkshop(req.user.userId, data);
  console.log(JSON.stringify({ event: 'workshop_created', workshopId: created.workshopId, userId: req.user.userId }));
  res.status(201).json(created);
});

// GET /workshops -> anyone logged in lists workshops -> 200
router.get('/', async (req, res) => {
  res.json(await workshops.listWorkshops());
});

// PUT /workshops/:id -> the organizer who created it edits it -> 200
router.put('/:id', requireRole('organizer'), async (req, res) => {
  const id = parseId(req.params.id);
  const data = validateWorkshop(req.body);
  const updated = await workshops.updateWorkshop(id, req.user.userId, data);
  console.log(JSON.stringify({ event: 'workshop_updated', workshopId: id, userId: req.user.userId }));
  res.json(updated);
});

// DELETE /workshops/:id -> the organizer who created it deletes it (before it starts) -> 200
router.delete('/:id', requireRole('organizer'), async (req, res) => {
  const id = parseId(req.params.id);
  const result = await workshops.deleteWorkshop(id, req.user.userId);
  console.log(JSON.stringify({ event: 'workshop_deleted', workshopId: id, registrationsRemoved: result.registrationsRemoved, userId: req.user.userId }));
  res.json(result);
});

// POST /workshops/:id/waitlist -> attendee joins the queue of a FULL workshop -> 201
router.post('/:id/waitlist', requireRole('attendee'), async (req, res) => {
  const id = parseId(req.params.id);
  const entry = await waitlist.join(id, req.user.userId);
  console.log(JSON.stringify({ event: 'waitlist_joined', workshopId: id, waitlistId: entry.waitlistId, position: entry.position, userId: req.user.userId }));
  res.status(201).json(entry);
});

// POST /workshops/:id/registrations -> attendee registers -> 201
router.post('/:id/registrations', requireRole('attendee'), async (req, res) => {
  const id = parseId(req.params.id);
  const reg = await registrations.register(id, req.user.userId);
  console.log(JSON.stringify({ event: 'registered', workshopId: id, registrationId: reg.registrationId, userId: req.user.userId }));
  res.status(201).json(reg);
});

// GET /workshops/:id/registrations -> the workshop's organizer sees who registered -> 200
router.get('/:id/registrations', requireRole('organizer'), async (req, res) => {
  const id = parseId(req.params.id);
  res.json(await registrations.listForWorkshop(id, req.user.userId));
});

// DELETE /workshops/:id/registrations/:registrationId -> the workshop's organizer removes an attendee -> 200
router.delete('/:id/registrations/:registrationId', requireRole('organizer'), async (req, res) => {
  const id = parseId(req.params.id);
  const registrationId = parseId(req.params.registrationId, 'registrationId');
  const result = await registrations.removeAttendee(id, registrationId, req.user.userId);
  console.log(JSON.stringify({
    event: 'attendee_removed', workshopId: id, registrationId,
    removedUserId: result.attendeeId, seatGivenToWaitlist: result.seatGivenToWaitlist, userId: req.user.userId
  }));
  res.json(result);
});

module.exports = router;
