/**
 * Start (or seed) the Python security service using the local venv when
 * present, so `npm run dev:security` works the same on Windows and Unix.
 *
 * Usage:
 *   node scripts/run-security.mjs            # uvicorn --reload
 *   node scripts/run-security.mjs --seed     # scripts/seed_demo.py
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const service = join(root, 'services', 'security');
const seed = process.argv.includes('--seed');

const candidates = [
  join(service, '.venv', 'Scripts', 'python.exe'),
  join(service, '.venv', 'bin', 'python'),
  join(service, 'venv', 'Scripts', 'python.exe'),
  join(service, 'venv', 'bin', 'python'),
];

const python = candidates.find((path) => existsSync(path)) ?? 'python';
// WatchFiles --reload on Windows + OneDrive often exits the reloader after the
// first save, which looks like the security service crashed mid-coding.
const reload = process.platform === 'win32' ? [] : ['--reload'];
const args = seed
  ? ['scripts/seed_demo.py']
  : ['-m', 'uvicorn', 'app.main:app', ...reload, '--host', '192.168.0.16', '--port', '8081'];

const child = spawn(python, args, {
  cwd: service,
  stdio: 'inherit',
  env: process.env,
  shell: python === 'python',
});

child.on('exit', (code) => process.exit(code ?? 1));
