import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

// This accepts only the isolated title-upgrade test profile, never the user's home.
const [entryUrl] = process.argv.slice(2);
if (!entryUrl) throw new Error('usage: node scripts/cleanup-smoke.mjs ISOLATED_TEST_URL');
const base = new URL(entryUrl).origin;
assert.equal(base, 'http://127.0.0.1:49979');
const auth = await fetch(entryUrl, { redirect: 'manual' });
const cookie = auth.headers.get('set-cookie')?.split(';')[0]; assert.ok(cookie);
async function request(route, options = {}, expectedStatus) {
  const response = await fetch(base + route, { ...options, headers: { Cookie: cookie, ...options.headers } });
  const result = await response.json();
  if (expectedStatus) assert.equal(response.status, expectedStatus);
  else assert.ok(response.ok, `HTTP ${response.status}: ${JSON.stringify(result)}`);
  return result;
}
const api = '/api/deepseek-chat-migration?route=';
const post = value => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
const sleep = () => new Promise(resolve => setTimeout(resolve, 50));
async function readyState() {
  let state = await request(api + '/state');
  while (state.metadataRepair?.status === 'running' || state.cleanup?.status === 'running') { await sleep(); state = await request(api + '/state'); }
  return state;
}
async function list() {
  const response = await request('/api/session/list', post({ type: 'client-request', rpcId: 'synthetic-cleanup-smoke', method: 'session/list', payload: { args: { _request: {} } } }));
  assert.equal(response.result?.ok, true); return response.result.value.items;
}
const home = 'test-results/title-upgrade-home';
async function nativeHashes() {
  const root = join(home, 'sessions'), hashes = {};
  for (const project of await readdir(root, { withFileTypes: true })) if (project.isDirectory()) {
    for (const session of await readdir(join(root, project.name), { withFileTypes: true })) if (session.isDirectory()) {
      for (const file of await readdir(join(root, project.name, session.name))) if (/\.jsonl(?:\.zstd)?$/.test(file)) {
        hashes[session.name] = createHash('sha256').update(await readFile(join(root, project.name, session.name, file))).digest('hex');
      }
    }
  }
  return hashes;
}
let state = await readyState(); assert.equal(state.version, '1.0.2');
const legacy = state.jobs.find(job => job.results.some(result => result.sourceId === 'synthetic-branch-example'));
const fresh = state.jobs.find(job => job.results.some(result => result.sourceId === 'synthetic-fresh-1.0.1'));
assert.ok(legacy && fresh, 'prepare the title-upgrade isolated profile before this destructive synthetic test');
const before = await nativeHashes();
const originalFile = await readFile('test/fixtures/deepseek-branches.json');
await request(api + '/jobs/not-a-job/clear', post({ mode: 'records' }), 404);
await request(api + '/jobs/' + fresh.id + '/clear', post({ mode: 'unknown' }), 400);
assert.deepEqual(await nativeHashes(), before);

await request(api + '/jobs/' + legacy.id + '/clear', post({ mode: 'records' }), 202);
state = await readyState();
assert.equal(state.cleanup.recordsCleared, true); assert.equal(state.cleanup.failed, 0);
assert.ok(!state.jobs.some(job => job.id === legacy.id));
assert.deepEqual(await nativeHashes(), before, 'report-only clearing must not modify any native log');

// The same upload remains and a repeat import still skips the original native IDs.
let oldUpload;
for (const upload of state.uploads) {
  const detail = await request(api + '/uploads/' + upload.id);
  if (detail.conversations.some(item => item.id === 'synthetic-branch-example')) oldUpload = upload;
}
assert.ok(oldUpload);
const repeat = await request(api + '/uploads/' + oldUpload.id + '/jobs', post(legacy.request), 202);
let repeatJob = repeat;
while (repeatJob.status === 'running') { await sleep(); repeatJob = await request(api + '/jobs/' + repeat.id); }
assert.equal(repeatJob.skipped, 2); assert.equal(repeatJob.imported, 0);

await request(api + '/jobs/' + fresh.id + '/clear', post({ mode: 'sessions-and-records' }), 202);
state = await readyState();
assert.equal(state.cleanup.recordsCleared, true);
assert.equal(state.cleanup.deleted, 2); assert.equal(state.cleanup.failed, 0);
const removed = new Set(fresh.results.map(result => result.sessionId));
const after = await nativeHashes(); const rows = await list();
for (const id of removed) { assert.equal(after[id], undefined); assert.ok(!rows.some(row => row.sessionId === id)); }
for (const id of legacy.results.map(result => result.sessionId)) assert.equal(after[id], before[id], 'unrelated import logs must stay byte-identical');
assert.ok(!state.jobs.some(job => job.id === fresh.id));
assert.equal(state.uploads.length, 1, 'the unreferenced local copy for deleted sessions is cleared');
assert.deepEqual(await readFile('test/fixtures/deepseek-branches.json'), originalFile, 'the original export is untouched');
assert.equal(rows.filter(row => Object.hasOwn(after, row.sessionId)).length, 2);
const report = { version: state.version, invalidRequestsDidNotDelete: true, reportOnlyPreservedAllLogs: true,
  reportOnlyPreservedDedup: { skipped: repeatJob.skipped, imported: repeatJob.imported },
  physicalDelete: { deleted: state.cleanup.deleted, failed: state.cleanup.failed, nativeListEntriesRemoved: 2,
    unrelatedNativeLogsByteIdentical: 2, originalExportUnchanged: true, orphanedLocalUploadCleared: true },
  actualUserProfileModified: false };
await writeFile('test-results/cleanup-smoke-report.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
