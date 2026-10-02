import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import SessionStore, { Session, SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session';
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import Storage from '@deepseek-ai/dsh-storage';
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain';
import * as StorageJson from '@deepseek-ai/dsh-storage-json';
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import SessionProjectionCache, { projectionCacheDomainSpec } from '@deepseek-ai/dsh-session-projection-cache';
import { titleProjectionDefinition } from '@deepseek-ai/dsh-session-title';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import SqliteSessionQueryEngine from '@deepseek-ai/dsh-session-query-sqlite';
import { SessionQueryError } from '@deepseek-ai/dsh-session-query';
import { createHarnessAdapter } from '../src/harness.js';
import type { HarnessImportInput } from '../src/types.js';

async function boot(root: string, compression: 'none' | 'zstd' = 'none'): Promise<Context> {
  const ctx = new Context();
  await ctx.plugin(Storage);
  await ctx.plugin(StorageJson, { root: join(root, 'storages') });
  await ctx.plugin(StorageDomain, { backend: 'json' });
  await ctx.plugin(SessionStore);
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression });
  await ctx.plugin(WorkspaceRegistry);
  await ctx.plugin(SessionProjectionRegistry);
  ctx.sessionProjections.register(titleProjectionDefinition);
  await ctx.plugin(SessionProjectionCache, { writeEveryEvents: 200, writeIntervalMs: 5000 });
  return ctx;
}

function fixture(workspaceId: string, sessionId = randomUUID()): HarnessImportInput {
  const time = 1_700_000_000_000;
  const messages = [
    { id: 'user-1', role: 'user' as const, text: '要迁移的原始问题', reasoning: '', timestamp: time + 1, attachments: [], citations: [] },
    { id: 'assistant-1', role: 'assistant' as const, text: '原始回答', reasoning: '', timestamp: time + 2, attachments: [], citations: [] },
  ];
  const branch = { id: 'branch', messages, updatedAt: time + 2 };
  return { conversation: { id: 'source', title: '导入标题', createdAt: time, updatedAt: time + 2, branches: [branch], warnings: [], attachmentCount: 0 },
    branch, workspaceId, sessionId, title: '导入标题', includeReasoning: true };
}

function backend(ctx: Context): JsonlSessionPersistence {
  assert.ok(ctx.sessionPersistence instanceof JsonlSessionPersistence);
  return ctx.sessionPersistence;
}

async function setup(root: string, compression: 'none' | 'zstd' = 'none') {
  await mkdir(join(root, 'workspace'), { recursive: true });
  const ctx = await boot(root, compression);
  const workspace = await ctx.workspaceRegistry.create(join(root, 'workspace'));
  const input = fixture(workspace.id);
  const adapter = createHarnessAdapter(ctx);
  await adapter.importConversation(input);
  assert.ok(adapter.deleteImportedSession);
  const path = await backend(ctx).resolveCurrentLog(SessionId(input.sessionId));
  assert.ok(path);
  const header = (await ctx.sessionPersistence.stat(SessionId(input.sessionId)))!.header;
  return { ctx, workspace, input, adapter, path, header };
}

async function assertAbsent(ctx: Context, id: string): Promise<void> {
  assert.equal(await ctx.sessionPersistence.stat(SessionId(id)), undefined);
  assert.equal((await ctx.sessionPersistence.list()).some(item => item.header.id === id), false);
  await assert.rejects(ctx.sessionPersistence.open(SessionId(id), 'read'), /not found|does not exist|no persisted|missing/i);
  await assert.rejects(ctx.sessionPersistence.open(SessionId(id), 'write'), /not found|does not exist|no persisted|missing/i);
}

async function journals(root: string): Promise<string[]> {
  return (await readdir(root)).filter(entry => entry.startsWith('.deepseek-chat-migration-cleanup-'));
}

