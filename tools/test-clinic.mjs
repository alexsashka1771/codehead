import { execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureLocalDatabase } from './postgres.mjs';
import { python, pythonEnvironment, root, run } from './process.mjs';

const databaseUrl = await ensureLocalDatabase('codehead_test');
const environment = pythonEnvironment({ CODEHEAD_TEST_DATABASE_URL: databaseUrl });
const { schema } = JSON.parse(execFileSync(python, ['tools/prepare_test_database.py'], {
  cwd: root, env: environment, encoding: 'utf8', windowsHide: true,
}));
const reportDirectory = join(root, '.data', 'reports', `clinic-candidate-${Date.now()}`);
await mkdir(reportDirectory, { recursive: true });
try {
  await run(python, ['-X', 'utf8', 'tools/verify_clinic_candidate.py', '--schema', schema,
    '--report-root', reportDirectory], { env: environment });
} finally {
  console.log(`Clinic candidate checks: ${reportDirectory}`);
}
