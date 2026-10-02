import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { strToU8, zipSync } from 'fflate';
import { MAX_CONVERSATIONS_BYTES } from '../src/archive.js';
import { MigrationEngine } from '../src/engine.js';
import { API_PATH, createApiHandler } from '../src/http.js';
import type { HarnessAdapter, HarnessImportInput, ImportedSession } from '../src/types.js';

class HttpNativeStore implements HarnessAdapter {
  sessions = new Map<string, ImportedSession>();
  repairSessionMetadata?: HarnessAdapter['repairSessionMetadata'];
  deleteImportedSession?: HarnessAdapter['deleteImportedSession'];
  async listWorkspaces() { return [{ id: 'workspace-test', title: '合成测试工作区', path: '/synthetic/workspace' }]; }
  async sessionExists(id: string) { return this.sessions.has(id); }
  async importConversation(input: HarnessImportInput) {
    const result = { sessionId: input.sessionId, workspaceId: input.workspaceId, title: input.title, messageCount: input.branch.messages.length };
    this.sessions.set(input.sessionId, result); return result;
  }
}
const exportBytes = strToU8(JSON.stringify([{ id: 'http-synthetic', title: 'HTTP 合成例', messages: [{ role: 'user', content: '测试问题' }, { role: 'assistant', content: '测试回答' }] }]));
function request(route: string, init: RequestInit = {}) {
  return new Request(`http://127.0.0.1${API_PATH}?route=${encodeURIComponent(route)}`, init);
}
async function setup(context: TestContext, adapter = new HttpNativeStore()) {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-migration-http-test-'));
  const engine = new MigrationEngine(root, adapter);
  context.after(async () => { await engine.close(); await rm(root, { recursive: true, force: true }); });
  await engine.init();
  return { root, adapter, engine, handler: createApiHandler(engine) };
}

test('HTTP upload, preview, import, report, and raw deletion form an end-to-end flow', async context => {
  const { handler, engine, adapter } = await setup(context);
  const uploadResponse = await handler(request('/uploads', { method: 'POST', headers: { 'X-File-Name': encodeURIComponent('合成导出.json') }, body: exportBytes }));
  assert.equal(uploadResponse.status, 201);
  assert.equal(uploadResponse.headers.get('Cache-Control'), 'no-store');
  assert.equal(uploadResponse.headers.get('X-Content-Type-Options'), 'nosniff');
  const upload = await uploadResponse.json();
  assert.equal(upload.filename, '合成导出.json');
  const previewResponse = await handler(request(`/uploads/${upload.id}`));
  assert.equal(previewResponse.status, 200);
  const preview = await previewResponse.json();
  assert.equal(preview.conversations[0].messageCount, 2);
  const detail = await handler(request(`/uploads/${upload.id}/conversations/http-synthetic`));
  assert.equal((await detail.json()).branches[0].messages.length, 2);
  const startedResponse = await handler(request(`/uploads/${upload.id}/jobs`, { method: 'POST', body: JSON.stringify({ workspaceId: 'workspace-test', conversationIds: ['http-synthetic'], branchMode: 'all', includeReasoning: true }) }));
  assert.equal(startedResponse.status, 202);
  const started = await startedResponse.json();
  await engine.idle();
  const reportResponse = await handler(request(`/jobs/${started.id}`));
  assert.equal((await reportResponse.json()).imported, 1);
  const downloaded = await handler(request(`/jobs/${started.id}/report`));
  assert.equal(downloaded.status, 200);
  assert.match(downloaded.headers.get('Content-Disposition')!, /^attachment; filename="deepseek-migration-/);
  const downloadedText = await downloaded.text();
  assert.equal(JSON.parse(downloadedText).imported, 1);
  assert.equal(downloadedText.includes('测试问题'), false);
  assert.equal(downloadedText.includes('测试回答'), false);
  assert.equal(downloadedText.includes('conversationIds'), false);
  const stateResponse = await handler(request('/state'));
  assert.equal((await stateResponse.json()).uploads.length, 1);
  const remove = await handler(new Request(`http://127.0.0.1${API_PATH}?route=${encodeURIComponent(`/uploads/${upload.id}`)}&method=DELETE`, { method: 'POST' }));
  assert.equal(remove.status, 200);
  assert.equal(adapter.sessions.size, 1);
  assert.equal((await handler(request(`/uploads/${upload.id}`))).status, 404);
});

test('bad routes, filenames, job options and unsupported files return bounded errors', async context => {
  const { handler, adapter } = await setup(context);
  assert.equal((await handler(request('/unknown'))).status, 404);
  assert.equal((await handler(request('/uploads', { method: 'POST', headers: { 'X-File-Name': '%' }, body: exportBytes }))).status, 400);
  assert.equal((await handler(request('/uploads', { method: 'POST', body: strToU8('not-json') }))).status, 400);
  const upload = await (await handler(request('/uploads', { method: 'POST', body: exportBytes }))).json();
  for (const options of ['{bad-json', '{}', JSON.stringify({ workspaceId: 'workspace-test', conversationIds: ['http-synthetic'], branchMode: 'all', includeReasoning: 'yes' })]) {
    const response = await handler(request(`/uploads/${upload.id}/jobs`, { method: 'POST', body: options }));
    assert.equal(response.status, 400);
    assert.equal(typeof (await response.json()).error, 'string');
  }
  assert.equal(adapter.sessions.size, 0);
  const inheritedUpload = await handler(request('/uploads/__proto__'));
  assert.equal(inheritedUpload.status, 404);
  assert.equal((await inheritedUpload.json()).error.includes('ENOENT'), false);
});

test('declared oversized upload and streamed oversized options are rejected before migration', async context => {
  const { handler, engine, adapter } = await setup(context);
  const response = await handler(request('/uploads', { method: 'POST', headers: { 'Content-Length': String(200 * 1024 * 1024 + 1) }, body: strToU8('[]') }));
  assert.equal(response.status, 413);
  assert.equal((await engine.state()).uploads.length, 0);
  const upload = await engine.upload(exportBytes, 'conversations.json');
  const chunk = new Uint8Array(600 * 1024);
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(chunk); controller.enqueue(chunk); controller.close(); } });
  const optionsRequest = request(`/uploads/${upload.id}/jobs`, { method: 'POST', body: stream, duplex: 'half' } as RequestInit);
  assert.equal((await handler(optionsRequest)).status, 413);
  assert.equal(adapter.sessions.size, 0);
});