for (const compression of ['none', 'zstd'] as const) {
  test(`real ${compression} native deletion removes continued history and metadata, retains lock and unrelated files, survives restart`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'deepseek-cleanup-'));
    let ctx: Context | undefined;
    try {
      const setupResult = await setup(root, compression);
      ({ ctx } = setupResult);
      const { input, workspace, adapter, path, header } = setupResult;
      const other = fixture(workspace.id);
      await adapter.importConversation(other);
      const otherPath = (await backend(ctx).resolveCurrentLog(SessionId(other.sessionId)))!;
      const untouched = await readFile(otherPath);
      const workspaceFile = join(workspace.path, 'my-file.txt');
      await writeFile(workspaceFile, '用户工作区文件');
      const attachment = join(root, 'shared-attachments.bin');
      await writeFile(attachment, '共享附件');
      const writer = await ctx.sessionPersistence.open(SessionId(input.sessionId), 'write');
      try {
        const stored = await writer.read();
        const restored = Session.fromRestore(writer.id, stored.events, writer.header, writer.inheritedEventCount, stored.eventState);
        restored.append('user/message', createUserMessage({ content: [{ type: 'text', text: '导入之后的后续新问题' }], source: { kind: 'user' } }), { surfaceOp: 'append' });
        restored.append('session/title', { title: '之后改过的标题', messageSeqs: [], source: { kind: 'user' } });
        await writer.append(restored.snapshotEvents(SessionLogOffset(stored.events.length)));
        await writer.flush();
      } finally { await writer.close(); }
      await adapter.repairSessionMetadata!(input.sessionId);
      assert.equal(ctx.sessionProjectionCache.cachedSnapshot(header)?.values.title, '之后改过的标题');
      await ctx.workspaceRegistry.pinSession(header.id);
      const lockPath = join(dirname(path), 'session.lock');
      const lock = await stat(lockPath);
      const removed: string[] = [];
      ctx.on('api-session/removed', id => { removed.push(id); });
      assert.equal(await adapter.deleteImportedSession!(input.sessionId), true);
      await assertAbsent(ctx, input.sessionId);
      assert.equal(workspace.sessionIds.includes(header.id), false);
      assert.equal(ctx.workspaceRegistry.pinnedSessionIds.includes(header.id), false);
      assert.equal(ctx.workspaceRegistry.archivedSessionIds.includes(header.id), false);
      assert.equal(ctx.sessionProjectionCache.cachedSnapshot(header), undefined);
      assert.deepEqual(removed, [input.sessionId]);
      assert.deepEqual(await readdir(dirname(path)), ['session.lock']);
      assert.equal((await stat(lockPath)).ino, lock.ino, 'the POSIX lock inode must survive');
      assert.deepEqual(await readFile(otherPath), untouched);
      assert.equal(await readFile(workspaceFile, 'utf8'), '用户工作区文件');
      assert.equal(await readFile(attachment, 'utf8'), '共享附件');
      for (const dir of await journals(root)) assert.deepEqual(await readdir(join(root, dir)), []);
      assert.equal(await adapter.deleteImportedSession!(input.sessionId), false);
      await ctx.fiber.dispose(); ctx = undefined;
      ctx = await boot(root, compression);
      await assertAbsent(ctx, input.sessionId);
      assert.ok(await ctx.sessionPersistence.stat(SessionId(other.sessionId)));
      assert.equal(ctx.sessionProjectionCache.cachedSnapshot(header), undefined);
      assert.equal(ctx.workspaceRegistry.get(workspace.id)?.sessionIds.includes(header.id), false);
      assert.equal((await stat(lockPath)).ino, lock.ino);
    } finally { await ctx?.fiber.dispose(); await rm(root, { recursive: true, force: true }); }
  });
}

