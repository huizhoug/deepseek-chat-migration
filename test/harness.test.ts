import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime, { LlmAdapter, createSystemMessage, createUserMessage } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm';
import SessionStore, { Session, SessionId, SessionLogOffset, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session';
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import Storage from '@deepseek-ai/dsh-storage';
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain';
import * as StorageJson from '@deepseek-ai/dsh-storage-json';
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import SessionProjectionCache from '@deepseek-ai/dsh-session-projection-cache';
import { titleProjectionDefinition } from '@deepseek-ai/dsh-session-title';
import { buildMessageContent, buildSessionEvents, createHarnessAdapter, normalizeImportedTitle } from '../src/harness.js';
import type { ConversationMessage, HarnessImportInput } from '../src/types.js';

const originalTime = 1_700_000_000_000;
function message(role: 'user' | 'assistant', text: string, offset: number, extra: Partial<ConversationMessage> = {}): ConversationMessage {
  return { id: `message-${offset}`, role, text, reasoning: '', timestamp: originalTime + offset, attachments: [], citations: [], ...extra };
}
function fixture(workspaceId = 'workspace-test', sessionId = 'migration-test'): HarnessImportInput {
  const messages = [
    message('user', '我想迁移对话。', 1),
    message('assistant', '可以继续聊。', 2, { reasoning: '原始思考片段。', model: 'DeepSeek-R1' }),
    message('user', '这是最后一个未回复问题。', 3),
  ];
  const branch = { id: 'branch-latest', messages, updatedAt: originalTime + 3 };
  return {
    conversation: { id: 'source-conversation', title: '原来的标题', createdAt: originalTime, updatedAt: branch.updatedAt, branches: [branch], warnings: [], attachmentCount: 0 },
    branch, workspaceId, sessionId, title: '原来的标题', includeReasoning: true,
  };
}

async function officialContext(root: string, compression: 'none' | 'zstd'): Promise<Context> {
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

class OfflineAdapter extends LlmAdapter {
  requests: GenerateOptions[] = [];
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model });
  }
  override async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    this.requests.push(options);
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: '离线续聊验收通过。' };
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '离线续聊验收通过。' } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}

test('native events retain roles and times, have balanced turns and leave the final unanswered turn interrupted', () => {
  const input = fixture();
  const events = buildSessionEvents(input);
  assert.deepEqual(events.map(event => event.seq), events.map((_, index) => index));
  assert.equal(events.filter(event => event.type === 'turn/start').length, 2);
  assert.equal(events.filter(event => event.type === 'turn/end').length, 2);
  const ends = events.filter(event => event.type === 'turn/end');
  assert.deepEqual(ends.map(event => event.data.reason.kind), ['completed', 'interrupted']);
  assert.equal(events.find(event => event.type === 'assistant/message')?.time, originalTime + 2);
  const session = Session.create(SessionId(input.sessionId), events, {
    id: SessionId(input.sessionId), version: SESSION_FORMAT_VERSION, createdAt: originalTime, isSeeded: false,
  });
  assert.deepEqual(session.deriveMessages().map(item => item.role), ['user', 'assistant', 'user']);
  const head = events.find(event => event.type === 'system/message');
  assert.ok(head);
  assert.deepEqual(head.data.message.content, []);
  session.append('system/message', { turn: 3, step: 1, message: createSystemMessage('当前 Harness 的真实提示词') }, {
    surfaceOp: { op: 'replace', startSeq: head.seq, endSeq: head.seq }, sourceEventSeqs: [head.seq],
  });
  assert.equal(session.deriveMessages()[0]?.role, 'system');
  assert.equal(session.header.isSeeded, false);
  assert.equal(session.header.parentSession, undefined);
});

test('missing attachments and citations are explicit, and reasoning can be excluded without changing the original message', () => {
  const original = message('assistant', '答案', 1, {
    reasoning: '原始思考', attachments: [{ name: '报告.pdf', available: false }],
    citations: [{ title: '官方说明', url: 'https://example.com/docs' }, { title: '不安全 URL', url: 'javascript:alert(1)' }],
  });
  const content = buildMessageContent(original, false);
  assert.equal(content.length, 1);
  assert.equal(content[0]?.type, 'text');
  const text = content[0]?.type === 'text' ? content[0].text : '';
  assert.match(text, /报告\.pdf/);
  assert.match(text, /未迁移文件内容/);
  assert.match(text, /https:\/\/example.com\/docs/);
  assert.doesNotMatch(text, /javascript:/);
  assert.equal(original.reasoning, '原始思考');
  assert.equal(buildMessageContent(original, true)[0]?.type, 'reasoning');
  assert.equal(normalizeImportedTitle('\u001b[31m 原\n 标题\u202e '), '原 标题');
});

