import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { zipSync, strToU8 } from 'fflate';
import { MigrationEngine } from '../src/engine.js';
import type { HarnessAdapter, HarnessImportInput, ImportedSession, ImportRequest, WorkspaceSummary } from '../src/types.js';

class NativeSessionStore implements HarnessAdapter {
  workspaces: WorkspaceSummary[] = [{ id: 'workspace-a', title: '测试工作区 A', path: '/synthetic/workspace-a' }, { id: 'workspace-b', title: '测试工作区 B', path: '/synthetic/workspace-b' }];
  sessions = new Map<string, ImportedSession>();
  writes: HarnessImportInput[] = [];
  recovered = 0;
  failBeforeWrite = false;
  failAfterWrite = false;
  onWrite?: (input: HarnessImportInput) => Promise<void>;
  async listWorkspaces() { return structuredClone(this.workspaces); }
  async sessionExists(id: string) { return this.sessions.has(id); }
  async recoverConversation(input: HarnessImportInput) {
    const existing = this.sessions.get(input.sessionId);
    if (existing) this.recovered++;
    return existing;
  }
  async importConversation(input: HarnessImportInput) {
    this.writes.push(structuredClone(input));
    await this.onWrite?.(input);
    if (this.failBeforeWrite) { this.failBeforeWrite = false; throw new Error('合成故障：写入前失败'); }
    const result = { sessionId: input.sessionId, workspaceId: input.workspaceId, title: input.title, messageCount: input.branch.messages.length };
    this.sessions.set(input.sessionId, result);
    if (this.failAfterWrite) { this.failAfterWrite = false; throw new Error('合成故障：写入后报告丢失'); }
    return result;
  }
}
class MetadataSessionStore extends NativeSessionStore {
  metadata = new Set<string>();
  repairCalls: string[] = [];
  repairErrors = new Map<string, string>();
  onRepair?: (sessionId: string) => Promise<void>;
  async repairSessionMetadata(sessionId: string) {
    this.repairCalls.push(sessionId);
    await this.onRepair?.(sessionId);
    const error = this.repairErrors.get(sessionId);
    if (error) throw new Error(error);
    if (!this.sessions.has(sessionId)) return false;
    this.metadata.add(sessionId);
    return true;
  }
}
class DeletingSessionStore extends MetadataSessionStore {
  deleteCalls: string[] = [];
  deleteErrors = new Map<string, string>();
  onDelete?: (sessionId: string) => Promise<void>;
  finalizeCalls = 0;
  finalizeError?: string;
  async deleteImportedSession(sessionId: string) {
    this.deleteCalls.push(sessionId);
    await this.onDelete?.(sessionId);
    const error = this.deleteErrors.get(sessionId);
    if (error) throw new Error(error);
    const deleted = this.sessions.delete(sessionId);
    this.metadata.delete(sessionId);
    return deleted;
  }
  async finalizeSessionDeletion() {
    this.finalizeCalls++;
    if (this.finalizeError) throw new Error(this.finalizeError);
  }
}
const directExport = strToU8(JSON.stringify([{ id: 'synthetic-conversation', title: '合成测试对话', messages: [{ id: 'u', role: 'user', content: '测试问题' }, { id: 'a', role: 'assistant', content: '测试回答', reasoning_content: '合成思考' }] }]));
const options = (extra: Partial<ImportRequest> = {}): ImportRequest => ({ workspaceId: 'workspace-a', conversationIds: ['synthetic-conversation'], branchMode: 'all', includeReasoning: true, ...extra });
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(callback => { resolve = callback; });
  return { promise, resolve };
};
async function setup(context: TestContext, adapter = new NativeSessionStore()) {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-migration-engine-test-'));
  const engine = new MigrationEngine(root, adapter);
  context.after(async () => { await engine.close(); await rm(root, { recursive: true, force: true }); });
  await engine.init();
  return { engine, root, adapter };
}
async function finished(engine: MigrationEngine, uploadId: string, request = options()) {
  const started = await engine.start(uploadId, request);
  await engine.idle();
  return engine.job(started.id);
}

test('repeated import and restart retain native-session identity and skip completed work', async context => {
  const { engine, root, adapter } = await setup(context);
  const upload = await engine.upload(directExport, 'conversations.json');
  const first = await finished(engine, upload.id);
  const second = await finished(engine, upload.id);
  assert.equal(first.imported, 1);
  assert.equal(second.skipped, 1);
  assert.equal(second.results[0]!.sessionId, first.results[0]!.sessionId);
  assert.equal(adapter.sessions.size, 1);
  await engine.close();
  const restarted = new MigrationEngine(root, adapter);
  context.after(() => restarted.close());
  await restarted.init();
  const third = await finished(restarted, upload.id);
  assert.equal(third.skipped, 1);
  assert.equal(third.results[0]!.sessionId, first.results[0]!.sessionId);
  assert.equal(adapter.writes.length, 1);
});

