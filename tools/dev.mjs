import { join } from 'node:path';
import { python, pythonEnvironment, root, run } from './process.mjs';

// Compatibility entry point; Python owns process supervision.
await run(python, ['-X', 'utf8', join(root, 'tools/dev.py')], { env: pythonEnvironment() });
