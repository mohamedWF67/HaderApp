// An attendee's own places in waiting lists.
const express = require('express');
const { requireLogin, requireRole } = require('../middleware/auth');
const { parseId } = require('../validators/workshopValidator');
const waitlist = require('../services/waitlistService');

const router = express.Router();
router.use(requireLogin, requireRole('attendee'));

// GET /waitlist/me -> the queues I am in, with my position -> 200
router.get('/me', async (req, res) => {
  res.json(await waitlist.listMine(req.user.userId));
});

// DELETE /waitlist/:id -> leave MY place in a queue -> 200
router.delete('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  const result = await waitlist.leave(id, req.user.userId);
  console.log(JSON.stringify({ event: 'waitlist_left', waitlistId: id, workshopId: result.workshopId, userId: req.user.userId }));
  res.json(result);
});

module.exports = router;