test('workspace and reasoning choices create distinct copies, while repeated choices skip', async context => {
  const { engine, adapter } = await setup(context);
  const upload = await engine.upload(directExport, 'conversations.json');
  await finished(engine, upload.id);
  const otherWorkspace = await finished(engine, upload.id, options({ workspaceId: 'workspace-b' }));
  const noReasoning = await finished(engine, upload.id, options({ includeReasoning: false }));
  const repeated = await finished(engine, upload.id, options({ includeReasoning: false }));
  assert.equal(otherWorkspace.imported, 1);
  assert.equal(noReasoning.imported, 1);
  assert.equal(repeated.skipped, 1);
  assert.equal(adapter.sessions.size, 3);
  assert.equal(adapter.writes[2]!.includeReasoning, false);
  adapter.workspaces[0]!.path = '/synthetic/workspace-a-moved';
  const moved = await finished(engine, upload.id);
  assert.equal(moved.imported, 1);
});

test('switching latest to all imports only the previously unselected branch', async context => {
  const { engine, adapter } = await setup(context);
  const fixture = await readFile(new URL('./fixtures/deepseek-branches.json', import.meta.url));
  const upload = await engine.upload(fixture, 'conversations.json');
  const request = options({ conversationIds: ['synthetic-branch-example'], branchMode: 'latest' });
  const first = await finished(engine, upload.id, request);
  const all = await finished(engine, upload.id, { ...request, branchMode: 'all' });
  assert.equal(first.imported, 1);
  assert.equal(all.imported, 1);
  assert.equal(all.skipped, 1);
  assert.equal(adapter.sessions.size, 2);
});

test('retry after a write failure reuses the pending id and resumes without duplicates', async context => {
  const { engine, adapter } = await setup(context);
  const upload = await engine.upload(directExport, 'conversations.json');
  adapter.failBeforeWrite = true;
  const failed = await finished(engine, upload.id);
  assert.equal(failed.failed, 1);
  const pendingId = failed.results[0]!.sessionId;
  const retry = await engine.retry(failed.id);
  await engine.idle();
  const result = engine.job(retry.id);
  assert.equal(result.imported, 1);
  assert.equal(result.results[0]!.sessionId, pendingId);
  assert.equal(adapter.sessions.size, 1);
});

test('pending recovery adopts a native session whose completion report was lost', async context => {
  const { engine, adapter } = await setup(context);
  const upload = await engine.upload(directExport, 'conversations.json');
  adapter.failAfterWrite = true;
  const failed = await finished(engine, upload.id);
  assert.equal(failed.failed, 1);
  assert.equal(adapter.sessions.size, 1);
  const retry = await engine.retry(failed.id);
  await engine.idle();
  const recovered = engine.job(retry.id);
  assert.equal(recovered.imported, 1);
  assert.equal(recovered.results[0]!.sessionId, failed.results[0]!.sessionId);
  assert.equal(adapter.recovered, 1);
  assert.equal(adapter.writes.length, 1);
});

test('startup marks an unfinished report interrupted and ledger replay skips completed native work', async context => {
  const { engine, root, adapter } = await setup(context);
  const upload = await engine.upload(directExport, 'conversations.json');
  const complete = await finished(engine, upload.id);
  await engine.close();
  const statePath = join(root, 'state.json');
  const saved = JSON.parse(await readFile(statePath, 'utf8'));
  saved.jobs[0].job.status = 'running';
  delete saved.jobs[0].job.finishedAt;
  await writeFile(statePath, JSON.stringify(saved));
  const restarted = new MigrationEngine(root, adapter);
  context.after(() => restarted.close());
  await restarted.init();
  assert.equal(restarted.job(complete.id).status, 'interrupted');
  const replay = await restarted.retry(complete.id);
  await restarted.idle();
  assert.equal(restarted.job(replay.id).skipped, 1);
  assert.equal(adapter.writes.length, 1);
});

test('cancellation waits for one complete branch and excludes subsequent native writes', async context => {
  const { engine, adapter } = await setup(context);
  const fixture = await readFile(new URL('./fixtures/deepseek-branches.json', import.meta.url));
  const upload = await engine.upload(fixture, 'conversations.json');
  const entered = deferred(); const release = deferred();
  context.after(() => release.resolve());
  adapter.onWrite = async () => { entered.resolve(); await release.promise; };
  const started = await engine.start(upload.id, options({ conversationIds: ['synthetic-branch-example'] }));
  await entered.promise;
  try {
    await assert.rejects(() => engine.start(upload.id, options()), /已有导入任务/);
    await assert.rejects(() => engine.removeUpload(upload.id), /正在导入/);
    engine.cancel(started.id);
    assert.equal(adapter.sessions.size, 0);
  } finally { release.resolve(); }
  await engine.idle();
  const cancelled = engine.job(started.id);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.processed, 1);
  assert.equal(cancelled.total, 2);
  assert.equal(adapter.sessions.size, 1);
  assert.equal(adapter.writes[0]!.branch.messages.length, 2);
  adapter.onWrite = undefined;
  const retry = await engine.retry(cancelled.id);
  await engine.idle();
  assert.equal(engine.job(retry.id).imported, 1);
  assert.equal(engine.job(retry.id).skipped, 1);
  assert.equal(adapter.sessions.size, 2);
});

