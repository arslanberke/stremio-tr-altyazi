import { fork } from 'node:child_process';
import { setPriority } from 'node:os';
import { fileURLToPath } from 'node:url';

// Aligning is CPU-bound; it runs in a low-priority child process, one job at a time, so the
// server keeps answering requests (and the host's health check) while candidates sync.
const script = fileURLToPath(new URL('./worker.js', import.meta.url));
const pending = new Map();
let child = null;
let seq = 0;
let turn = Promise.resolve();

function start() {
  const c = fork(script, [], { serialization: 'advanced' });
  try { setPriority(c.pid, 19); } catch { /* not permitted */ }
  c.unref();
  c.channel?.unref();
  c.on('message', ({ id, value, error }) => {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    if (error) p.reject(new Error(error));
    else p.resolve(value);
  });
  c.on('exit', () => {
    if (child === c) child = null;
    for (const p of pending.values()) p.reject(new Error('sync worker exited'));
    pending.clear();
  });
  return c;
}

export function offload(name, args, timeoutMs = 180000) {
  const job = turn.then(() => new Promise((resolve, reject) => {
    child ??= start();
    const c = child;
    const id = ++seq;
    const timer = setTimeout(() => c.kill('SIGKILL'), timeoutMs);
    pending.set(id, {
      resolve: (v) => (clearTimeout(timer), resolve(v)),
      reject: (e) => (clearTimeout(timer), reject(e))
    });
    c.channel?.ref();
    c.send({ id, name, args });
  })).finally(() => {
    if (!pending.size) child?.channel?.unref();
  });
  turn = job.catch(() => {});
  return job;
}