for (const compression of ['none', 'zstd'] as const) {
  test(`real official ${compression} persistence and workspace survive restart and restore native model history`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'deepseek-migration-harness-'));
    let ctx: Context | undefined;
    try {
      const path = join(root, 'workspace');
      await mkdir(path);
      ctx = await officialContext(root, compression);
      const workspace = await ctx.workspaceRegistry.create(path, '迁移测试工作区');
      const input = fixture(workspace.id, `migration-${compression}`);
      const adapter = createHarnessAdapter(ctx);
      const imported = await adapter.importConversation(input);
      assert.equal(imported.title, input.title);
      assert.equal(await adapter.sessionExists(input.sessionId), true);
      assert.ok(workspace.sessionIds.includes(SessionId(input.sessionId)));
      assert.equal(ctx.sessions.get(SessionId(input.sessionId)), undefined, 'cold import must not start a live agent');
      await assert.rejects(adapter.importConversation(input), /已存在/);
      await ctx.fiber.dispose();
      ctx = undefined;

      ctx = await officialContext(root, compression);
      const restoredWorkspace = ctx.workspaceRegistry.get(workspace.id);
      assert.ok(restoredWorkspace?.sessionIds.includes(SessionId(input.sessionId)));
      const reader = await ctx.sessionPersistence.open(SessionId(input.sessionId), 'read');
      try {
        const { events, eventState } = await reader.read();
        const restored = Session.fromRestore(reader.id, events, reader.header, SessionLogOffset(0), eventState);
        assert.equal(reader.header.createdAt, originalTime);
        assert.equal(reader.header.cwd, workspace.path);
        assert.equal(reader.header.isSeeded, false);
        assert.deepEqual(restored.deriveMessages().map(item => item.role), ['user', 'assistant', 'user']);
        const answer = restored.deriveMessages().find(item => item.role === 'assistant');
        assert.equal(answer?.content[0]?.type, 'reasoning');
        assert.equal(answer?.source.kind, 'model');
      } finally { await reader.close(); }
    } finally {
      await ctx?.fiber.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
}

test('late workspace failure quarantines a complete session and recovery validates, reattaches, and unarchives it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-migration-recovery-'));
  let ctx: Context | undefined;
  try {
    await mkdir(join(root, 'workspace'));
    ctx = await officialContext(root, 'none');
    const workspace = await ctx.workspaceRegistry.create(join(root, 'workspace'));
    const input = fixture(workspace.id, 'migration-recover');
    const adapter = createHarnessAdapter(ctx);
    const attach = workspace.attachSession.bind(workspace);
    workspace.attachSession = async () => { throw new Error('simulated workspace failure'); };
    await assert.rejects(adapter.importConversation(input), /simulated workspace failure/);
    assert.equal(await adapter.sessionExists(input.sessionId), true);
    assert.ok(ctx.workspaceRegistry.archivedSessionIds.includes(SessionId(input.sessionId)));
    workspace.attachSession = attach;
    assert.ok(adapter.recoverConversation);
    await assert.rejects(adapter.recoverConversation({ ...input, title: '不匹配的标题' }), /标题不匹配/);
    const result = await adapter.recoverConversation(input);
    assert.equal(result?.sessionId, input.sessionId);
    assert.ok(workspace.sessionIds.includes(SessionId(input.sessionId)));
    assert.equal(ctx.workspaceRegistry.archivedSessionIds.includes(SessionId(input.sessionId)), false);
  } finally {
    await ctx?.fiber.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('bad timestamps and missing workspaces fail before creating a native session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-migration-clean-'));
  let ctx: Context | undefined;
  try {
    await mkdir(join(root, 'workspace'));
    ctx = await officialContext(root, 'none');
    const workspace = await ctx.workspaceRegistry.create(join(root, 'workspace'));
    const adapter = createHarnessAdapter(ctx);
    const input = fixture(workspace.id, 'migration-invalid');
    await assert.rejects(adapter.importConversation({ ...input, workspaceId: 'missing' }), /工作区不存在/);
    input.conversation.createdAt = NaN;
    input.branch.updatedAt = NaN;
    await assert.rejects(adapter.importConversation(input), /原始时间/);
    assert.equal(await adapter.sessionExists(input.sessionId), false);
  } finally {
    await ctx?.fiber.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('official AgentLoop resumes an imported session and its next request contains the original conversation', { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'deepseek-migration-continue-'));
  let ctx: Context | undefined;
  try {
    await mkdir(join(root, 'workspace'));
    ctx = await officialContext(root, 'zstd');
    const workspace = await ctx.workspaceRegistry.create(join(root, 'workspace'));
    const input = fixture(workspace.id, 'migration-continue');
    await createHarnessAdapter(ctx).importConversation(input);
    await ctx.fiber.dispose();
    ctx = await officialContext(root, 'zstd');
    await ctx.plugin(LlmRuntime);
    await ctx.plugin(SystemPrompt, { personaPrefix: '当前 Harness 续聊提示词' });
    await ctx.plugin(ToolRuntime);
    await ctx.plugin(AgentRegistry);
    await ctx.plugin(AgentLoop, { agents: [] });
    const offline = new OfflineAdapter();
    ctx.llm.registerAdapter(['migration-offline'], offline);
    const handle = await ctx.agents.resume({
      resumeSessionId: SessionId(input.sessionId), agentOptions: { provider: 'migration-offline', model: 'offline' },
    });
    const { agent } = handle;
    agent.followup(createUserMessage({ content: [{ type: 'text', text: '请接着上面的内容。' }], source: { kind: 'user' } }));
    await agent.whenIdle();
    await ctx.sessions.flush(agent.session);
    assert.equal(offline.requests.length, 1);
    const request = offline.requests[0]!;
    assert.equal(request.messages[0]?.role, 'system');
    assert.match(JSON.stringify(request.messages), /当前 Harness 续聊提示词/);
    assert.match(JSON.stringify(request.messages), /我想迁移对话/);
    assert.match(JSON.stringify(request.messages), /可以继续聊/);
    assert.match(JSON.stringify(request.messages), /原始思考片段/);
    assert.match(JSON.stringify(request.messages), /请接着上面的内容/);
    const reader = await ctx.sessionPersistence.open(SessionId(input.sessionId), 'read');
    try {
      const stored = await reader.read();
      assert.ok(stored.events.some(event => event.type === 'assistant/message'
        && event.data.message.content.some(block => block.type === 'text' && block.text === '离线续聊验收通过。')));
    } finally { await reader.close(); }
    await handle.dispose();
  } finally {
    await ctx?.fiber.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
