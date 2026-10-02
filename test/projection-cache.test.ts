import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { z } from 'zod';
import SessionStore, {
  SessionId, SessionLogOffset, SessionSeq, SESSION_FORMAT_VERSION,
} from '@deepseek-ai/dsh-session';
import type { SessionHeader } from '@deepseek-ai/dsh-session';
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import SessionProjectionCache from '@deepseek-ai/dsh-session-projection-cache';
import { titleProjectionDefinition } from '@deepseek-ai/dsh-session-title';
import type { SessionListMetadata } from '@deepseek-ai/dsh-api-session-controller/types';
import Storage from '@deepseek-ai/dsh-storage';
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain';
import * as StorageJson from '@deepseek-ai/dsh-storage-json';
import WorkspaceRegistry, { WorkspaceId } from '@deepseek-ai/dsh-workspace';
import { buildSessionEvents, createHarnessAdapter } from '../src/harness.js';
import type { HarnessImportInput } from '../src/types.js';

const createdAt = 1_700_000_000_000;
const lastPromptAt = createdAt + 30;

function fixture(workspaceId: string, sessionId: string): HarnessImportInput {
  const messages = [
    { id: 'u1', role: 'user' as const, text: '原来的问题', timestamp: createdAt + 10 },
    { id: 'a1', role: 'assistant' as const, text: '原来的回答', timestamp: createdAt + 20 },
    { id: 'u2', role: 'user' as const, text: '后来的问题', timestamp: lastPromptAt },
    { id: 'a2', role: 'assistant' as const, text: '后来的回答', timestamp: createdAt + 40 },
  ].map(message => ({ ...message, reasoning: '', attachments: [], citations: [] }));
  const branch = { id: 'branch-a', messages, updatedAt: createdAt + 40 };
  return {
    conversation: {
      id: 'synthetic-conversation', title: '原始迁移标题', createdAt,
      updatedAt: branch.updatedAt, branches: [branch], warnings: [], attachmentCount: 0,
    },
    branch, workspaceId, sessionId, title: '原始迁移标题', includeReasoning: false,
  };
}

async function boot(root: string, compression: 'none' | 'zstd' = 'zstd'): Promise<Context> {
  const ctx = new Context();
  try {
    await ctx.plugin(Storage);
    await ctx.plugin(StorageJson, { root: join(root, 'storages') });
    await ctx.plugin(StorageDomain, { backend: 'json' });
    await ctx.plugin(SessionStore);
    await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression });
    await ctx.plugin(WorkspaceRegistry);
    await ctx.plugin(SessionProjectionRegistry);
    ctx.sessionProjections.register(titleProjectionDefinition);
    // The Session Controller owns this list-only unit. Its definition is not a
    // public export, so register its public schema and event semantics here;
    // every persistence, projection, and cache operation below is the real API.
    const metadataSchema = z.object({ blank: z.boolean(), lastPromptAt: z.number().nullable() });
    ctx.sessionProjections.register<'sessionListMetadata', SessionListMetadata>({
      key: 'sessionListMetadata', stateVersion: 1,
      stateSchema: metadataSchema,
      init: () => ({ blank: true, lastPromptAt: null }),
      apply: (state, event) => ({
        blank: state.blank && event.type !== 'turn/start',
        lastPromptAt: event.type === 'user/message' && event.data.source.kind === 'user'
          ? event.time : state.lastPromptAt,
      }),
      wire: { viewSchema: metadataSchema, view: state => state },
    });
    await ctx.plugin(SessionProjectionCache, { writeEveryEvents: 100_000, writeIntervalMs: 60_000 });
    return ctx;
  } catch (error) { await ctx.fiber.dispose(); throw error; }
}

async function readNative(ctx: Context, id: string) {
  const reader = await ctx.sessionPersistence.open(SessionId(id), 'read');
  try {
    const read = await reader.read();
    return {
      header: structuredClone(reader.header), inheritedEventCount: reader.inheritedEventCount,
      events: structuredClone(read.events), eventState: read.eventState,
    };
  } finally { await reader.close(); }
}

