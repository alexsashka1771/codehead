import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { root, run } from './process.mjs';

const data = join(root, '.data', 'postgres');
const port = 55432;
const connection = { host: '127.0.0.1', port, user: 'codehead', database: 'postgres',
  connectionTimeoutMillis: 3000 };

async function binaries() {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new Error('The bundled development database requires Windows x64. Configure an external PostgreSQL instance on other platforms.');
  }
  return import('@embedded-postgres/windows-x64');
}

function clusterStatus(pgCtl) {
  return spawnSync(pgCtl, ['status', '-D', data], { windowsHide: true, encoding: 'utf8' });
}

export async function ensureLocalDatabase(database = 'codehead') {
  if (!['codehead', 'codehead_test'].includes(database)) {
    throw new Error('Only CodeHead development and test databases can be provisioned.');
  }
  const { initdb, pg_ctl: pgCtl } = await binaries();
  await mkdir(join(root, '.data'), { recursive: true });
  if (!existsSync(join(data, 'PG_VERSION'))) {
    await run(initdb, ['-D', data, '-U', 'codehead', '-A', 'trust', '--encoding=UTF8', '--locale=C']);
  }
  const major = (await readFile(join(data, 'PG_VERSION'), 'utf8')).trim();
  if (major !== '18') throw new Error(`Existing PostgreSQL ${major} data requires an explicit migration.`);

  const status = clusterStatus(pgCtl);
  if (status.error) throw status.error;
  if (status.status !== 0) {
    // The persistent server must not inherit the caller's stdout/stderr pipes.
    // Otherwise PowerShell and captured test runners wait for EOF until PostgreSQL stops.
    await run(pgCtl, ['start', '-D', data, '-l', join(root, '.data', 'postgres.log'),
      '-o', `-h 127.0.0.1 -p ${port}`, '-w', '-t', '30'], { stdio: 'ignore' });
  }
  const client = new pg.Client(connection);
  await client.connect();
  try {
    const result = await client.query("SELECT current_setting('data_directory') AS directory, current_setting('server_version') AS version");
    if (resolve(result.rows[0].directory).toLowerCase() !== resolve(data).toLowerCase()) {
      throw new Error('Port 55432 belongs to a different PostgreSQL cluster; it will not be modified.');
    }
    const exists = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]);
    if (!exists.rowCount) await client.query(`CREATE DATABASE "${database}" ENCODING 'UTF8'`);
    console.log(`PostgreSQL ${result.rows[0].version}: ${database} ready on 127.0.0.1:${port}.`);
  } finally {
    await client.end();
  }
  return `postgresql+psycopg://codehead@127.0.0.1:${port}/${database}`;
}

export async function stopLocalDatabase() {
  const { pg_ctl: pgCtl } = await binaries();
  if (existsSync(join(data, 'PG_VERSION')) && clusterStatus(pgCtl).status === 0) {
    await run(pgCtl, ['stop', '-D', data, '-m', 'fast', '-w', '-t', '30']);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv[2] === 'stop') await stopLocalDatabase();
  else await ensureLocalDatabase();
}
