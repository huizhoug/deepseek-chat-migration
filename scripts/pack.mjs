import { mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const projectDirectory = fileURLToPath(new URL('..', import.meta.url));
await mkdir(new URL('../dist/', import.meta.url), { recursive: true });

// npm supplies its CLI path when this script runs through npm run.
const result = process.env.npm_execpath
  ? spawnSync(process.execPath, [process.env.npm_execpath, 'pack', '--pack-destination', 'dist'], {
      cwd: projectDirectory,
      stdio: 'inherit',
    })
  : spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', '--pack-destination', 'dist'], {
      cwd: projectDirectory,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