async function legacyColdImport(ctx: Context, input: HarnessImportInput, cwd: string) {
  const header: SessionHeader = {
    id: SessionId(input.sessionId), version: SESSION_FORMAT_VERSION,
    cwd, createdAt, isSeeded: false, delegationDepth: 0,
  };
  const events = buildSessionEvents(input);
  const writer = await ctx.sessionPersistence.create(header);
  try { await writer.append(events); await writer.flush(); }
  finally { await writer.close(); }
  await ctx.workspaceRegistry.get(WorkspaceId(input.workspaceId))!.attachSession(header.id);
  return header;
}

function assertListCache(ctx: Context, header: SessionHeader, title: string): void {
  const snapshot = ctx.sessionProjectionCache.cachedSnapshot(header);
  assert.ok(snapshot, 'cold listings require a persisted projection checkpoint');
  assert.equal(snapshot.values.title, title);
  assert.deepEqual(snapshot.values.sessionListMetadata, { blank: false, lastPromptAt });
}

for (const compression of ['none', 'zstd'] as const) {
  test(`cold ${compression} import immediately checkpoints title and activity, and survives restart without Agents`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'deepseek-projection-import-'));
    let ctx: Context | undefined;
    try {
      const cwd = join(root, 'workspace'); await mkdir(cwd);
      ctx = await boot(root, compression);
      const workspace = await ctx.workspaceRegistry.create(cwd, '合成工作区');
      const input = fixture(workspace.id, `cache-${compression}`);
      await createHarnessAdapter(ctx).importConversation(input);
      const stored = await readNative(ctx, input.sessionId);
      assertListCache(ctx, stored.header, input.title);
      assert.equal(ctx.sessionProjectionCache.cachedSnapshot(stored.header)?.asOfSeq, stored.events.at(-1)!.seq,
        'a cold cache checkpoint must not lead the durable event log');
      assert.equal(ctx.sessions.get(stored.header.id), undefined);
      assert.equal(ctx.sessions.list().length, 0, 'metadata must not activate imported Sessions');
      assert.equal(ctx.get('agents'), undefined, 'no Agent service or model is needed for import');
      await ctx.fiber.dispose(); ctx = undefined;

      ctx = await boot(root, compression);
      const restarted = await readNative(ctx, input.sessionId);
      assertListCache(ctx, restarted.header, input.title);
      assert.equal(ctx.sessions.list().length, 0);
      assert.deepEqual(restarted.events, stored.events);
      assert.ok(ctx.workspaceRegistry.get(workspace.id)?.sessionIds.includes(stored.header.id));
    } finally { await ctx?.fiber.dispose(); await rm(root, { recursive: true, force: true }); }
  });
}