test('invalid ZIP and selected-file expansion bombs leave no retained upload files', async context => {
  const { handler, root, engine } = await setup(context);
  const missing = zipSync({ 'user.json': strToU8('{"private":"synthetic"}') });
  const maliciousPath = zipSync({ '../conversations.json': exportBytes });
  const oversized = zipSync({ 'conversations.json': exportBytes });
  const view = new DataView(oversized.buffer);
  for (let index = 0; index < oversized.length - 46; index++) {
    if (view.getUint32(index, true) === 0x02014b50) { view.setUint32(index + 24, MAX_CONVERSATIONS_BYTES + 1, true); break; }
  }
  for (const archive of [missing, maliciousPath, oversized]) {
    const response = await handler(request('/uploads', { method: 'POST', headers: { 'X-File-Name': 'synthetic.zip' }, body: archive }));
    assert.equal(response.status, 400);
    assert.equal(typeof (await response.json()).error, 'string');
  }
  assert.equal((await engine.state()).uploads.length, 0);
  assert.deepEqual(await readdir(join(root, 'exports')), []);
});

test('metadata repair POST returns progress and rejects concurrent imports without duplicating native sessions', async context => {
  const { handler, adapter, engine } = await setup(context);
  assert.equal((await handler(request('/metadata/repair'))).status, 404);
  const unsupported = await handler(request('/metadata/repair', { method: 'POST' }));
  assert.equal(unsupported.status, 400);
  assert.match((await unsupported.json()).error, /不支持/);
  const upload = await engine.upload(exportBytes, 'conversations.json');
  const options = { workspaceId: 'workspace-test', conversationIds: ['http-synthetic'], branchMode: 'all', includeReasoning: true } as const;
  const started = await handler(request(`/uploads/${upload.id}/jobs`, { method: 'POST', body: JSON.stringify(options) }));
  const job = await started.json();
  await engine.idle();
  const sessionId = engine.job(job.id).results[0]!.sessionId;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const repairedIds: string[] = [];
  adapter.repairSessionMetadata = async id => { repairedIds.push(id); await gate; return adapter.sessions.has(id); };
  const repairResponse = await handler(request('/metadata/repair', { method: 'POST' }));
  try {
    assert.equal(repairResponse.status, 202);
    const initial = await repairResponse.json();
    assert.equal(initial.status, 'running');
    assert.equal(initial.total, 1);
    const state = await (await handler(request('/state'))).json();
    assert.equal(state.metadataRepair.status, 'running');
    assert.equal(state.metadataRepair.processed, 0);
    const conflicting = await handler(request(`/uploads/${upload.id}/jobs`, { method: 'POST', body: JSON.stringify(options) }));
    assert.equal(conflicting.status, 409);
    assert.match((await conflicting.json()).error, /修复/);
  } finally { release(); }
  await engine.idle();
  const completed = (await (await handler(request('/state'))).json()).metadataRepair;
  assert.equal(completed.status, 'completed');
  assert.equal(completed.processed, 1);
  assert.equal(completed.repaired, 1);
  assert.deepEqual(repairedIds, [sessionId]);
  assert.equal(adapter.sessions.size, 1);
  assert.equal(engine.job(job.id).results[0]!.sessionId, sessionId);
});

