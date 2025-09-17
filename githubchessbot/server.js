// server.js
const express = require('express');
const path = require('path');

// Use Express built-in JSON body parser (no need for body-parser)
const app = express();
app.use(express.json()); // parses req.body as JSON [web:48][web:47][web:65]

// Cross-origin isolation headers - keep for security if needed
app.use((req, res, next) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  next();
});

// Serve static files for your frontend app (index.html, JS, CSS, etc.)
app.use(express.static(path.join(__dirname), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.css')) {
      res.setHeader('Content-Type', 'text/css; charset=utf-8');
    }
  }
}));

// ----- Patricia engine wrapper (inline) -----
const { spawn } = require('node:child_process'); // spawn child process for UCI engine [web:54][web:50]
const EventEmitter = require('node:events');

class PatriciaEngine extends EventEmitter {
  constructor(enginePath) {
    super();
    this.enginePath = enginePath;
    this.proc = null;
    this.ready = false;
    this.start();
  }

  start() {
    if (this.proc) return;
    this.proc = spawn(this.enginePath, [], { cwd: path.dirname(this.enginePath) });

    this.proc.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      text.split(/\r?\n/).forEach((line) => {
        if (!line.trim()) return;
        this.emit('line', line);
      });
    });

    this.proc.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      this.emit('errorLine', text);
    });

    this.proc.on('exit', (code) => {
      this.emit('exit', code);
      this.proc = null;
      this.ready = false;
    });

    // UCI handshake
    this.send('uci');
    const onLine = (line) => {
      if (line === 'uciok') {
        this.send('isready');
      } else if (line === 'readyok') {
        this.ready = true;
        this.emit('ready');
        this.off('line', onLine);
      }
    };
    this.on('line', onLine);
  }

  send(cmd) {
    if (!this.proc) this.start();
    this.proc.stdin.write(cmd + '\n');
  }

  stop() {
    if (!this.proc) return;
    this.send('stop');
  }

  quit() {
    if (!this.proc) return;
    this.send('quit');
    this.proc.kill();
    this.proc = null;
    this.ready = false;
  }

  // Run a UCI search, resolve on "bestmove"
  search(goCmd, timeoutMs = 0) {
    return new Promise((resolve) => {
      const info = [];
      let resolved = false;

      const onLine = (line) => {
        if (line.startsWith('info ')) {
          info.push(line);
          return;
        }
        if (line.startsWith('bestmove ')) {
          const parts = line.trim().split(/\s+/);
          const bestmove = parts[1] || '(none)';
          cleanup();
          resolved = true;
          resolve({ ok: true, bestmove, info });
        }
      };

      const cleanup = () => {
        this.off('line', onLine);
        if (timer) clearTimeout(timer);
      };

      this.on('line', onLine);
      this.send(goCmd);

      let timer = null;
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          if (!resolved) {
            this.stop();
            cleanup();
            resolve({ ok: false, error: 'search timeout', info });
          }
        }, timeoutMs);
      }
    });
  }
}

// Initialize Patricia engine, adjust path if necessary
const enginePath = path.resolve(__dirname, 'engine', 'patricia_v3.exe');
const engine = new PatriciaEngine(enginePath);

// Optional: log engine output for debugging
engine.on('line', (l) => console.log('[engine]', l)); // stdout lines stream from child [web:50][web:56]
engine.on('errorLine', (l) => console.error('[engine-err]', l));

// Health check
app.get('/engine/health', (req, res) => {
  res.json({ ok: true, ready: engine.ready });
});

// POST /engine/position -> set FEN
// Body: { fen: "..." }
app.post('/engine/position', async (req, res) => {
  try {
    const { fen } = req.body || {};
    if (!fen || typeof fen !== 'string') {
      return res.status(400).json({ ok: false, error: 'fen is required' });
    }

    if (!engine.ready) {
      await new Promise((resolve) => {
        if (engine.ready) return resolve();
        engine.once('ready', resolve);
      });
    }

    engine.send('ucinewgame');
    engine.send(`position fen ${fen}`);

    // Ensure ready before returning
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

// POST /engine/go -> run search and return bestmove
// Body: { movetime?: number, depth?: number, nodes?: number, timelimitMs?: number }
app.post('/engine/go', async (req, res) => {
  try {
    const { movetime, depth, nodes, timelimitMs } = req.body || {};

    if (!engine.ready) {
      await new Promise((resolve) => {
        if (engine.ready) return resolve();
        engine.once('ready', resolve);
      });
    }

    const args = [];
    if (typeof movetime === 'number' && movetime > 0) args.push('movetime', Math.floor(movetime));
    if (typeof depth === 'number' && depth > 0) args.push('depth', Math.floor(depth));
    if (typeof nodes === 'number' && nodes > 0) args.push('nodes', Math.floor(nodes));
    const goCmd = `go ${args.join(' ')}`.trim() || 'go';

    const result = await engine.search(goCmd, typeof timelimitMs === 'number' ? timelimitMs : 0);
    if (!result.ok) return res.status(504).json(result);
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ ok: false, error: err?.message || 'internal error' });
  }
});

// Optional: graceful quit
app.post('/engine/quit', (req, res) => {
  engine.quit();
  res.json({ ok: true });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
  console.log(`👉 Patricia engine: ${enginePath}`);
});
