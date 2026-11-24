// My notifications (any logged-in user: organizers and attendees both receive them).
const express = require('express');
const { requireLogin } = require('../middleware/auth');
const notifications = require('../services/notificationService');

const router = express.Router();
router.use(requireLogin);

// GET /notifications/me -> my latest notifications + unread count -> 200
router.get('/me', async (req, res) => {
  res.json(await notifications.listMine(req.user.userId));
});

// POST /notifications/read -> mark all my notifications as read -> 200
router.post('/read', async (req, res) => {
  res.json(await notifications.markAllRead(req.user.userId));
});

module.exports = router;
