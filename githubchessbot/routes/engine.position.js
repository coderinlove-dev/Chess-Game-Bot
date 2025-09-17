// routes/engine.position.js
const express = require('express');

module.exports = function createPositionRouter(engine) {
  const router = express.Router();

  // Body: { fen: "..." }
  router.post('/position', async (req, res) => {
    try {
      const { fen } = req.body || {};
      if (!fen || typeof fen !== 'string') {
        return res.status(400).json({ ok: false, error: 'fen is required' });
      }
      if (!engine.ready) {
        // Make sure engine is ready; uci/isready already sent in constructor
        // If not ready, wait once
        await new Promise((resolve) => {
          if (engine.ready) return resolve();
          engine.once('ready', resolve);
        });
      }

      engine.send(`ucinewgame`);
      engine.send(`position fen ${fen}`);
      // Optional: ensure ready
      const readyPromise = new Promise((resolve) => {
        const onLine = (line) => {
          if (line === 'readyok') {
            engine.off('line', onLine);
            resolve();
          }
        };
        engine.on('line', onLine);
        engine.send('isready');
      });
      await readyPromise;

      return res.json({ ok: true });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err?.message || 'internal error' });
    }
  });

  return router;
};
