// routes/engine.go.js
const express = require('express');

module.exports = function createGoRouter(engine) {
  const router = express.Router();

  // Body: { movetime?: number, depth?: number, nodes?: number, timelimitMs?: number }
  router.post('/go', async (req, res) => {
    try {
      const { movetime, depth, nodes, timelimitMs } = req.body || {};

      if (!engine.ready) {
        await new Promise((resolve) => {
          if (engine.ready) return resolve();
          engine.once('ready', resolve);
        });
      }

      // Build a UCI "go" command
      const args = [];
      if (typeof movetime === 'number' && movetime > 0) {
        args.push('movetime', Math.floor(movetime));
      }
      if (typeof depth === 'number' && depth > 0) {
        args.push('depth', Math.floor(depth));
      }
      if (typeof nodes === 'number' && nodes > 0) {
        args.push('nodes', Math.floor(nodes));
      }
      const goCmd = `go ${args.join(' ')}`.trim() || 'go';

      const result = await engine.search(goCmd, typeof timelimitMs === 'number' ? timelimitMs : 0);
      if (!result.ok) {
        return res.status(504).json(result);
      }
      return res.json(result);
    } catch (err) {
      return res.status(500).json({ ok: false, error: err?.message || 'internal error' });
    }
  });

  return router;
};