test('repair checkpoints an old cold import from its current native title without changing history or revision', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-projection-repair-'));
  let ctx: Context | undefined;
  try {
    const cwd = join(root, 'workspace'); await mkdir(cwd);
    ctx = await boot(root);
    const workspace = await ctx.workspaceRegistry.create(cwd);
    const input = fixture(workspace.id, 'old-cold-import');
    const header = await legacyColdImport(ctx, input, workspace.path);
    assert.equal(ctx.sessionProjectionCache.cachedSnapshot(header), undefined);

    // A later user rename belongs to the native log, not the import ledger.
    const original = await readNative(ctx, input.sessionId);
    const writer = await ctx.sessionPersistence.open(header.id, 'write');
    const currentTitle = '用户后来修改的标题';
    try {
      await writer.append([{
        type: 'session/title', seq: SessionSeq(original.events.length), time: createdAt + 50,
        data: { title: currentTitle, messageSeqs: [], source: { kind: 'user' } },
      }]);
      await writer.flush();
    } finally { await writer.close(); }
    await ctx.workspaceRegistry.archiveSession(header.id);
    const membership = [...workspace.sessionIds];
    const archived = [...ctx.workspaceRegistry.archivedSessionIds];
    const before = await readNative(ctx, input.sessionId);
    const revision = (await ctx.sessionPersistence.stat(header.id))!.revision;
    const adapter = createHarnessAdapter(ctx);
    assert.ok(adapter.repairSessionMetadata);
    assert.equal(await adapter.repairSessionMetadata(input.sessionId), true);
    assertListCache(ctx, header, currentTitle);
    assert.equal(ctx.sessionProjectionCache.cachedSnapshot(header)?.asOfSeq, before.events.at(-1)!.seq);
    assert.deepEqual(await readNative(ctx, input.sessionId), before);
    assert.equal((await ctx.sessionPersistence.stat(header.id))!.revision, revision);
    assert.deepEqual(workspace.sessionIds, membership);
    assert.deepEqual(ctx.workspaceRegistry.archivedSessionIds, archived);
    assert.equal(ctx.sessions.list().length, 0);
    assert.equal(await adapter.repairSessionMetadata('missing-native-session'), false);
    assert.equal(await ctx.sessionPersistence.stat(SessionId('missing-native-session')), undefined);
    await ctx.fiber.dispose(); ctx = undefined;

    ctx = await boot(root);
    assertListCache(ctx, header, currentTitle);
    assert.deepEqual(await readNative(ctx, input.sessionId), before);
    assert.deepEqual(ctx.workspaceRegistry.get(workspace.id)?.sessionIds, membership);
    assert.deepEqual(ctx.workspaceRegistry.archivedSessionIds, archived);
    assert.equal(ctx.sessions.list().length, 0);
  } finally { await ctx?.fiber.dispose(); await rm(root, { recursive: true, force: true }); }
});

test('repair prefers the current live Session title and preserves its exact log without creating an Agent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-projection-live-'));
  let ctx: Context | undefined;
  let detach: (() => void) | undefined;
  try {
    const cwd = join(root, 'workspace'); await mkdir(cwd);
    ctx = await boot(root);
    const workspace = await ctx.workspaceRegistry.create(cwd);
    const input = fixture(workspace.id, 'live-current-title');
    await legacyColdImport(ctx, input, workspace.path);
    const writer = await ctx.sessionPersistence.open(SessionId(input.sessionId), 'write');
    try {
      const read = await writer.read();
      const session = ctx.sessions.prepare(writer.id, {
        seed: [...read.events], meta: structuredClone(writer.header),
        inheritedEventCount: writer.inheritedEventCount, eventState: read.eventState,
      });
      // Resume constructs an unannounced end-seed marker. Its owner persists
      // that constructor suffix before publishing any later live event.
      await writer.append(session.snapshotEvents(SessionLogOffset(read.events.length)));
      await writer.flush();
      detach = ctx.sessions.enter(session);
      await ctx.sessionProjectionCache.write(session);
      assertListCache(ctx, session.header, input.title);
      const currentTitle = '当前存活会话的新标题';
      session.append('session/title', {
        title: currentTitle, messageSeqs: [], source: { kind: 'user' },
      });
      await ctx.sessions.flush(session);
      const before = await readNative(ctx, input.sessionId);
      const cursor = session.seq;
      const revision = (await ctx.sessionPersistence.stat(session.id))!.revision;
      assertListCache(ctx, session.header, input.title); // old cached cut witnesses the regression
      const adapter = createHarnessAdapter(ctx);
      assert.ok(adapter.repairSessionMetadata);
      assert.equal(await adapter.repairSessionMetadata(input.sessionId), true);
      assertListCache(ctx, session.header, currentTitle);
      assert.equal(ctx.sessions.get(session.id), session);
      assert.equal(session.seq, cursor);
      assert.deepEqual(await readNative(ctx, input.sessionId), before);
      assert.equal((await ctx.sessionPersistence.stat(session.id))!.revision, revision);
      assert.equal(ctx.sessions.list().length, 1, 'repair must not create another live Session');
      assert.equal(ctx.get('agents'), undefined);
      detach(); detach = undefined;
    } finally { await writer.close(); }
  } finally {
    detach?.(); await ctx?.fiber.dispose(); await rm(root, { recursive: true, force: true });
  }
});