test('missing native log still clears archive, membership and projections without claiming a deletion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-cleanup-missing-'));
  let ctx: Context | undefined;
  try {
    const result = await setup(root); ({ ctx } = result);
    const { path, header, input, adapter, workspace } = result;
    await ctx.workspaceRegistry.archiveSession(header.id);
    await unlink(path); // Simulate an externally removed isolated test artifact.
    assert.ok(ctx.sessionProjectionCache.cachedSnapshot(header));
    assert.equal(await adapter.deleteImportedSession!(input.sessionId), false);
    assert.equal(ctx.sessionProjectionCache.cachedSnapshot(header), undefined);
    assert.equal(ctx.workspaceRegistry.archivedSessionIds.includes(header.id), false);
    assert.equal(workspace.sessionIds.includes(header.id), false);
    assert.deepEqual(await journals(root), []);
    await assertAbsent(ctx, input.sessionId);
  } finally { await ctx?.fiber.dispose(); await rm(root, { recursive: true, force: true }); }
});

test('live Session and in-process writer ownership refuse without disposing their owner or changing bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-cleanup-owned-'));
  let ctx: Context | undefined;
  let detach: (() => void) | undefined;
  try {
    const result = await setup(root); ({ ctx } = result);
    const { path, header, input, adapter } = result;
    const before = await readFile(path);
    const reader = await ctx.sessionPersistence.open(header.id, 'read');
    const read = await reader.read(); await reader.close();
    const session = ctx.sessions.prepare(header.id, { seed: [...read.events], meta: header, eventState: read.eventState, inheritedEventCount: reader.inheritedEventCount });
    detach = ctx.sessions.enter(session);
    await assert.rejects(adapter.deleteImportedSession!(input.sessionId), /正在使用/);
    assert.equal(ctx.sessions.get(header.id), session);
    assert.deepEqual(await readFile(path), before);
    detach(); detach = undefined;
    const writer = await ctx.sessionPersistence.open(header.id, 'write');
    try { await assert.rejects(adapter.deleteImportedSession!(input.sessionId), /owned|ownership|writer/i); }
    finally { await writer.close(); }
    assert.deepEqual(await readFile(path), before);
    assert.deepEqual(await journals(root), []);
  } finally { detach?.(); await ctx?.fiber.dispose(); await rm(root, { recursive: true, force: true }); }
});

test('another process holding the official writer prevents removal, then releases cleanly', { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-cleanup-cross-process-'));
  let ctx: Context | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const result = await setup(root); ({ ctx } = result);
    const { path, input, adapter } = result;
    const code = `
      import { Context } from '@deepseek-ai/cordis';
      import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
      import Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl';
      const ctx = new Context(); await ctx.plugin(SessionStore);
      await ctx.plugin(Jsonl, {root: process.argv[1], compression: 'none'});
      const writer = await ctx.sessionPersistence.open(SessionId(process.argv[2]), 'write');
      process.stdout.write('READY\\n');
      process.stdin.once('data', async () => { await writer.close(); await ctx.fiber.dispose(); process.exit(0); });
    `;
    child = spawn(process.execPath, ['--input-type=module', '-e', code, join(root, 'sessions'), input.sessionId], { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] });
    let error = ''; child.stderr!.on('data', data => { error += data.toString(); });
    const ready = await Promise.race([once(child.stdout!, 'data'), once(child, 'exit').then(() => { throw new Error(`writer did not start: ${error}`); })]);
    assert.match(String(ready[0]), /READY/);
    const before = await readFile(path);
    await assert.rejects(adapter.deleteImportedSession!(input.sessionId), /owned|ownership|writer/i);
    assert.deepEqual(await readFile(path), before);
    const exited = once(child, 'exit'); child.stdin!.write('release'); await exited; child = undefined;
    assert.equal(await adapter.deleteImportedSession!(input.sessionId), true);
  } finally { child?.kill(); await ctx?.fiber.dispose(); await rm(root, { recursive: true, force: true }); }
});

