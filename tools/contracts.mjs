import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { compile } from 'json-schema-to-typescript';

const root = fileURLToPath(new URL('../', import.meta.url));
const python = join(root, '.venv', 'Scripts', 'python.exe');
const schema = execFileSync(python, ['-m', 'codehead.export_contracts'], {
  cwd: root, encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
});
const types = await compile(JSON.parse(schema), 'CodeHeadContracts', {
  bannerComment: '/* Generated from Python contracts. Run npm run contracts; do not edit. */',
  additionalProperties: false,
  style: { singleQuote: true, semi: true },
});
const outputs = {
  'schema.json': schema.replaceAll('\r\n', '\n'),
  'index.ts': `${types}\nexport type DomainEvent = EventsPage['events'][number];\n`,
};
const directory = join(root, 'packages', 'contracts');
if (!process.argv.includes('--check')) await mkdir(directory, { recursive: true });
for (const [name, contents] of Object.entries(outputs)) {
  const path = join(directory, name);
  if (process.argv.includes('--check')) {
    if ((await readFile(path, 'utf8')).replaceAll('\r\n', '\n') !== contents) {
      throw new Error(`Contract drift in ${name}. Run npm run contracts.`);
    }
  } else {
    await writeFile(path, contents, 'utf8');
  }
}
console.log(process.argv.includes('--check') ? 'Contracts are in sync.' : 'Contracts generated.');