test('removing uploaded raw data leaves native sessions and repeat-upload ledger intact', async context => {
  const { engine, root, adapter } = await setup(context);
  const zip = zipSync({ 'conversations.json': directExport, 'user.json': strToU8('{"secret":"synthetic-account-data"}') });
  const upload = await engine.upload(zip, '../../deepseek_data.zip');
  assert.equal(upload.filename, 'deepseek_data.zip');
  assert.deepEqual(await readdir(join(root, 'exports')), [`${upload.id}.json`]);
  assert.equal((await readFile(join(root, 'exports', `${upload.id}.json`), 'utf8')).includes('synthetic-account-data'), false);
  if (process.platform !== 'win32') {
    assert.equal((await stat(join(root, 'exports'))).mode & 0o777, 0o700);
    assert.equal((await stat(join(root, 'exports', `${upload.id}.json`))).mode & 0o777, 0o600);
    assert.equal((await stat(join(root, 'state.json'))).mode & 0o777, 0o600);
  }
  const imported = await finished(engine, upload.id);
  await engine.removeUpload(upload.id);
  assert.deepEqual(await readdir(join(root, 'exports')), []);
  assert.equal(adapter.sessions.has(imported.results[0]!.sessionId), true);
  const repeated = await engine.upload(directExport, 'conversations.json');
  assert.equal((await finished(engine, repeated.id)).skipped, 1);
  assert.equal(adapter.sessions.size, 1);
});

test('a deleted native copy can be explicitly recreated with a new session id', async context => {
  const { engine, adapter } = await setup(context);
  const upload = await engine.upload(directExport, 'conversations.json');
  const first = await finished(engine, upload.id);
  adapter.sessions.delete(first.results[0]!.sessionId);
  const recreated = await finished(engine, upload.id);
  assert.equal(recreated.imported, 1);
  assert.notEqual(recreated.results[0]!.sessionId, first.results[0]!.sessionId);
});

test('invalid selections and prototype-key upload ids never reach native migration', async context => {
  const { engine, adapter } = await setup(context);
  const upload = await engine.upload(directExport, 'conversations.json');
  await assert.rejects(() => engine.start(upload.id, options({ workspaceId: 'missing-workspace' })), /有效的工作区/);
  await assert.rejects(() => engine.start(upload.id, options({ conversationIds: ['missing-conversation'] })), /不存在的对话/);
  await assert.rejects(() => engine.start(upload.id, options({ conversationIds: [] })), /至少一个/);
  await assert.rejects(() => engine.uploadDetail('__proto__'), error => error instanceof Error && error.message === '导出文件不存在，请重新选择 ZIP。');
  await assert.rejects(() => engine.removeUpload('toString'), error => error instanceof Error && error.message === '导出文件不存在。');
  assert.equal(adapter.writes.length, 0);
});

test('simultaneous engines sharing one root refuse a second writer, then release without losing records', { timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-migration-shared-root-test-'));
  const adapter = new NativeSessionStore();
  const first = new MigrationEngine(root, adapter);
  const contender = new MigrationEngine(root, adapter);
  const successor = new MigrationEngine(root, adapter);
  try {
    await first.init();
    const upload = await first.upload(directExport, 'conversations.json');
    const imported = await finished(first, upload.id);
    const before = await readFile(join(root, 'state.json'), 'utf8');
    await assert.rejects(() => contender.init(), error => error instanceof Error && /另一个|其他.*实例|正在.*使用|已被.*占用|已有.*实例/.test(error.message));
    assert.equal(await readFile(join(root, 'state.json'), 'utf8'), before);
    await contender.close();
    await first.close();
    await successor.init();
    const state = await successor.state();
    assert.equal(state.uploads.length, 1);
    assert.equal(state.uploads[0]!.id, upload.id);
    assert.equal(state.jobs.length, 1);
    assert.equal(state.jobs[0]!.id, imported.id);
    const repeated = await finished(successor, upload.id);
    assert.equal(repeated.skipped, 1);
    assert.equal(repeated.results[0]!.sessionId, imported.results[0]!.sessionId);
    assert.equal(adapter.sessions.size, 1);
  } finally {
    await Promise.allSettled([first.close(), contender.close(), successor.close()]);
    await rm(root, { recursive: true, force: true });
  }
});

