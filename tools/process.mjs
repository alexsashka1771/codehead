import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const python = join(root, '.venv', 'Scripts', 'python.exe');

export function run(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: root, stdio: 'inherit', windowsHide: true, ...options,
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${file.split(/[\\/]/).at(-1)} exited with ${code ?? signal}`));
    });
  });
}

export function pythonEnvironment(extra = {}) {
  return { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1', ...extra };
}
