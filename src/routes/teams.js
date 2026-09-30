const express = require('express');
const teams = require('../teams');

const router = express.Router();

// Team standings, open to every signed-in member of the app.
router.get('/teams', async (_req, res) => {
  res.json({ teams: await teams.board() });
});

router.get('/teams/mine', async (req, res) => {
  const team = await teams.myTeam(req.user.db_id);
  if (!team) return res.json({ team: null });
  const d = await teams.detail(team.id);
  res.json(d);
});

router.post('/teams', async (req, res) => {
  const result = await teams.create(req.user.db_id, req.body && req.body.name, req.body && req.body.tagline);
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(result);
});

router.post('/teams/join', async (req, res) => {
  const result = await teams.join(req.user.db_id, req.body && req.body.code);
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(result);
});

router.post('/teams/leave', async (req, res) => {
  const result = await teams.leave(req.user.db_id);
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(result);
});

router.post('/teams/disband', async (req, res) => {
  const result = await teams.disband(req.user.db_id);
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(result);
});

module.exports = router;