test('a crashed writer PID is replaced and the acquired lifetime lock releases on close', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-migration-stale-lock-test-'));
  const lockPath = join(root, 'writer.lock');
  const deadPid = 2_147_483_647;
  assert.throws(() => process.kill(deadPid, 0), error => (error as NodeJS.ErrnoException).code === 'ESRCH');
  await writeFile(lockPath, `${deadPid}\n`, { mode: 0o600 });
  const engine = new MigrationEngine(root, new NativeSessionStore());
  try {
    await engine.init();
    assert.equal((await readFile(lockPath, 'utf8')).trim(), String(process.pid));
    const upload = await engine.upload(directExport, 'conversations.json');
    assert.equal((await finished(engine, upload.id)).imported, 1);
    await engine.close();
    await assert.rejects(() => stat(lockPath), error => (error as NodeJS.ErrnoException).code === 'ENOENT');
  } finally {
    await engine.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('startup repairs unique committed native metadata after raw exports have been removed, without importing again', async context => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-migration-legacy-metadata-test-'));
  const adapter = new MetadataSessionStore();
  const legacy = new MigrationEngine(root, new NativeSessionStore());
  const restarted = new MigrationEngine(root, adapter);
  context.after(async () => {
    await Promise.allSettled([legacy.close(), restarted.close()]);
    await rm(root, { recursive: true, force: true });
  });
  await legacy.init();
  const upload = await legacy.upload(directExport, 'conversations.json');
  const imported = await finished(legacy, upload.id);
  const sessionId = imported.results[0]!.sessionId;
  adapter.sessions = (legacy.adapter as NativeSessionStore).sessions;
  adapter.writes = (legacy.adapter as NativeSessionStore).writes;
  await legacy.removeUpload(upload.id);
  await legacy.close();
  const statePath = join(root, 'state.json');
  const stored = JSON.parse(await readFile(statePath, 'utf8'));
  const committed = Object.values(stored.ledger)[0];
  stored.ledger['legacy-duplicate-reference'] = structuredClone(committed);
  stored.ledger['legacy-pending-reference'] = { key: 'legacy-pending-reference', sourceId: 'synthetic-pending', sessionId: 'synthetic-pending-session', state: 'pending' };
  await writeFile(statePath, JSON.stringify(stored));

  await restarted.init();
  await restarted.idle();
  const state = await restarted.state();
  assert.equal(state.version, '1.0.2');
  assert.deepEqual(state.metadataRepair && { total: state.metadataRepair.total, processed: state.metadataRepair.processed, repaired: state.metadataRepair.repaired, status: state.metadataRepair.status },
    { total: 1, processed: 1, repaired: 1, status: 'completed' });
  assert.deepEqual(adapter.repairCalls, [sessionId]);
  assert.equal(adapter.metadata.has(sessionId), true);
  assert.deepEqual(await readdir(join(root, 'exports')), []);
  assert.equal(JSON.parse(await readFile(statePath, 'utf8')).metadataRepair, undefined);
  const repeated = await restarted.upload(directExport, 'conversations.json');
  assert.equal((await finished(restarted, repeated.id)).skipped, 1);
  assert.equal(adapter.writes.length, 1);
  assert.equal(adapter.sessions.size, 1);
});

test('missing and failed native metadata repairs do not stop other sessions, and manual retry refreshes the report', async context => {
  const adapter = new MetadataSessionStore();
  const { engine } = await setup(context, adapter);
  const upload = await engine.upload(directExport, 'conversations.json');
  const first = await finished(engine, upload.id);
  const second = await finished(engine, upload.id, options({ workspaceId: 'workspace-b' }));
  const third = await finished(engine, upload.id, options({ includeReasoning: false }));
  const missingId = first.results[0]!.sessionId;
  const failedId = second.results[0]!.sessionId;
  const intactId = third.results[0]!.sessionId;
  adapter.sessions.delete(missingId);
  adapter.repairErrors.set(failedId, '合成故障：当前缓存暂时无法写入');
  await engine.startMetadataRepair();
  await engine.idle();
  const report = (await engine.state()).metadataRepair!;
  assert.equal(report.status, 'completed');
  assert.equal(report.total, 3);
  assert.equal(report.processed, 3);
  assert.equal(report.repaired, 1);
  assert.equal(report.missing, 1);
  assert.equal(report.failed, 1);
  assert.deepEqual(report.errors, [{ sessionId: failedId, error: '合成故障：当前缓存暂时无法写入' }]);
  assert.equal(adapter.metadata.has(intactId), true);
  assert.equal(typeof report.finishedAt, 'number');
  adapter.repairErrors.clear();
  await engine.startMetadataRepair();
  await engine.idle();
  const retried = (await engine.state()).metadataRepair!;
  assert.equal(retried.repaired, 2);
  assert.equal(retried.missing, 1);
  assert.equal(retried.failed, 0);
  assert.deepEqual(retried.errors, []);
  assert.equal(adapter.writes.length, 3);
  assert.equal(adapter.sessions.size, 2);
});

test('native import and metadata repair exclude each other without blocking raw upload management', async context => {
  const adapter = new MetadataSessionStore();
  const { engine } = await setup(context, adapter);
  const upload = await engine.upload(directExport, 'conversations.json');
  const writeEntered = deferred(); const writeRelease = deferred();
  adapter.onWrite = async () => { writeEntered.resolve(); await writeRelease.promise; };
  const importing = await engine.start(upload.id, options());
  await writeEntered.promise;
  try {
    await assert.rejects(() => engine.startMetadataRepair(), error => error instanceof Error && 'status' in error && error.status === 409);
    await assert.rejects(() => engine.startCleanup(importing.id, 'records'), error => error instanceof Error && 'status' in error && error.status === 409);
  } finally { writeRelease.resolve(); }
  await engine.idle();
  adapter.onWrite = undefined;
  const repairEntered = deferred(); const repairRelease = deferred();
  adapter.onRepair = async () => { repairEntered.resolve(); await repairRelease.promise; };
  const started = await engine.startMetadataRepair();
  await repairEntered.promise;
  try {
    assert.equal(started.status, 'running');
    await assert.rejects(() => engine.start(upload.id, options()), error => error instanceof Error && 'status' in error && error.status === 409);
    await assert.rejects(() => engine.startCleanup(importing.id, 'records'), error => error instanceof Error && 'status' in error && error.status === 409);
    const again = await engine.startMetadataRepair();
    assert.equal(again.startedAt, started.startedAt);
    assert.equal(adapter.repairCalls.length, 1);
    await engine.removeUpload(upload.id);
    const replacement = await engine.upload(directExport, 'conversations.json');
    assert.equal(replacement.id, upload.id);
  } finally { repairRelease.resolve(); }
  await engine.idle();
  assert.equal((await engine.state()).metadataRepair!.processed, 1);
  assert.equal((await finished(engine, upload.id)).skipped, 1);
  assert.equal(adapter.writes.length, 1);
});

test('close waits for the current metadata repair, stops between sessions, and releases the lifetime lock', { timeout: 15_000 }, async context => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-migration-repair-close-test-'));
  const legacyAdapter = new NativeSessionStore();
  const adapter = new MetadataSessionStore();
  adapter.sessions = legacyAdapter.sessions;
  const legacy = new MigrationEngine(root, legacyAdapter);
  const repairing = new MigrationEngine(root, adapter);
  const contender = new MigrationEngine(root, adapter);
  const successor = new MigrationEngine(root, adapter);
  const entered = deferred(); const release = deferred();
  context.after(async () => {
    release.resolve();
    await Promise.allSettled([legacy.close(), repairing.close(), contender.close(), successor.close()]);
    await rm(root, { recursive: true, force: true });
  });
  await legacy.init();
  const fixture = await readFile(new URL('./fixtures/deepseek-branches.json', import.meta.url));
  const upload = await legacy.upload(fixture, 'conversations.json');
  await finished(legacy, upload.id, options({ conversationIds: ['synthetic-branch-example'] }));
  await legacy.close();
  adapter.onRepair = async () => { entered.resolve(); await release.promise; };
  await repairing.init();
  await entered.promise;
  let closed = false;
  const closing = repairing.close().then(() => { closed = true; });
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(closed, false);
    await assert.rejects(() => contender.init(), error => error instanceof Error && 'status' in error && error.status === 409);
  } finally { release.resolve(); }
  await closing;
  const stopped = (await repairing.state()).metadataRepair!;
  assert.equal(stopped.status, 'completed');
  assert.equal(stopped.total, 2);
  assert.equal(stopped.processed, 1);
  assert.equal(stopped.repaired, 1);
  assert.equal(adapter.repairCalls.length, 1);
  assert.equal(typeof stopped.finishedAt, 'number');
  adapter.onRepair = undefined;
  await successor.init();
  await successor.idle();
  assert.equal((await successor.state()).metadataRepair!.processed, 2);
  assert.equal(legacyAdapter.writes.length, 2);
  assert.equal(adapter.sessions.size, 2);
});

