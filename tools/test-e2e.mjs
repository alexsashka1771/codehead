import { execFileSync, spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ensureLocalDatabase } from './postgres.mjs';
import { root, python, pythonEnvironment, run } from './process.mjs';

const withWorker = process.argv.includes('--with-worker');
const playwrightArgs = process.argv.slice(2).filter(argument => argument !== '--with-worker');
const databaseUrl = await ensureLocalDatabase('codehead_test');
const setupEnvironment = pythonEnvironment({ CODEHEAD_TEST_DATABASE_URL: databaseUrl });
const { schema } = JSON.parse(execFileSync(python, ['tools/prepare_test_database.py'], {
  cwd: root, env: setupEnvironment, encoding: 'utf8', windowsHide: true,
}));
const reportDirectory = join(root, '.data', 'reports', `e2e-${Date.now()}`);
await mkdir(reportDirectory, { recursive: true });
const environment = { ...setupEnvironment, CODEHEAD_DATABASE_URL: databaseUrl,
  CODEHEAD_TEST_SCHEMA: schema, CODEHEAD_E2E_BASE_URL: 'http://127.0.0.1:5181',
  CODEHEAD_TEST_REPORT_DIR: reportDirectory, CODEHEAD_E2E_WITH_WORKER: withWorker ? '1' : '0',
  CODEHEAD_TEST_STEP_DELAY_SECONDS: '1.5' };
// Playwright sets FORCE_COLOR for its workers; avoid conflicting terminal flags.
delete environment.NO_COLOR;
const supervisor = spawn(python, ['-X', 'utf8', 'tools/dev.py', '--api-port', '8011',
  '--frontend-port', '5181', '--stdin-control', ...(withWorker ? [] : ['--no-worker'])], {
  cwd: root, env: environment, windowsHide: true, stdio: ['pipe', 'inherit', 'inherit'],
});
const exited = new Promise((resolve, reject) => {
  supervisor.once('error', reject);
  supervisor.once('exit', (code) => resolve(code));
});
try {
  const deadline = Date.now() + 35_000;
  let ready = false;
  while (!ready && Date.now() < deadline) {
    if (supervisor.exitCode !== null) throw new Error('Test supervisor exited during startup.');
    try {
      const health = await fetch('http://127.0.0.1:8011/health', { signal: AbortSignal.timeout(1000) });
      const frontend = await fetch(environment.CODEHEAD_E2E_BASE_URL, { signal: AbortSignal.timeout(1000) });
      const healthState = await health.json();
      ready = health.ok && healthState.command_security === 'ready' && frontend.ok
        && (!withWorker || healthState.stage === 'worker');
    } catch (error) {
      if (!(error instanceof TypeError) && error.name !== 'TimeoutError') throw error;
    }
    if (!ready) await delay(250);
  }
  if (!ready) throw new Error('Browser test environment was not ready in time.');
  await run(process.execPath, [join(root, 'node_modules/@playwright/test/cli.js'), 'test',
    '--config', 'playwright.config.ts', ...playwrightArgs], { env: environment });
} finally {
  supervisor.stdin.end('stop\n');
  const outcome = await Promise.race([exited, delay(15_000).then(() => 'timeout')]);
  if (outcome === 'timeout') throw new Error('Test supervisor did not stop; inspect its owned processes.');
  console.log(`Browser test artifacts: ${reportDirectory}`);
}
