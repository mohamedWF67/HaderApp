// An attendee's own registrations.
const express = require('express');
const { requireLogin, requireRole } = require('../middleware/auth');
const { parseId } = require('../validators/workshopValidator');
const registrations = require('../services/registrationService');

const router = express.Router();
router.use(requireLogin, requireRole('attendee'));

// GET /registrations/me -> my registrations -> 200
router.get('/me', async (req, res) => {
  res.json(await registrations.listMine(req.user.userId));
});

// DELETE /registrations/:id -> cancel MY registration, the seat is freed -> 200
router.delete('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  const result = await registrations.cancel(id, req.user.userId);
  console.log(JSON.stringify({ event: 'registration_cancelled', registrationId: id, workshopId: result.workshopId, seatGivenToWaitlist: result.seatGivenToWaitlist, userId: req.user.userId }));
  res.json(result);
});

module.exports = router;