test('records-only removes the chosen report while preserving native sessions, deduplication, other reports and raw data', async context => {
  const adapter = new DeletingSessionStore();
  const { engine, root } = await setup(context, adapter);
  const upload = await engine.upload(directExport, 'conversations.json');
  const first = await finished(engine, upload.id);
  const second = await finished(engine, upload.id);
  await engine.startMetadataRepair(); await engine.idle();
  const repairBefore = (await engine.state()).metadataRepair;
  const cleanup = await engine.startCleanup(first.id, 'records');
  await engine.idle();
  const state = await engine.state();
  assert.equal(state.cleanup!.id, cleanup.id);
  assert.equal(state.cleanup!.status, 'completed');
  assert.equal(state.cleanup!.recordsCleared, true);
  assert.equal(state.cleanup!.total, 0);
  assert.throws(() => engine.job(first.id), /不存在/);
  assert.deepEqual(engine.job(second.id), second);
  assert.deepEqual(state.metadataRepair, repairBefore);
  assert.deepEqual(await readdir(join(root, 'exports')), [`${upload.id}.json`]);
  assert.equal(adapter.sessions.size, 1);
  assert.deepEqual(adapter.deleteCalls, []);
  assert.equal(adapter.finalizeCalls, 0);
  assert.equal((await finished(engine, upload.id)).skipped, 1);
  const stored = JSON.parse(await readFile(join(root, 'state.json'), 'utf8'));
  assert.equal(Object.keys(stored.ledger).length, 1);
  assert.equal(adapter.writes.length, 1);
});

