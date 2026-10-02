import { build } from 'esbuild';
import { mkdir, readFile } from 'node:fs/promises';
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
await mkdir(new URL('../lib', import.meta.url), { recursive: true });
await build({ entryPoints: ['src/index.ts'], outfile: 'lib/index.js', bundle: true, format: 'esm', platform: 'node', target: 'node22', external: ['@deepseek-ai/cordis', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-session-persistence', '@deepseek-ai/dsh-session-title', '@deepseek-ai/dsh-session-projection-cache', '@deepseek-ai/dsh-session-persistence-jsonl', '@deepseek-ai/dsh-session-query'], sourcemap: false });
await build({ entryPoints: ['src/client.tsx'], outfile: 'lib/client.js', bundle: true, format: 'cjs', platform: 'browser', target: 'es2022', external: ['@deepseek-ai/*', 'react', 'react/*', 'react-dom', 'react-dom/*'], loader: { '.css': 'text' },
  define: { 'process.env.NODE_ENV': '"production"' },
  banner: { js: `window.__ModuleLoader__.load({id:${JSON.stringify(manifest.name)},factory:(require)=>{var module={exports:{}};var exports=module.exports;` },
  footer: { js: 'return module.exports;}});' } });
console.log(`Built ${manifest.name} ${manifest.version}`);
