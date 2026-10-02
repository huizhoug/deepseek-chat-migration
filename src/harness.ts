import { realpath, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Context } from '@deepseek-ai/cordis';
import { createAssistantMessage, createSystemMessage, createUserMessage } from '@deepseek-ai/dsh-llm';
import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm';
import {
  Session, SessionId, SessionLogOffset, SessionSeq, SESSION_FORMAT_VERSION,
} from '@deepseek-ai/dsh-session';
import type { SessionEvent, SessionEventMap, SessionEventType, SessionHeader } from '@deepseek-ai/dsh-session';
import { validateStoredEvents } from '@deepseek-ai/dsh-session-persistence';
import type { SessionHandle } from '@deepseek-ai/dsh-session-persistence';
import { normalizeSessionTitle } from '@deepseek-ai/dsh-session-title';
import type {} from '@deepseek-ai/dsh-agent-preset-registry';
import { checkpointRecord, projectionCacheDomainSpec } from '@deepseek-ai/dsh-session-projection-cache';
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace';
import type {
  ConversationMessage, HarnessAdapter, HarnessImportInput, ImportedSession,
} from './types.js';
import { createSessionCleanup } from './session-cleanup.js';
import { SessionQueryError } from '@deepseek-ai/dsh-session-query';

/** This release's public Session contract; do not write a guessed physical format. */
export const SUPPORTED_SESSION_FORMAT = 4;
const TITLE_MAX_BYTES = 1024;

export function normalizeImportedTitle(title: string): string {
  return normalizeSessionTitle(title, TITLE_MAX_BYTES) || 'DeepSeek 网页版对话';
}

function validTime(time: number, fallback: number): number {
  if (Number.isSafeInteger(time) && time >= 0) return time;
  if (Number.isSafeInteger(fallback) && fallback >= 0) return fallback;
  throw new Error('对话缺少有效的原始时间，尚未写入 Harness。');
}

function citationText(message: ConversationMessage): string {
  const references = message.citations.flatMap(citation => {
    let url: URL | undefined;
    try {
      if (citation.url) {
        const parsed = new URL(citation.url);
        if (parsed.protocol === 'https:' || parsed.protocol === 'http:') url = parsed;
      }
    } catch { /* Keep the title and excerpt even when the source URL is malformed. */ }
    const title = citation.title.trim();
    const excerpt = citation.snippet?.trim();
    if (!title && !url && !excerpt) return [];
    return [`${title || '来源'}${url ? ` — ${url.href}` : ''}${excerpt ? `\n${excerpt}` : ''}`];
  });
  return references.length ? `\n\n原对话引用来源：\n${references.map((reference, i) => `${i + 1}. ${reference}`).join('\n')}` : '';
}

/** Only real exported text is migrated; missing attachment bytes are never represented as saved files. */
export function buildMessageContent(message: ConversationMessage, includeReasoning: boolean): ContentBlock[] {
  const content: ContentBlock[] = [];
  if (message.role === 'assistant' && includeReasoning && message.reasoning) {
    content.push({ type: 'reasoning', text: message.reasoning });
  }
  const attachments = message.attachments.length
    ? `\n\n[迁移说明：以下附件的原文件未随本次导出提供，未迁移文件内容：${message.attachments.map(item => item.name || item.sourceId || '未命名附件').join('、')}。]`
    : '';
  const text = message.text + citationText(message) + attachments;
  if (text) content.push({ type: 'text', text });
  return content;
}