test('deleting selected native sessions clears shared references but preserves other jobs and mixed-report results', async context => {
  const adapter = new DeletingSessionStore();
  const { engine, root } = await setup(context, adapter);
  const source = JSON.parse(new TextDecoder().decode(directExport));
  source.push({ ...source[0], id: 'synthetic-other', title: '另一个合成对话' });
  const upload = await engine.upload(strToU8(JSON.stringify(source)), 'conversations.json');
  const chosen = await finished(engine, upload.id);
  const duplicate = await finished(engine, upload.id);
  const mixed = await finished(engine, upload.id, options({ conversationIds: ['synthetic-conversation', 'synthetic-other'] }));
  const unrelated = await finished(engine, upload.id, options({ workspaceId: 'workspace-b' }));
  const deletedId = chosen.results[0]!.sessionId;
  const otherId = mixed.results.find(result => result.sourceId === 'synthetic-other')!.sessionId;
  // A reply or rename after migration remains part of the same native copy.
  adapter.sessions.get(deletedId)!.title = '合成续聊后的新标题';
  await engine.startCleanup(chosen.id, 'sessions-and-records');
  await engine.idle();
  assert.deepEqual(adapter.deleteCalls, [deletedId]);
  assert.equal(adapter.sessions.has(deletedId), false);
  assert.equal(adapter.sessions.has(otherId), true);
  assert.equal(adapter.sessions.has(unrelated.results[0]!.sessionId), true);
  assert.throws(() => engine.job(chosen.id), /不存在/);
  assert.throws(() => engine.job(duplicate.id), /不存在/);
  assert.deepEqual(engine.job(unrelated.id), unrelated);
  const remaining = engine.job(mixed.id);
  assert.deepEqual(remaining.results.map(result => result.sessionId), [otherId]);
  assert.equal(remaining.processed, 1);
  assert.equal(remaining.total, 1);
  assert.equal(remaining.imported, 1);
  assert.equal(remaining.skipped, 0);
  assert.equal((await engine.state()).uploads.length, 1);
  assert.deepEqual(await readdir(join(root, 'exports')), [`${upload.id}.json`]);
  const stored = JSON.parse(await readFile(join(root, 'state.json'), 'utf8'));
  assert.equal(Object.values(stored.ledger).some((entry: any) => entry.sessionId === deletedId), false);
  assert.equal(Object.keys(stored.ledger).length, 2);
  assert.equal(adapter.writes.length, 3);
});

test('successful session cleanup removes only its local raw copy and clears stale metadata statistics', async context => {
  const adapter = new DeletingSessionStore();
  const { engine, root } = await setup(context, adapter);
  const originalPath = join(root, 'original-user-export.zip');
  const original = zipSync({ 'conversations.json': directExport, 'user.json': strToU8('{"private":"synthetic-account"}') });
  await writeFile(originalPath, original);
  const upload = await engine.upload(await readFile(originalPath), 'original-user-export.zip');
  const imported = await finished(engine, upload.id);
  await engine.startMetadataRepair(); await engine.idle();
  assert.equal((await engine.state()).metadataRepair!.repaired, 1);
  await engine.startCleanup(imported.id, 'sessions-and-records');
  await engine.idle();
  const state = await engine.state();
  assert.equal(state.cleanup!.deleted, 1);
  assert.equal(state.cleanup!.processed, 1);
  assert.equal(state.cleanup!.recordsCleared, true);
  assert.equal(state.metadataRepair, undefined);
  assert.deepEqual(state.jobs, []);
  assert.deepEqual(state.uploads, []);
  assert.deepEqual(await readdir(join(root, 'exports')), []);
  assert.deepEqual(await readFile(originalPath), Buffer.from(original));
  const stored = JSON.parse(await readFile(join(root, 'state.json'), 'utf8'));
  assert.deepEqual(stored.ledger, {});
  assert.equal(stored.cleanup.recordsCleared, true);
  assert.equal(stored.cleanup.status, 'completed');
  assert.equal(adapter.sessions.size, 0);
  assert.equal(adapter.writes.length, 1);
  assert.equal(adapter.finalizeCalls, 1);
});