test('metadata failure leaves a durable staged journal which finishes after a real host restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-cleanup-retry-'));
  let ctx: Context | undefined;
  try {
    const result = await setup(root, 'zstd'); ({ ctx } = result);
    const { input, path, header, workspace, adapter } = result;
    const before = await readFile(path);
    const lock = await stat(join(dirname(path), 'session.lock'));
    workspace.detachSession = async () => { throw new Error('simulated metadata failure'); };
    await assert.rejects(adapter.deleteImportedSession!(input.sessionId), /simulated metadata failure/);
    await assertAbsent(ctx, input.sessionId);
    const dirs = await journals(root); assert.equal(dirs.length, 1);
    const stage = join(root, dirs[0]!, input.sessionId);
    assert.deepEqual(await readFile(join(stage, 'session.v4.jsonl.zstd')), before);
    const journal = JSON.parse(await readFile(join(stage, 'manifest.json'), 'utf8'));
    assert.equal(journal.phase, 'staged');
    assert.equal(journal.sessionId, input.sessionId);
    assert.equal((await lstat(join(stage, 'manifest.json'))).mode & 0o777, 0o600);
    assert.equal((await stat(join(dirname(path), 'session.lock'))).ino, lock.ino);
    await ctx.fiber.dispose(); ctx = undefined;
    ctx = await boot(root, 'zstd');
    assert.equal(await createHarnessAdapter(ctx).deleteImportedSession!(input.sessionId), true);
    await assertAbsent(ctx, input.sessionId);
    assert.equal(ctx.sessionProjectionCache.cachedSnapshot(header), undefined);
    assert.deepEqual(await readdir(join(root, dirs[0]!)), []);
    assert.equal((await stat(join(dirname(path), 'session.lock'))).ino, lock.ino);
  } finally { await ctx?.fiber.dispose(); await rm(root, { recursive: true, force: true }); }
});

test('staging permission failure preserves the entire native log and existing metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-cleanup-stage-failure-'));
  let ctx: Context | undefined;
  let sourceDir: string | undefined;
  try {
    const result = await setup(root); ({ ctx } = result);
    const { input, path, header, workspace, adapter } = result;
    sourceDir = dirname(path);
    const before = await readFile(path);
    await chmod(sourceDir, 0o500);
    await assert.rejects(adapter.deleteImportedSession!(input.sessionId), /EACCES|EPERM/);
    await chmod(sourceDir, 0o700);
    assert.deepEqual(await readFile(path), before);
    assert.ok(workspace.sessionIds.includes(header.id));
    assert.ok(ctx.sessionProjectionCache.cachedSnapshot(header));
    for (const dir of await journals(root)) assert.deepEqual(await readdir(join(root, dir)), []);
  } finally { if (sourceDir) await chmod(sourceDir, 0o700); await ctx?.fiber.dispose(); await rm(root, { recursive: true, force: true }); }
});

test('traversal, a symlinked log and unknown native artifacts fail closed without changing another file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-cleanup-path-'));
  let ctx: Context | undefined;
  try {
    const result = await setup(root); ({ ctx } = result);
    const { input, path, adapter } = result;
    const before = await readFile(path);
    await assert.rejects(adapter.deleteImportedSession!('../../outside'), /UUID/);
    const outside = join(root, 'outside-original');
    await rename(path, outside); await symlink(outside, path);
    await assert.rejects(adapter.deleteImportedSession!(input.sessionId), /符号链接/);
    assert.deepEqual(await readFile(outside), before);
    await unlink(path); await rename(outside, path);
    const extra = join(dirname(path), 'unrecognized-future-content'); await writeFile(extra, '额外内容');
    await assert.rejects(adapter.deleteImportedSession!(input.sessionId), /额外文件/);
    assert.deepEqual(await readFile(path), before);
    assert.equal(await readFile(extra, 'utf8'), '额外内容');
    await unlink(extra);
    const nativeRoot = join(root, 'sessions');
    const actualRoot = join(root, 'sessions-original');
    await rename(nativeRoot, actualRoot); await symlink(actualRoot, nativeRoot);
    await assert.rejects(adapter.deleteImportedSession!(input.sessionId), /根目录/);
    await unlink(nativeRoot); await rename(actualRoot, nativeRoot);
    assert.deepEqual(await readFile(path), before);
    assert.deepEqual(await journals(root), []);
  } finally { await ctx?.fiber.dispose(); await rm(root, { recursive: true, force: true }); }
});

