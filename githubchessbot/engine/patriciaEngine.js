// engine/patriciaEngine.js
const { spawn } = require('node:child_process');
const EventEmitter = require('node:events');
const path = require('node:path');

class PatriciaEngine extends EventEmitter {
  constructor(enginePath) {
    super();
    this.enginePath = enginePath || path.resolve(__dirname, 'patricia_v3.exe');
    this.proc = null;
    this.ready = false;
    this.buffer = '';
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

    // Initialize UCI handshake
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

  // Run a UCI search and resolve with bestmove and collected info lines
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

module.exports = PatriciaEngine;
