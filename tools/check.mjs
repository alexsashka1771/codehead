import { dirname, join } from 'node:path';
import { python, pythonEnvironment, root, run } from './process.mjs';

const npmCli = process.env.npm_execpath || join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
await run(python, ['-m', 'ruff', 'check', 'apps/backend', 'tools'], { env: pythonEnvironment() });
await run(python, ['-m', 'ruff', 'format', '--check', 'apps/backend', 'tools'], { env: pythonEnvironment() });
await run(process.execPath, [join(root, 'tools/contracts.mjs'), '--check']);
await run(process.execPath, [npmCli, 'run', 'check', '--workspace', '@codehead/frontend']);
await run(process.execPath, [npmCli, 'run', 'test', '--workspace', '@codehead/frontend']);
console.log('Python lint, generated contracts, TypeScript and projection checks passed.');
