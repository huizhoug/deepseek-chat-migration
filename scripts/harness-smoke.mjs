import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// All writes stay in fresh temporary roots owned by the tests; the user's .dsh is never opened.
const cwd = fileURLToPath(new URL('../', import.meta.url));
const result = spawnSync(process.execPath, [
  '--import', 'tsx', '--test', '--test-name-pattern', 'real official|late workspace|official AgentLoop|bad timestamps',
  'test/harness.test.ts',
], { cwd, stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;

if (result.status === 0 && process.env.DEEPSEEK_EXPORT) {
  const archive = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', `
    import { readFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
    import { join, basename } from 'node:path';
    import { tmpdir } from 'node:os';
    import { Context } from '@deepseek-ai/cordis';
    import SessionStore, { Session, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session';
    import Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl';
    import Storage from '@deepseek-ai/dsh-storage';
    import * as Domain from '@deepseek-ai/dsh-storage-domain';
    import * as Json from '@deepseek-ai/dsh-storage-json';
    import WorkspaceRegistry from '@deepseek-ai/dsh-workspace';
    import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
    import SessionProjectionCache from '@deepseek-ai/dsh-session-projection-cache';
    import { titleProjectionDefinition } from '@deepseek-ai/dsh-session-title';
    import { parseExport } from './src/archive.ts';
    import { createHarnessAdapter, normalizeImportedTitle } from './src/harness.ts';
    const parsed = parseExport(await readFile(process.env.DEEPSEEK_EXPORT), basename(process.env.DEEPSEEK_EXPORT));
    const root = await mkdtemp(join(tmpdir(), 'deepseek-export-native-smoke-'));
    const boot = async () => {
      const ctx = new Context();
      await ctx.plugin(Storage); await ctx.plugin(Json, { root: join(root, 'storages') });
      await ctx.plugin(Domain, { backend: 'json' }); await ctx.plugin(SessionStore);
      await ctx.plugin(Jsonl, { root: join(root, 'sessions'), compression: 'zstd' });
      await ctx.plugin(WorkspaceRegistry);
      await ctx.plugin(SessionProjectionRegistry);
      ctx.sessionProjections.register(titleProjectionDefinition);
      await ctx.plugin(SessionProjectionCache, { writeEveryEvents: 200, writeIntervalMs: 5000 });
      return ctx;
    };
    const verifyTitleCache = (context, header, events, expectedTitle) => {
      const cached = context.sessionProjectionCache.cachedSnapshot(header, ['title']);
      if (!cached || cached.values.title !== expectedTitle) throw new Error('sidebar title mismatch');
      const lastSeq = events.at(-1)?.seq;
      if (typeof cached.asOfSeq !== 'number' || typeof lastSeq !== 'number' || cached.asOfSeq > lastSeq) {
        throw new Error('sidebar cache exceeds the durable native log');
      }
      if (context.sessions.get(header.id)) throw new Error('cold import unexpectedly activated a native session');
    };
    let ctx;
    const created = []; let failed = 0; let messages = 0; let coldTitles = 0;
    try {
      await mkdir(join(root, 'workspace')); ctx = await boot();
      const workspace = await ctx.workspaceRegistry.create(join(root, 'workspace'));
      const adapter = createHarnessAdapter(ctx);
      let ordinal = 0;
      for (const conversation of parsed.conversations) for (const branch of conversation.branches) {
        ordinal += 1;
        const input = { conversation, branch, workspaceId: workspace.id, includeReasoning: true, title: normalizeImportedTitle(conversation.title), sessionId: 'export-smoke-' + ordinal };
        let stage = 'import';
        try {
          await adapter.importConversation(input); created.push(input); messages += branch.messages.length;
          stage = 'cold-title';
          const reader = await ctx.sessionPersistence.open(SessionId(input.sessionId), 'read');
          try {
            const stored = await reader.read();
            verifyTitleCache(ctx, reader.header, stored.events, input.title);
            coldTitles += 1;
          } finally { await reader.close(); }
        } catch (error) { failed += 1; console.error(JSON.stringify({ failedBranch: ordinal, stage, errorType: error?.name ?? 'Error' })); }
        if (ordinal % 40 === 0) console.log(JSON.stringify({ checkedBranches: ordinal, imported: created.length, verifiedColdTitles: coldTitles, failed }));
      }
      await ctx.fiber.dispose(); ctx = undefined; ctx = await boot();
      let restored = 0; let restartedTitles = 0;
      for (const input of created) {
        let reader; let stage = 'restart-history';
        try {
          reader = await ctx.sessionPersistence.open(SessionId(input.sessionId), 'read');
          const stored = await reader.read();
          const session = Session.fromRestore(reader.id, stored.events, reader.header, SessionLogOffset(0), stored.eventState);
          const expected = input.branch.messages.filter(message => message.role === 'user' || message.text || message.reasoning || message.attachments.length || message.citations.length).length;
          if (session.deriveMessages().length !== expected) throw new Error('restored history mismatch');
          if (!ctx.workspaceRegistry.get(input.workspaceId)?.sessionIds.includes(reader.id)) throw new Error('workspace membership mismatch');
          restored += 1;
          stage = 'restart-title';
          verifyTitleCache(ctx, reader.header, stored.events, input.title);
          restartedTitles += 1;
        } catch (error) { failed += 1; console.error(JSON.stringify({ failedSession: input.sessionId, stage, errorType: error?.name ?? 'Error' })); }
        finally { await reader?.close(); }
      }
      console.log(JSON.stringify({ actualArchive: true, conversations: parsed.conversations.length, branches: ordinal, imported: created.length, verifiedColdTitles: coldTitles, restoredAfterRestart: restored, verifiedRestartedTitles: restartedTitles, branchMessages: messages, failed }));
      if (failed) process.exitCode = 1;
    } finally {
      try { await ctx?.fiber.dispose(); }
      finally { await rm(root, { recursive: true, force: true }); }
    }
  `], { cwd, stdio: 'inherit' });
  if (archive.error) throw archive.error;
  process.exitCode = archive.status ?? 1;
}