/** Convert one selected branch into balanced, native, model-visible Session events. */
export function buildSessionEvents(input: HarnessImportInput): SessionEvent[] {
  const events: SessionEvent[] = [];
  if (input.branch.messages.length === 0) throw new Error('空对话分支不能迁移。');
  let turn = 0;
  let step = 1;
  let turnOpen = false;
  let assistantInStep = false;
  let answered = false;
  let lastTime = validTime(input.conversation.createdAt, input.branch.updatedAt);
  const append = <T extends SessionEventType>(type: T, data: SessionEventMap[T], time: number, surface = false): void => {
    events.push({
      type, data, time, seq: SessionSeq(events.length), ...(surface ? { surfaceOp: 'append' as const } : {}),
    } as unknown as SessionEvent);
  };
  const closeTurn = (): void => {
    if (!turnOpen) return;
    append('step/end', { turn, step }, lastTime);
    append('turn/end', { turn, reason: { kind: answered ? 'completed' : 'interrupted' } }, lastTime);
    turnOpen = false;
  };
  for (const message of input.branch.messages) {
    const time = validTime(message.timestamp, input.conversation.createdAt);
    if (message.role === 'user' || !turnOpen) {
      closeTurn();
      turn += 1;
      step = 1;
      answered = false;
      assistantInStep = false;
      turnOpen = true;
      append('turn/start', { turn }, time);
      append('step/start', { turn, step }, time);
      if (turn === 1) {
        // Reserve the native system head for the resumed Harness prompt. This is
        // empty: the source website's hidden system instructions are not known.
        append('system/message', { turn, step, message: createSystemMessage('') }, time, true);
      }
    } else if (assistantInStep) {
      append('step/end', { turn, step }, lastTime);
      step += 1;
      assistantInStep = false;
      append('step/start', { turn, step }, time);
    }
    const content = buildMessageContent(message, input.includeReasoning);
    if (message.role === 'user') {
      append('user/message', createUserMessage({ content, source: { kind: 'user' } }), time, true);
    } else {
      append('assistant/message', {
        turn, step,
        message: createAssistantMessage({
          content,
          // A foreign source namespace avoids pretending to have provider replay metadata or signatures.
          source: { provider: 'deepseek-web-export', model: message.model || 'unknown' },
        }),
        // The export contains settled output, not the original timed stream.
        stream: [],
      }, time, true);
      answered = true;
      assistantInStep = true;
    }
    lastTime = time;
  }
  closeTurn();
  append('session/title', {
    title: normalizeImportedTitle(input.title), messageSeqs: [], source: { kind: 'user' },
  }, validTime(input.branch.updatedAt, lastTime));
  return events;
}

function expectedHistory(input: HarnessImportInput): Array<{ role: 'user' | 'assistant'; content: ContentBlock[] }> {
  return input.branch.messages.flatMap(message => {
    const content = buildMessageContent(message, input.includeReasoning);
    return message.role === 'assistant' && content.length === 0 ? [] : [{ role: message.role, content }];
  });
}

function validateModelHistory(session: Session, input: HarnessImportInput): void {
  const messages = session.deriveMessages().map((message: Message) => ({ role: message.role, content: message.content }));
  if (!isDeepStrictEqual(messages, expectedHistory(input))) {
    throw new Error('原始对话与 Harness 模型历史不一致，导入已中止。');
  }
}