test('cleanup requests require a valid explicit mode and records-only preserves native data and raw uploads', async context => {
  const { handler, adapter, engine, root } = await setup(context);
  const upload = await engine.upload(exportBytes, 'conversations.json');
  const job = await engine.start(upload.id, { workspaceId: 'workspace-test', conversationIds: ['http-synthetic'], branchMode: 'all', includeReasoning: true });
  await engine.idle();
  for (const body of ['{broken-json', '{}', 'null', '[]', '{"mode":"delete-all"}', '{"mode":false}']) {
    const response = await handler(request(`/jobs/${job.id}/clear`, { method: 'POST', body }));
    assert.equal(response.status, 400);
    assert.equal(typeof (await response.json()).error, 'string');
  }
  assert.equal((await handler(request(`/jobs/${job.id}/clear`))).status, 404);
  assert.equal((await handler(request('/jobs/missing/clear', { method: 'POST', body: '{"mode":"records"}' }))).status, 404);
  const unsupported = await handler(request(`/jobs/${job.id}/clear`, { method: 'POST', body: '{"mode":"sessions-and-records"}' }));
  assert.equal(unsupported.status, 400);
  assert.match((await unsupported.json()).error, /不支持/);
  assert.equal(adapter.sessions.size, 1);
  const cleaned = await handler(request(`/jobs/${job.id}/clear`, { method: 'POST', body: '{"mode":"records"}' }));
  assert.equal(cleaned.status, 202);
  await engine.idle();
  const state = await (await handler(request('/state'))).json();
  assert.equal(state.cleanup.mode, 'records');
  assert.equal(state.cleanup.status, 'completed');
  assert.equal(state.cleanup.recordsCleared, true);
  assert.equal(state.cleanup.total, 0);
  assert.equal(state.jobs.length, 0);
  assert.equal(state.uploads.length, 1);
  assert.equal((await handler(request(`/jobs/${job.id}`))).status, 404);
  assert.equal(adapter.sessions.size, 1);
  assert.deepEqual(await readdir(join(root, 'exports')), [`${upload.id}.json`]);
});

test('native cleanup exposes durable progress and body IDs cannot expand its report-owned scope', async context => {
  const { handler, adapter, engine } = await setup(context);
  const upload = await engine.upload(exportBytes, 'conversations.json');
  const options = { workspaceId: 'workspace-test', conversationIds: ['http-synthetic'], branchMode: 'all', includeReasoning: true } as const;
  const job = await (await handler(request(`/uploads/${upload.id}/jobs`, { method: 'POST', body: JSON.stringify(options) }))).json();
  await engine.idle();
  const selectedId = engine.job(job.id).results[0]!.sessionId;
  const unrelatedId = 'synthetic-external-http-session';
  adapter.sessions.set(unrelatedId, { sessionId: unrelatedId, workspaceId: 'workspace-test', title: '合成非迁移会话', messageCount: 1 });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const deletionIds: string[] = [];
  adapter.deleteImportedSession = async id => { deletionIds.push(id); await gate; return adapter.sessions.delete(id); };
  const response = await handler(request(`/jobs/${job.id}/clear`, { method: 'POST', body: JSON.stringify({ mode: 'sessions-and-records', sessionIds: [unrelatedId] }) }));
  try {
    assert.equal(response.status, 202);
    const initial = await response.json();
    assert.equal(initial.status, 'running');
    assert.equal(initial.total, 1);
    assert.equal(initial.processed, 0);
    const state = await (await handler(request('/state'))).json();
    assert.equal(state.cleanup.id, initial.id);
    assert.equal(state.cleanup.recordsCleared, false);
    assert.equal((await handler(request(`/uploads/${upload.id}/jobs`, { method: 'POST', body: JSON.stringify(options) }))).status, 409);
    assert.equal((await handler(request(`/jobs/${job.id}/retry`, { method: 'POST' }))).status, 409);
    assert.equal((await handler(request('/metadata/repair', { method: 'POST' }))).status, 409);
    assert.equal((await handler(request(`/jobs/${job.id}/clear`, { method: 'POST', body: '{"mode":"records"}' }))).status, 409);
  } finally { release(); }
  await engine.idle();
  const completed = await (await handler(request('/state'))).json();
  assert.equal(completed.cleanup.status, 'completed');
  assert.equal(completed.cleanup.deleted, 1);
  assert.equal(completed.cleanup.recordsCleared, true);
  assert.deepEqual(completed.cleanup.results, [{ sessionId: selectedId, status: 'deleted' }]);
  assert.deepEqual(deletionIds, [selectedId]);
  assert.equal(adapter.sessions.has(unrelatedId), true);
  assert.equal(adapter.sessions.has(selectedId), false);
  assert.equal(completed.jobs.length, 0);
  assert.equal(completed.uploads.length, 0);
});
