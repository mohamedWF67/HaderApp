// GET /me -> who am I? Lets the frontend show the right buttons for the user's role.
// (Showing or hiding buttons is only for convenience: every route still checks the role itself.)
const express = require('express');
const pool = require('../db/pool');
const { requireLogin } = require('../middleware/auth');

const router = express.Router();

router.get('/', requireLogin, async (req, res) => {
  const { rows } = await pool.query('SELECT name FROM public.profiles WHERE id = $1', [req.user.userId]);
  res.json({ userId: req.user.userId, role: req.user.role, name: rows[0] ? rows[0].name : '' });
});

module.exports = router;