/** Cold imports use the official persistence service and activate through Harness only when opened. */
export function createHarnessAdapter(ctx: Context): HarnessAdapter {
  const checkCompatibility = (): void => {
    if (SESSION_FORMAT_VERSION !== SUPPORTED_SESSION_FORMAT) {
      throw new Error(`当前 Harness 会话格式 v${SESSION_FORMAT_VERSION} 尚未验证兼容；本插件支持 v${SUPPORTED_SESSION_FORMAT}。`);
    }
    if (!ctx.get('sessionPersistence') || !ctx.get('workspaceRegistry') || !ctx.get('sessionProjectionCache')) {
      throw new Error('当前 Harness 未加载会话存储、工作区或侧栏缓存服务，请使用桌面版或 Web profile。');
    }
    // The shipped backend atomically materializes the header and entire first batch.
    if (ctx.sessionPersistence.name !== 'session-persistence-jsonl') {
      throw new Error('当前会话存储后端尚未验证原子导入；请使用 Harness 内置会话存储。');
    }
  };
  const resolveWorkspace = async (input: HarnessImportInput) => {
    const workspace = ctx.workspaceRegistry.get(input.workspaceId as WorkspaceId);
    if (!workspace) throw new Error('目标工作区不存在，请重新选择工作区。');
    const path = await realpath(workspace.path);
    if (!(await stat(path)).isDirectory() || path !== workspace.path) {
      throw new Error('目标工作区目录已移动或无法访问，请先修复工作区。');
    }
    return workspace;
  };
  const result = (input: HarnessImportInput): ImportedSession => ({
    sessionId: input.sessionId, workspaceId: input.workspaceId,
    title: normalizeImportedTitle(input.title), messageCount: input.branch.messages.length,
  });
  const checkpoint = async (header: SessionHeader, events: readonly SessionEvent[], inheritedEventCount = SessionLogOffset(0)): Promise<void> => {
    // Cold persistence does not emit session/created or session/event. The
    // official sidebar lists cached projections without reading each log.
    // Use all registered projections, including title and list timestamps.
    const initialLive = ctx.get('sessions')?.get(header.id);
    if (initialLive) {
      await ctx.sessionProjectionCache.write(initialLive);
    } else {
      // Restoring a Session appends a non-durable resume marker. Fold the exact
      // durable log instead, so the cache never leads storage by that marker.
      const restored = ctx.sessionProjections.restore({}, events, SessionLogOffset(0), header, inheritedEventCount);
      const record = checkpointRecord.parse({
        identity: { formatVersion: header.version, createdAt: header.createdAt,
          ...(header.cwd === undefined ? {} : { cwd: header.cwd }), isSeeded: header.isSeeded, inheritedEventCount },
        rows: restored.checkpoint,
      });
      const domain = ctx.storageDomain.get(projectionCacheDomainSpec.name);
      if (!domain) throw new Error('侧栏缓存存储尚未就绪，请重新启用插件后重试。');
      // The public domain's table is the cache's own coherent write chain:
      // durability, in-memory update and domain/changed notification are one operation.
      await domain.table('sessions').put(header.id, record);
    }
    const live = ctx.get('sessions')?.get(header.id);
    if (live && live !== initialLive) await ctx.sessionProjectionCache.write(live);
    const cached = ctx.sessionProjectionCache.cachedSnapshot(live?.header ?? header, ['title']);
    if (typeof cached?.values.title !== 'string' || !cached.values.title) {
      throw new Error('侧栏标题缓存未生成，请确认 Harness 标题服务已启用后重试。');
    }
    if (!live) {
      const title = events.findLast(event => event.type === 'session/title');
      if (title?.type !== 'session/title' || cached.values.title !== title.data.title) {
        throw new Error('侧栏标题缓存与原生对话不一致，请重试修复。');
      }
    }
  };
  return {
    deleteImportedSession: createSessionCleanup(ctx),
    async finalizeSessionDeletion() {
      const query = ctx.get('sessionQuery');
      if (!query) return;
      try { await query.searchSessions({ query: `deepseek-migration-cleanup-${randomUUID()}`, limit: 1 }); }
      catch (error) { if (!(error instanceof SessionQueryError) || error.code !== 'SESSION_QUERY_SEARCH_DISABLED') throw error; }
    },
    async listWorkspaces() {
      checkCompatibility();
      return ctx.workspaceRegistry.list().map(workspace => ({ id: workspace.id, title: workspace.title, path: workspace.path }));
    },
    async sessionExists(sessionId) {
      checkCompatibility();
      return (await ctx.sessionPersistence.stat(SessionId(sessionId))) !== undefined;
    },
    async repairSessionMetadata(sessionId): Promise<boolean> {
      checkCompatibility();
      const id = SessionId(sessionId);
      const live = ctx.get('sessions')?.get(id);
      if (live) { await ctx.sessionProjectionCache.write(live); return true; }
      if (!await ctx.sessionPersistence.stat(id)) return false;
      const reader = await ctx.sessionPersistence.open(id, 'read');
      let storedEvents: readonly SessionEvent[];
      try {
        const stored = await reader.read();
        storedEvents = stored.events;
      } finally { await reader.close(); }
      // Current native history is authoritative: preserve later replies,
      // user renames and archival/membership instead of replaying the export.
      await checkpoint(reader.header, storedEvents, reader.inheritedEventCount);
      return true;
    },
    async recoverConversation(input): Promise<ImportedSession | undefined> {
      checkCompatibility();
      const id = SessionId(input.sessionId);
      if (!await ctx.sessionPersistence.stat(id)) return undefined;
      if (ctx.get('sessions')?.get(id)) throw new Error('待恢复导入会话正在使用，请停止该对话后重试。');
      const workspace = await resolveWorkspace(input);
      const reader = await ctx.sessionPersistence.open(id, 'read');
      let storedEvents: readonly SessionEvent[];
      try {
        if (reader.header.cwd !== workspace.path || reader.header.isSeeded
          || reader.header.createdAt !== validTime(input.conversation.createdAt, input.branch.updatedAt)) {
          throw new Error('已有会话的来源时间或工作区不匹配，未修改已有对话。');
        }
        const stored = await reader.read();
        const session = Session.fromRestore(id, stored.events, reader.header, SessionLogOffset(0), stored.eventState);
        storedEvents = stored.events;
        validateModelHistory(session, input);
        const title = stored.events.findLast(event => event.type === 'session/title');
        if (title?.type !== 'session/title' || title.data.title !== normalizeImportedTitle(input.title)) {
          throw new Error('已有会话标题不匹配，未修改已有对话。');
        }
      } finally { await reader.close(); }
      await checkpoint(reader.header, storedEvents);
      await workspace.attachSession(id);
      await ctx.workspaceRegistry.unarchiveSession(id);
      return result(input);
    },
    async importConversation(input): Promise<ImportedSession> {
      checkCompatibility();
      const workspace = await resolveWorkspace(input);
      const id = SessionId(input.sessionId);
      if (ctx.get('sessions')?.get(id) || await ctx.sessionPersistence.stat(id)) {
        throw new Error('目标会话 ID 已存在；没有覆盖已有对话。');
      }
      const preset = ctx.get('agentPresets');
      const selectedPreset = preset ? await preset.resolve() : undefined;
      if (selectedPreset?.broken) throw new Error(`默认 Agent 预设无法使用：${selectedPreset.broken}`);
      const header: SessionHeader = {
        version: SESSION_FORMAT_VERSION, id, cwd: workspace.path,
        createdAt: validTime(input.conversation.createdAt, input.branch.updatedAt),
        isSeeded: false, delegationDepth: 0,
        ...(selectedPreset ? { agentPreset: selectedPreset.id } : {}),
      };
      const events = buildSessionEvents(input);
      // Finish all conversion, vocabulary and model-surface validation before touching storage.
      validateStoredEvents(header, events);
      validateModelHistory(Session.create(id, events, header), input);
      let writer: SessionHandle | undefined;
      let attached = false;
      try {
        writer = await ctx.sessionPersistence.create(header);
        // One first batch: the built-in provider publishes either this complete conversation or nothing.
        await writer.append(events);
        await writer.flush();
        await writer.close();
        writer = undefined;
        const reader = await ctx.sessionPersistence.open(id, 'read');
        let restored: Session;
        try {
          const stored = await reader.read();
          if (!isDeepStrictEqual(stored.events, events) || !isDeepStrictEqual(reader.header, header)) {
            throw new Error('导入后复读校验未通过。');
          }
          restored = Session.fromRestore(id, stored.events, reader.header, SessionLogOffset(0), stored.eventState);
          validateModelHistory(restored, input);
        } finally { await reader.close(); }
        await checkpoint(header, events);
        await workspace.attachSession(id);
        attached = true;
        return result(input);
      } catch (error) {
        await writer?.close().catch(() => undefined);
        // Public persistence intentionally has no delete operation. Quarantine a fully published
        // session on late verification/attachment failure; never remove backend-owned files.
        const stored = await ctx.sessionPersistence.stat(id).catch(() => undefined);
        if (stored) {
          if (attached || workspace.sessionIds.includes(id)) await workspace.detachSession(id).catch(() => undefined);
          await ctx.workspaceRegistry.archiveSession(id).catch(() => undefined);
        }
        throw error;
      }
    },
  };
}