test('a staged transaction refuses a newly recreated native log instead of deleting the new artifact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-cleanup-recreated-'));
  let ctx: Context | undefined;
  try {
    const result = await setup(root); ({ ctx } = result);
    const { input, path, header, workspace, adapter } = result;
    const reader = await ctx.sessionPersistence.open(header.id, 'read');
    const original = await reader.read(); await reader.close();
    const detach = workspace.detachSession.bind(workspace);
    workspace.detachSession = async () => { throw new Error('metadata interrupted'); };
    await assert.rejects(adapter.deleteImportedSession!(input.sessionId), /metadata interrupted/);
    workspace.detachSession = detach;
    const writer = await ctx.sessionPersistence.create(header);
    try {
      await writer.append([...original.events, { type: 'session/title', seq: SessionSeq(original.events.length), time: header.createdAt + 10,
        data: { title: '新出现的独立日志', messageSeqs: [], source: { kind: 'user' } } }]);
      await writer.flush();
    } finally { await writer.close(); }
    const recreated = await readFile(path);
    await assert.rejects(adapter.deleteImportedSession!(input.sessionId), /重新出现|新日志/);
    assert.deepEqual(await readFile(path), recreated);
    const stage = join(root, (await journals(root))[0]!, input.sessionId);
    assert.ok(await stat(join(stage, 'manifest.json')));
    assert.ok(await stat(join(stage, 'session.v4.jsonl')));
  } finally { await ctx?.fiber.dispose(); await rm(root, { recursive: true, force: true }); }
});

test('batch finalization removes deleted native content from the real SQLite search index without resuming an Agent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-cleanup-search-'));
  let ctx: Context | undefined;
  let db: DatabaseSync | undefined;
  try {
    const result = await setup(root); ({ ctx } = result);
    const { input, adapter } = result;
    const queryPath = join(root, 'search.sqlite');
    await ctx.plugin(SqliteSessionQueryEngine, { path: queryPath, openAt: 'startup' });
    await ctx.sessionQuery.searchSessions({ query: '要迁移的原始问题', limit: 1 });
    db = new DatabaseSync(queryPath, { readOnly: true });
    const count = () => (db!.prepare('SELECT count(*) AS count FROM persisted_sessions WHERE id = ?').get(input.sessionId) as { count: number }).count;
    assert.equal(count(), 1);
    await adapter.deleteImportedSession!(input.sessionId);
    assert.equal(count(), 1, 'native removal does not guess at private SQLite mutations');
    await adapter.finalizeSessionDeletion!();
    assert.equal(count(), 0);
    assert.equal((db.prepare('SELECT count(*) AS count FROM persisted_docs WHERE session_id = ?').get(input.sessionId) as { count: number }).count, 0);
    await assert.rejects(ctx.sessionQuery.readSession(SessionId(input.sessionId)), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' });
    assert.equal(ctx.sessions.list().length, 0);
    const search = ctx.sessionQuery.searchSessions.bind(ctx.sessionQuery);
    ctx.sessionQuery.searchSessions = async () => { throw new SessionQueryError('simulated index failure', 'SESSION_QUERY_INDEX_FAILED'); };
    await assert.rejects(adapter.finalizeSessionDeletion!(), { code: 'SESSION_QUERY_INDEX_FAILED' });
    ctx.sessionQuery.searchSessions = search;
  } finally { db?.close(); await ctx?.fiber.dispose(); await rm(root, { recursive: true, force: true }); }
});

test('batch finalization accepts only the official search-disabled failure and does not create its SQLite file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-cleanup-search-disabled-'));
  let ctx: Context | undefined;
  try {
    const result = await setup(root); ({ ctx } = result);
    const { adapter } = result;
    const queryPath = join(root, 'never-opened.sqlite');
    await ctx.plugin(SqliteSessionQueryEngine, { path: queryPath, openAt: 'never' });
    await adapter.finalizeSessionDeletion!();
    await assert.rejects(stat(queryPath), { code: 'ENOENT' });
  } finally { await ctx?.fiber.dispose(); await rm(root, { recursive: true, force: true }); }
});