test('partial cleanup retains its report and ledger, and restart waits for explicit retry without repeating confirmed deletes', async context => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-migration-cleanup-retry-test-'));
  const adapter = new DeletingSessionStore();
  const first = new MigrationEngine(root, adapter);
  const restarted = new MigrationEngine(root, adapter);
  const entered = deferred(); const release = deferred();
  context.after(async () => {
    release.resolve();
    await Promise.allSettled([first.close(), restarted.close()]);
    await rm(root, { recursive: true, force: true });
  });
  await first.init();
  const fixture = JSON.parse(await readFile(new URL('./fixtures/deepseek-branches.json', import.meta.url), 'utf8'));
  fixture.push(...JSON.parse(new TextDecoder().decode(directExport)));
  const upload = await first.upload(strToU8(JSON.stringify(fixture)), 'conversations.json');
  const job = await finished(first, upload.id, options({ conversationIds: ['synthetic-branch-example', 'synthetic-conversation'] }));
  const duplicateReport = await finished(first, upload.id, options({ conversationIds: ['synthetic-branch-example', 'synthetic-conversation'] }));
  const missingId = job.results[0]!.sessionId; const failedId = job.results[1]!.sessionId; const deletedId = job.results[2]!.sessionId;
  adapter.sessions.delete(missingId);
  adapter.deleteErrors.set(failedId, '合成故障：会话当前正在使用');
  const cleanup = await first.startCleanup(job.id, 'sessions-and-records');
  await first.idle();
  const partial = (await first.state()).cleanup!;
  assert.equal(partial.status, 'completed');
  assert.equal(partial.deleted, 1);
  assert.equal(partial.missing, 1);
  assert.equal(partial.failed, 1);
  assert.equal(partial.recordsCleared, false);
  assert.equal(adapter.finalizeCalls, 1);
  assert.deepEqual(first.job(job.id), job);
  assert.deepEqual(await readdir(join(root, 'exports')), [`${upload.id}.json`]);
  const conflict = (error: unknown) => error instanceof Error && 'status' in error && error.status === 409;
  await assert.rejects(() => first.startCleanup(job.id, 'records'), error => conflict(error) && /先重试.*会话清理/.test((error as Error).message));
  await assert.rejects(() => first.startCleanup(duplicateReport.id, 'records'), conflict);
  await assert.rejects(() => first.startCleanup(duplicateReport.id, 'sessions-and-records'), conflict);
  await assert.rejects(() => first.start(upload.id, options()), error => conflict(error) && /上次清理尚未完成/.test((error as Error).message));
  await assert.rejects(() => first.retry(job.id), conflict);
  assert.equal((await first.state()).cleanup!.id, cleanup.id);
  await first.close();
  const path = join(root, 'state.json');
  const saved = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(Object.keys(saved.ledger).length, 3);
  saved.cleanup.status = 'running'; delete saved.cleanup.finishedAt;
  await writeFile(path, JSON.stringify(saved));
  await restarted.init(); await restarted.idle();
  assert.equal((await restarted.state()).cleanup!.status, 'interrupted');
  assert.deepEqual(adapter.deleteCalls, [missingId, failedId, deletedId]);
  adapter.deleteErrors.clear();
  adapter.onDelete = async () => { entered.resolve(); await release.promise; };
  const retry = await restarted.startCleanup(job.id, 'sessions-and-records');
  await entered.promise;
  try {
    assert.equal(retry.id, cleanup.id);
    assert.equal(retry.processed, 2);
    assert.equal(retry.deleted, 1);
    assert.equal(retry.missing, 1);
    assert.equal(retry.failed, 0);
    assert.deepEqual(retry.results, [{ sessionId: missingId, status: 'missing' }, { sessionId: deletedId, status: 'deleted' }]);
  } finally { release.resolve(); }
  await restarted.idle();
  const completed = (await restarted.state()).cleanup!;
  assert.equal(completed.processed, 3);
  assert.equal(completed.deleted, 2);
  assert.equal(completed.missing, 1);
  assert.equal(completed.recordsCleared, true);
  assert.deepEqual(adapter.deleteCalls, [missingId, failedId, deletedId, failedId]);
  assert.equal(adapter.finalizeCalls, 2);
  assert.equal(adapter.sessions.size, 0);
  assert.deepEqual(await readdir(join(root, 'exports')), []);
});

test('a cleanup with no confirmed native deletion allows another cleanup or a new import', async context => {
  const adapter = new DeletingSessionStore();
  const { engine } = await setup(context, adapter);
  const upload = await engine.upload(directExport, 'conversations.json');
  const first = await finished(engine, upload.id);
  const second = await finished(engine, upload.id);
  adapter.deleteErrors.set(first.results[0]!.sessionId, '合成故障：会话正在使用，未删除');
  await engine.startCleanup(first.id, 'sessions-and-records'); await engine.idle();
  const failed = (await engine.state()).cleanup!;
  assert.equal(failed.failed, 1);
  assert.equal(failed.deleted + failed.missing, 0);
  assert.equal(adapter.sessions.size, 1);
  assert.equal((await finished(engine, upload.id)).skipped, 1);
  await engine.startCleanup(second.id, 'records'); await engine.idle();
  assert.equal((await engine.state()).cleanup!.recordsCleared, true);
  assert.deepEqual(engine.job(first.id), first);
  assert.equal(adapter.sessions.size, 1);
});

test('failed native-index finalization retains durable deletion results and retry finishes without deleting again', async context => {
  const adapter = new DeletingSessionStore();
  const { engine, root } = await setup(context, adapter);
  const upload = await engine.upload(directExport, 'conversations.json');
  const imported = await finished(engine, upload.id);
  adapter.finalizeError = '合成故障：搜索索引暂时无法同步';
  await engine.startCleanup(imported.id, 'sessions-and-records'); await engine.idle();
  const incomplete = (await engine.state()).cleanup!;
  assert.equal(incomplete.status, 'interrupted');
  assert.equal(incomplete.processed, 1);
  assert.equal(incomplete.deleted, 1);
  assert.equal(incomplete.recordsCleared, false);
  assert.match(incomplete.error!, /搜索索引/);
  assert.deepEqual(engine.job(imported.id), imported);
  assert.equal(adapter.sessions.size, 0);
  assert.equal(adapter.deleteCalls.length, 1);
  assert.equal(adapter.finalizeCalls, 1);
  const saved = JSON.parse(await readFile(join(root, 'state.json'), 'utf8'));
  assert.equal(saved.cleanup.deleted, 1);
  assert.equal(saved.jobs.length, 1);
  assert.equal(Object.keys(saved.ledger).length, 1);
  adapter.finalizeError = undefined;
  const retried = await engine.startCleanup(imported.id, 'sessions-and-records');
  assert.equal(retried.processed, 1);
  assert.equal(retried.deleted, 1);
  await engine.idle();
  assert.equal((await engine.state()).cleanup!.recordsCleared, true);
  assert.equal(adapter.deleteCalls.length, 1);
  assert.equal(adapter.finalizeCalls, 2);
});

