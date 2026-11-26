import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureLocalDatabase } from './postgres.mjs';
import { python, pythonEnvironment, root, run } from './process.mjs';

const databaseUrl = await ensureLocalDatabase('codehead_test');
const environment = pythonEnvironment({ CODEHEAD_TEST_DATABASE_URL: databaseUrl });
const reportDirectory = join(root, '.data', 'reports', `preview-${Date.now()}`);
await mkdir(reportDirectory, { recursive: true });
const { schema } = JSON.parse(execFileSync(python, ['tools/prepare_test_database.py'], {
  cwd: root, env: environment, encoding: 'utf8', windowsHide: true,
}));
try {
  await run(python, ['-X', 'utf8', 'tools/verify_preview.py', '--schema', schema,
    '--report-root', reportDirectory, ...process.argv.slice(2)], { env: environment });
  const results = JSON.parse(await readFile(join(reportDirectory, 'results.json'), 'utf8'));
  await writeFile(join(reportDirectory, 'summary.json'), JSON.stringify({ status: 'passed', schema, results }, null, 2) + '\n');
} finally {
  console.log(`Preview checks: ${reportDirectory}`);
}
