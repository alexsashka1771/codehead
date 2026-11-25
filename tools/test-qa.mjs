import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureLocalDatabase } from './postgres.mjs';
import { python, pythonEnvironment, root, run } from './process.mjs';

const databaseUrl = await ensureLocalDatabase('codehead_test');
const environment = pythonEnvironment({ CODEHEAD_TEST_DATABASE_URL: databaseUrl });
const selection = process.argv.slice(2);
const scenarios = [];
for (let index = 0; index < selection.length; index += 2) {
  if (selection[index] !== '--scenario' || !['standard', 'repair_success', 'repair_blocked'].includes(selection[index + 1])) {
    throw new Error('Use --scenario standard|repair_success|repair_blocked.');
  }
  scenarios.push(selection[index + 1]);
}
if (!scenarios.length) scenarios.push('standard', 'repair_success', 'repair_blocked');
if (new Set(scenarios).size !== scenarios.length) throw new Error('Select each scenario once.');
const reportDirectory = join(root, '.data', 'reports', `qa-${Date.now()}`);
await mkdir(reportDirectory, { recursive: true });
try {
  const results = [];
  for (const scenario of scenarios) {
    const { schema } = JSON.parse(execFileSync(python, ['tools/prepare_test_database.py'], {
      cwd: root, env: environment, encoding: 'utf8', windowsHide: true,
    }));
    await run(python, ['-X', 'utf8', 'tools/verify_quality.py', '--schema', schema,
      '--report-root', reportDirectory, '--scenario', scenario], { env: environment });
    results.push(JSON.parse(await readFile(join(reportDirectory, scenario, 'summary.json'), 'utf8')));
  }
  await writeFile(join(reportDirectory, 'summary.json'), JSON.stringify({ status: 'passed', results }, null, 2) + '\n');
} finally {
  console.log(`QA checks: ${reportDirectory}`);
}