test('missing copies count as cleaned, while native deletion is rejected when any selected ID lacks ledger ownership', async context => {
  const adapter = new DeletingSessionStore();
  const { engine, root } = await setup(context, adapter);
  const upload = await engine.upload(directExport, 'conversations.json');
  const imported = await finished(engine, upload.id);
  adapter.sessions.delete(imported.results[0]!.sessionId);
  await engine.startCleanup(imported.id, 'sessions-and-records'); await engine.idle();
  assert.equal((await engine.state()).cleanup!.missing, 1);
  assert.equal((await engine.state()).cleanup!.recordsCleared, true);
  const replacement = await engine.upload(directExport, 'conversations.json');
  const replacementJob = await finished(engine, replacement.id);
  await engine.close();
  const statePath = join(root, 'state.json');
  const stored = JSON.parse(await readFile(statePath, 'utf8'));
  const externalId = 'synthetic-unrelated-native-session';
  adapter.sessions.set(externalId, { sessionId: externalId, workspaceId: 'workspace-a', title: '不属于插件的合成原生会话', messageCount: 1 });
  const record = stored.jobs.find((item: any) => item.job.id === replacementJob.id);
  record.job.results.push({ ...record.job.results[0], sessionId: externalId });
  await writeFile(statePath, JSON.stringify(stored));
  const restarted = new MigrationEngine(root, adapter);
  context.after(() => restarted.close());
  await restarted.init(); await restarted.idle();
  const callsBefore = adapter.deleteCalls.length;
  await assert.rejects(() => restarted.startCleanup(replacementJob.id, 'sessions-and-records'), /不在迁移账本/);
  assert.equal(adapter.deleteCalls.length, callsBefore);
  assert.equal(adapter.sessions.has(externalId), true);
  assert.equal(adapter.sessions.has(replacementJob.results[0]!.sessionId), true);
  assert.equal(restarted.job(replacementJob.id).results.length, 2);
});

test('cleanup excludes imports, import retries, cache repair and additional cleanup while a native deletion is pending', async context => {
  const adapter = new DeletingSessionStore();
  const { engine } = await setup(context, adapter);
  const upload = await engine.upload(directExport, 'conversations.json');
  const job = await finished(engine, upload.id);
  const entered = deferred(); const release = deferred();
  adapter.onDelete = async () => { entered.resolve(); await release.promise; };
  await engine.startCleanup(job.id, 'sessions-and-records');
  await entered.promise;
  const conflict = (error: unknown) => error instanceof Error && 'status' in error && error.status === 409;
  try {
    await assert.rejects(() => engine.start(upload.id, options()), conflict);
    await assert.rejects(() => engine.retry(job.id), conflict);
    await assert.rejects(() => engine.startMetadataRepair(), conflict);
    await assert.rejects(() => engine.startCleanup(job.id, 'records'), conflict);
    assert.equal(adapter.sessions.size, 1);
    assert.equal(adapter.deleteCalls.length, 1);
  } finally { release.resolve(); }
  await engine.idle();
  assert.equal((await engine.state()).cleanup!.recordsCleared, true);
});

test('close finishes one native deletion, persists interruption and releases the lock before explicit cleanup retry', { timeout: 15_000 }, async context => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-migration-cleanup-close-test-'));
  const adapter = new DeletingSessionStore();
  const first = new MigrationEngine(root, adapter); const contender = new MigrationEngine(root, adapter); const successor = new MigrationEngine(root, adapter);
  const entered = deferred(); const release = deferred();
  context.after(async () => {
    release.resolve();
    await Promise.allSettled([first.close(), contender.close(), successor.close()]);
    await rm(root, { recursive: true, force: true });
  });
  await first.init();
  const upload = await first.upload(await readFile(new URL('./fixtures/deepseek-branches.json', import.meta.url)), 'conversations.json');
  const job = await finished(first, upload.id, options({ conversationIds: ['synthetic-branch-example'] }));
  adapter.onDelete = async () => { entered.resolve(); await release.promise; };
  await first.startCleanup(job.id, 'sessions-and-records'); await entered.promise;
  let closed = false;
  const closing = first.close().then(() => { closed = true; });
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(closed, false);
    await assert.rejects(() => contender.init(), /另一个.*实例/);
  } finally { release.resolve(); }
  await closing;
  const stored = JSON.parse(await readFile(join(root, 'state.json'), 'utf8'));
  assert.equal(stored.cleanup.status, 'interrupted');
  assert.equal(stored.cleanup.processed, 1);
  assert.equal(stored.cleanup.recordsCleared, false);
  assert.equal(stored.jobs.length, 1);
  assert.equal(Object.keys(stored.ledger).length, 2);
  assert.equal(adapter.sessions.size, 1);
  assert.equal(adapter.deleteCalls.length, 1);
  adapter.onDelete = undefined;
  await successor.init(); await successor.idle();
  assert.equal(adapter.deleteCalls.length, 1);
  await successor.startCleanup(job.id, 'sessions-and-records'); await successor.idle();
  assert.equal(adapter.deleteCalls.length, 2);
  assert.equal((await successor.state()).cleanup!.recordsCleared, true);
  assert.equal(adapter.sessions.size, 0);
});
