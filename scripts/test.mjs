import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdir, readdir } from 'node:fs/promises';
await mkdir('test-results', { recursive: true });
await build({ entryPoints: ['test/client.test.tsx'], outfile: 'test-results/client.test.mjs', bundle: true, format: 'esm', platform: 'node', packages: 'external', target: 'node22', loader: { '.css': 'text' } });
const tests = (await readdir('test')).filter(name => name.endsWith('.test.ts')).map(name => `test/${name}`);
const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...tests, 'test-results/client.test.mjs'], { stdio: 'inherit' });
process.exitCode = result.status ?? 1;
