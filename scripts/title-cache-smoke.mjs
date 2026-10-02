import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

// Use only an isolated official Harness profile and the synthetic fixture.
// Pass the ephemeral URL printed by that profile; it is never saved in reports.
const [phase, entryUrl] = process.argv.slice(2);
if (!['before', 'after', 'fresh'].includes(phase) || !entryUrl) throw new Error('usage: node scripts/title-cache-smoke.mjs before|after|fresh TEST_URL');
const base = new URL(entryUrl).origin;
const auth = await fetch(entryUrl, { redirect: 'manual' });
const cookie = auth.headers.get('set-cookie')?.split(';')[0];
assert.ok(cookie, 'isolated profile must authorize the request');
async function request(path, options = {}) {
  const response = await fetch(base + path, { ...options, headers: { Cookie: cookie, ...options.headers } });
  const body = await response.json();
  assert.ok(response.ok, `HTTP ${response.status}: ${body.error ?? JSON.stringify(body)}`);
  return body;
}
async function remote(method, requestValue) {
  const response = await request('/api/' + method, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    type: 'client-request', rpcId: 'synthetic-title-smoke', method, payload: { args: { [method === 'session/list' ? '_request' : 'request']: requestValue } },
  }) });
  assert.equal(response.result?.ok, true, JSON.stringify(response));
  return response.result.value;
}
const api = '/api/deepseek-chat-migration?route=';
let state = await request(api + '/state');
let job;
if (phase === 'before' || phase === 'fresh') {
  assert.equal(state.version, phase === 'before' ? '1.0.0' : '1.0.1');
  const sourceId = phase === 'fresh' ? 'synthetic-fresh-1.0.1' : 'synthetic-branch-example';
  job = state.jobs.find(item => item.imported === 2 && item.results[0]?.sourceId === sourceId);
  if (!job) {
  const path = resolve('test-results/title-upgrade-import-workspace');
  await mkdir(path, { recursive: true });
  await remote('workspace/create', { path });
  state = await request(api + '/state');
  const workspace = state.workspaces.find(item => item.path === path);
  assert.ok(workspace);
  const fixture = JSON.parse(await readFile('test/fixtures/deepseek-branches.json', 'utf8'));
  fixture[0].id = sourceId;
  if (phase === 'fresh') fixture[0].title = '合成测试：新版即时标题';
  const upload = await request('/api/deepseek-chat-migration.upload?route=/uploads', {
    method: 'POST', headers: { 'X-File-Name': 'conversations.json' }, body: JSON.stringify(fixture),
  });
  const detail = await request(api + '/uploads/' + upload.id);
  job = await request(api + '/uploads/' + upload.id + '/jobs', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      conversationIds: detail.conversations.map(item => item.id), workspaceId: workspace.id, branchMode: 'all', includeReasoning: false,
    }),
  });
  }
} else {
  assert.equal(state.version, '1.0.1');
  while (state.metadataRepair?.status === 'running') {
    await new Promise(resolve => setTimeout(resolve, 100));
    state = await request(api + '/state');
  }
  assert.equal(state.metadataRepair?.failed, 0);
  job = state.jobs.find(item => item.imported === 2);
  assert.ok(job, 'upgrade must retain the original import ledger and report');
}
while (job.status === 'running') {
  await new Promise(resolve => setTimeout(resolve, 100));
  job = await request(api + '/jobs/' + job.id);
}
assert.equal(job.imported, 2); assert.equal(job.failed, 0);
const native = await remote('session/list', {});
const rows = job.results.map(result => {
  const row = native.items.find(item => item.sessionId === result.sessionId);
  assert.ok(row, 'imported native session must be listed without opening it');
  assert.equal(row.agentAvailable, false);
  const actualTitle = row.projections?.values.title;
  if (phase === 'before') assert.equal(actualTitle, undefined, 'reproduce the cold sidebar bug');
  else {
    assert.equal(actualTitle, result.title);
    assert.equal(row.projections.kind, 'cached');
    assert.equal(row.projections.values.sessionListMetadata.blank, false);
    assert.ok(row.projections.values.sessionListMetadata.lastPromptAt > 0);
  }
  return { sessionId: row.sessionId, expectedTitle: result.title, actualTitle: actualTitle ?? null,
    agentAvailable: row.agentAvailable, projectionKind: row.projections?.kind ?? null };
});
const report = { phase, version: state.version, sessions: rows, metadataRepair: state.metadataRepair ?? null };
await writeFile(`test-results/title-cache-${phase}.json`, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ phase, version: state.version, coldSessionsChecked: rows.length,
  titlesVisible: rows.filter(item => item.actualTitle !== null).length, metadataRepair: state.metadataRepair ?? null }));
