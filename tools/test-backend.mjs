import { ensureLocalDatabase } from './postgres.mjs';
import { python, pythonEnvironment, run } from './process.mjs';

const url = await ensureLocalDatabase('codehead_test');
const selection = process.argv.slice(2);
await run(python, ['-m', 'pytest', ...(selection.length ? selection : ['apps/backend/tests']), '-q'], {
  env: pythonEnvironment({ CODEHEAD_TEST_DATABASE_URL: url }),
});
