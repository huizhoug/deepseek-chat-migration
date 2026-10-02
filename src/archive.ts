import { unzipSync } from 'fflate';
import type {
  Conversation, ConversationBranch, ConversationMessage, ConversationSummary,
  ParsedExport, SourceAttachment, SourceCitation,
} from './types.js';

export const MAX_ARCHIVE_BYTES = 200 * 1024 * 1024;
export const MAX_CONVERSATIONS_BYTES = 128 * 1024 * 1024;
const MAX_GRAPH_NODES = 100_000;
const MAX_CONVERSATIONS = 20_000;
const MAX_BRANCHES = 4_096;
const MAX_BRANCH_MESSAGE_REFERENCES = 500_000;
const decoder = new TextDecoder('utf-8', { fatal: true });
type ObjectRecord = Record<string, unknown>;
interface ZipEntry { name: string; originalSize: number; crc: number; offset: number }

function record(value: unknown): ObjectRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObjectRecord : undefined;
}
function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : typeof value === 'number' && Number.isFinite(value) ? String(value) : undefined;
}
function firstString(...values: unknown[]): string | undefined {
  return values.map(string).find(value => value !== undefined && value.length > 0);
}
function instant(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value < 1e12 ? value * 1000 : value;
  if (typeof value !== 'string' || !value.trim()) return 0;
  if (/^\d+(\.\d+)?$/.test(value)) return instant(Number(value));
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}
function safeId(value: unknown, fallback: string): string {
  return (string(value) || fallback).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 160) || fallback;
}
function warn(warnings: string[], message: string): void {
  if (!warnings.includes(message)) warnings.push(message);
}
function fail(message: string): never { throw new Error(message); }

/** Inspect names and declared sizes before fflate can allocate decompressed data. */
function inspectZip(bytes: Uint8Array): ZipEntry {
  if (bytes.length < 22) fail('ZIP 文件不完整，请重新下载官方导出文件。');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let index = bytes.length - 22; index >= Math.max(0, bytes.length - 65_557); index--) {
    if (view.getUint32(index, true) === 0x06054b50 && index + 22 + view.getUint16(index + 20, true) === bytes.length) {
      end = index; break;
    }
  }
  if (end < 0) fail('无法读取 ZIP 目录，文件可能损坏或不是标准 ZIP。');
  const count = view.getUint16(end + 10, true);
  const directorySize = view.getUint32(end + 12, true);
  const directoryOffset = view.getUint32(end + 16, true);
  if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true) || view.getUint16(end + 8, true) !== count) fail('暂不支持分卷 ZIP，请选择完整的官方导出文件。');
  if (count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) fail('暂不支持 ZIP64，请解压后选择 conversations.json。');
  if (directoryOffset + directorySize !== end) fail('ZIP 目录边界不正确，文件可能损坏。');
  let offset = directoryOffset;
  let selected: ZipEntry | undefined;
  for (let index = 0; index < count; index++) {
    if (offset + 46 > end || view.getUint32(offset, true) !== 0x02014b50) fail('ZIP 目录记录不完整。');
    const flags = view.getUint16(offset + 8, true);
    const originalSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const next = offset + 46 + nameLength + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    if (next > end || localOffset + 30 > directoryOffset) fail('ZIP 文件记录超出有效范围。');
    let name: string;
    try { name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength)); }
    catch { fail('ZIP 包含无法识别的文件名，请解压后选择 conversations.json。'); }
    if (!name || name.includes('\0') || name.includes('\\') || name.startsWith('/') || /^[a-z]:/i.test(name) || name.split('/').includes('..')) fail('ZIP 包含不安全的文件路径，已拒绝读取。');
    if (view.getUint32(localOffset, true) !== 0x04034b50) fail('ZIP 文件头与目录不匹配。');
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const compressedSize = view.getUint32(offset + 20, true);
    if (localOffset + 30 + localNameLength + localExtraLength + compressedSize > directoryOffset) fail('ZIP 文件内容不完整。');
    let localName: string;
    try { localName = decoder.decode(bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength)); }
    catch { fail('ZIP 本地文件名无法识别。'); }
    if (localName !== name || view.getUint16(localOffset + 6, true) !== flags || view.getUint16(localOffset + 8, true) !== view.getUint16(offset + 10, true)) fail('ZIP 文件头与目录不匹配。');
    if (name.split('/').at(-1) === 'conversations.json') {
      if (selected) fail('ZIP 中有多个 conversations.json，无法确定应导入哪一份。');
      if (flags & 1) fail('conversations.json 已加密，请先解密后选择 JSON 文件。');
      if (originalSize === 0xffffffff || originalSize > MAX_CONVERSATIONS_BYTES) fail('conversations.json 超过 128 MiB 限制，请拆分后导入。');
      selected = { name, originalSize, crc: view.getUint32(offset + 16, true), offset: localOffset };
    }
    offset = next;
  }
  if (offset !== end) fail('ZIP 目录记录数量与目录长度不一致。');
  if (!selected) fail('ZIP 中未找到 conversations.json，请选择 DeepSeek 官方历史导出文件。');
  return selected;
}

const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  return crc >>> 0;
});
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff]!;
  return (crc ^ 0xffffffff) >>> 0;
}
function conversationsBytes(bytes: Uint8Array, filename: string): Uint8Array {
  const isZip = /\.zip$/i.test(filename) || (bytes[0] === 0x50 && bytes[1] === 0x4b);
  if (bytes.length > (isZip ? MAX_ARCHIVE_BYTES : MAX_CONVERSATIONS_BYTES)) fail(isZip ? 'ZIP 超过 200 MiB 限制，请解压后选择 conversations.json。' : 'JSON 超过 128 MiB 限制，请拆分后导入。');
  if (!isZip) return bytes;
  const entry = inspectZip(bytes);
  let unpacked: Uint8Array | undefined;
  try {
    const files = unzipSync(bytes, { filter: file => file.name === entry.name && file.originalSize <= MAX_CONVERSATIONS_BYTES });
    unpacked = files[entry.name];
  } catch { fail('conversations.json 解压失败，ZIP 可能损坏，请重新下载。'); }
  if (!unpacked || unpacked.length !== entry.originalSize || crc32(unpacked) !== entry.crc) fail('conversations.json 完整性校验失败，请重新下载导出文件。');
  return unpacked;
}

function httpUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password ? value : undefined;
  } catch { return undefined; }
}
function attachment(value: unknown, index: number): SourceAttachment {
  const data = record(value) || {};
  return {
    name: firstString(data.file_name, data.filename, data.name, data.title) || `附件 ${index + 1}`,
    sourceId: firstString(data.id, data.file_id, data.source_id),
    available: false,
  };
}
function citation(value: unknown): SourceCitation | undefined {
  const data = record(value);
  if (!data) return undefined;
  const url = httpUrl(data.url ?? data.link ?? data.href);
  const title = firstString(data.title, data.name) || url;
  if (!title) return undefined;
  return { title, url, snippet: firstString(data.snippet, data.summary, data.content, data.description) };
}
function contentText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(item => typeof item === 'string' ? item : firstString(record(item)?.text, record(item)?.content) || '').filter(Boolean).join('\n\n');
  const data = record(value);
  if (!data) return '';
  return contentText(data.parts ?? data.text ?? data.content);
}

function parseMessage(value: unknown, id: string, warnings: string[], fallbackTime: number): ConversationMessage {
  const data = record(value);
  if (!data) fail('消息结构不是有效对象。');
  const text: string[] = [];
  const reasoning: string[] = [];
  const attachments: SourceAttachment[] = [];
  const citations: SourceCitation[] = [];
  const roleSignals: ('user' | 'assistant')[] = [];
  const messageLabel = `消息 ${safeId(id, 'unknown')}`;
  const fragments = Array.isArray(data.fragments) ? data.fragments : undefined;
  if (fragments) {
    for (const raw of fragments) {
      const fragment = record(raw);
      const type = firstString(fragment?.type)?.toUpperCase() || 'UNKNOWN';
      if (type === 'REQUEST' || type === 'RESPONSE' || type === 'THINK') {
        roleSignals.push(type === 'REQUEST' ? 'user' : 'assistant');
        if (typeof fragment?.content === 'string') (type === 'THINK' ? reasoning : text).push(fragment.content);
        else {
          warn(warnings, `${messageLabel} 的 ${type} 片段缺少文字，已保留说明。`);
          text.push(`［${type} 片段：导出文件未提供文字］`);
        }
      } else if (type === 'FILE') {
        const files = Array.isArray(fragment?.files) ? fragment.files : [];
        if (files.length) files.forEach((file, index) => attachments.push(attachment(file, index)));
        else {
          text.push('［附件记录：导出文件未提供附件信息或原文件］');
          warn(warnings, `${messageLabel} 的附件记录不完整。`);
        }
      } else if (type === 'SEARCH' || type === 'TOOL_SEARCH') {
        const results = Array.isArray(fragment?.results) ? fragment.results : [];
        let recognized = 0;
        for (const result of results) {
          const reference = citation(result);
          if (reference) { citations.push(reference); recognized++; }
        }
        if (recognized !== results.length || !recognized) {
          text.push('［搜索记录：部分引用信息未包含在导出文件中］');
          warn(warnings, `${messageLabel} 的搜索引用信息不完整。`);
        }
      } else if (type === 'TOOL_OPEN') {
        text.push('［网页打开记录：导出文件未提供网页正文］');
        warn(warnings, `${messageLabel} 包含未附正文的网页打开记录。`);
      } else {
        text.push(`［未识别的导出片段：${safeId(type, 'UNKNOWN')}］`);
        warn(warnings, `${messageLabel} 包含未支持的 ${safeId(type, 'UNKNOWN')} 片段，已保留说明。`);
      }
    }
  } else {
    const rendered = contentText(data.content ?? data.text ?? data.parts);
    if (rendered) text.push(rendered);
    const thought = contentText(data.reasoning ?? data.reasoning_content);
    if (thought) reasoning.push(thought);
    const sourceAttachments = data.attachments ?? record(data.metadata)?.attachments;
    if (Array.isArray(sourceAttachments)) sourceAttachments.forEach((file, index) => attachments.push(attachment(file, index)));
    if (Array.isArray(data.citations)) data.citations.forEach(item => { const reference = citation(item); if (reference) citations.push(reference); });
  }
  const declaredRole = firstString(data.role, record(data.author)?.role)?.toLowerCase();
  const declared = declaredRole === 'user' || declaredRole === 'human' ? 'user' : declaredRole === 'assistant' || declaredRole === 'model' || declaredRole === 'gpt' ? 'assistant' : undefined;
  let role = roleSignals[0] || declared;
  if (roleSignals.includes('user') && roleSignals.includes('assistant')) warn(warnings, `${messageLabel} 同时包含提问和回答片段，已按首个片段角色保留原文。`);
  if (!role) {
    role = 'assistant';
    warn(warnings, `${messageLabel} 未提供可识别的对话角色，已作为记录说明保留。`);
    text.unshift(`［导出记录角色：${safeId(declaredRole, '未提供')}；未能确定原始角色］`);
  }
  if (!text.some(part => part.length) && !reasoning.some(part => part.length) && !attachments.length && !citations.length) {
    text.push('［空消息：导出文件未提供文字或附件内容］');
    warn(warnings, `${messageLabel} 是空消息，已保留说明。`);
  }
  if (attachments.length) warn(warnings, '导出文件不包含附件原文件；仅保留附件名称和来源编号。');
  return {
    id, role, text: text.join('\n\n'), reasoning: reasoning.join('\n\n'),
    timestamp: instant(data.inserted_at ?? data.create_time ?? data.created_at ?? data.timestamp) || fallbackTime,
    model: firstString(data.model, record(data.metadata)?.model_slug), attachments,
    citations: citations.filter((item, index, all) => all.findIndex(other => other.url === item.url && other.title === item.title && other.snippet === item.snippet) === index),
  };
}

interface GraphNode { id: string; parent: string | null; message: unknown }
function parseGraph(mapping: ObjectRecord, warnings: string[], fallbackTime: number, updatedAt: number): ConversationBranch[] {
  const nodes = new Map<string, GraphNode>();
  const entries = Object.entries(mapping);
  if (!entries.length) fail('会话 mapping 为空。');
  if (entries.length > MAX_GRAPH_NODES) fail('会话节点过多，请拆分后导入。');
  for (const [id, raw] of entries) {
    const node = record(raw);
    if (!node) fail(`节点 ${safeId(id, 'unknown')} 结构不正确。`);
    const parent = string(node.parent);
    if (node.parent !== null && node.parent !== undefined && parent === undefined) fail(`节点 ${safeId(id, 'unknown')} 的 parent 格式不正确。`);
    nodes.set(id, { id, parent: parent || null, message: node.message });
  }
  const parentsWithChildren = new Set<string>();
  for (const node of nodes.values()) {
    if (node.parent && nodes.has(node.parent)) parentsWithChildren.add(node.parent);
    else if (node.parent) warn(warnings, `节点 ${safeId(node.id, 'unknown')} 的父节点缺失，已保留为独立分支。`);
    const declaredChildren = record(mapping[node.id])?.children;
    if (declaredChildren !== undefined && !Array.isArray(declaredChildren)) warn(warnings, `节点 ${safeId(node.id, 'unknown')} 的 children 格式异常，已按 parent 关系恢复顺序。`);
    if (Array.isArray(declaredChildren)) {
      for (const child of declaredChildren) {
        const childId = string(child);
        if (!childId || !nodes.has(childId) || nodes.get(childId)?.parent !== node.id) warn(warnings, `节点 ${safeId(node.id, 'unknown')} 的子节点声明不一致，已按 parent 关系恢复顺序。`);
      }
    }
  }
  // A parent graph must be acyclic, including disconnected components.
  const complete = new Set<string>();
  for (const node of nodes.values()) {
    const path = new Set<string>();
    let cursor: GraphNode | undefined = node;
    while (cursor && !complete.has(cursor.id)) {
      if (path.has(cursor.id)) fail(`消息关系包含循环（节点 ${safeId(cursor.id, 'unknown')}），无法确定对话顺序。`);
      path.add(cursor.id);
      cursor = cursor.parent ? nodes.get(cursor.parent) : undefined;
    }
    for (const id of path) complete.add(id);
  }
  const leaves = [...nodes.values()].filter(node => !parentsWithChildren.has(node.id));
  if (leaves.length > MAX_BRANCHES) fail('会话分支过多，请拆分后导入。');
  if (leaves.length > 1) warn(warnings, `导出文件包含 ${leaves.length} 条叶分支；未提供可核实的当前活动分支，全部保留。`);
  const messagesByNode = new Map<string, ConversationMessage>();
  for (const node of nodes.values()) {
    if (node.message !== null && node.message !== undefined) messagesByNode.set(node.id, parseMessage(node.message, node.id, warnings, fallbackTime));
    else if (node.parent) {
      warn(warnings, `节点 ${safeId(node.id, 'unknown')} 缺少消息对象，已保留空记录说明。`);
      messagesByNode.set(node.id, { id: node.id, role: 'assistant', text: '［空节点：导出文件未提供消息内容或原始角色］', reasoning: '', timestamp: fallbackTime, attachments: [], citations: [] });
    }
  }
  let referenceCount = 0;
  return leaves.map(leaf => {
    const path: GraphNode[] = [];
    let cursor: GraphNode | undefined = leaf;
    while (cursor) {
      path.push(cursor);
      if (++referenceCount > MAX_BRANCH_MESSAGE_REFERENCES) fail('会话分支展开后过大，请拆分后导入。');
      cursor = cursor.parent ? nodes.get(cursor.parent) : undefined;
    }
    const messages = path.reverse().flatMap(node => {
      const message = messagesByNode.get(node.id);
      return message ? [message] : [];
    });
    if (!messages.length) {
      warn(warnings, `分支 ${safeId(leaf.id, 'unknown')} 没有消息内容，已保留空记录说明。`);
      messages.push({ id: `${leaf.id}:empty`, role: 'assistant', text: '［空分支：导出文件未提供可迁移的消息内容］', reasoning: '', timestamp: fallbackTime, attachments: [], citations: [] });
    }
    return { id: leaf.id, messages, updatedAt: messages.reduce((latest, message) => Math.max(latest, message.timestamp), 0) || updatedAt };
  });
}

function parseConversation(value: unknown, index: number): Conversation {
  const data = record(value);
  if (!data) fail('会话结构不是有效对象。');
  const id = safeId(data.id ?? data.conversation_id ?? data.uuid, `conversation-${index + 1}`);
  const warnings: string[] = [];
  const createdAt = instant(data.inserted_at ?? data.create_time ?? data.created_at);
  const updatedAt = instant(data.updated_at ?? data.update_time) || createdAt;
  let branches: ConversationBranch[];
  const mapping = record(data.mapping);
  if (mapping) branches = parseGraph(mapping, warnings, createdAt, updatedAt);
  else if (Array.isArray(data.messages)) {
    if (data.messages.length > MAX_GRAPH_NODES) fail('会话消息过多，请拆分后导入。');
    const messages = data.messages.map((message, messageIndex) => parseMessage(message, safeId(record(message)?.id, `message-${messageIndex + 1}`), warnings, createdAt));
    if (!messages.length) fail('会话 messages 为空。');
    branches = [{ id: 'main', messages, updatedAt: messages.reduce((latest, message) => Math.max(latest, message.timestamp), 0) || updatedAt }];
  } else fail('未找到 mapping 或 messages，无法识别此会话格式。');
  const uniqueMessages = new Map(branches.flatMap(branch => branch.messages).map(message => [message.id, message]));
  return {
    id, title: firstString(data.title, data.name) || '未命名对话', createdAt, updatedAt,
    branches, warnings, attachmentCount: [...uniqueMessages.values()].reduce((count, message) => count + message.attachments.length, 0),
  };
}

/** Only conversations.json is decoded; other account/export files are never parsed. */
export function parseExport(bytes: Uint8Array, filename: string): ParsedExport {
  const json = conversationsBytes(bytes, filename);
  let input: unknown;
  try { input = JSON.parse(decoder.decode(json).replace(/^\uFEFF/, '')); }
  catch { fail('conversations.json 不是有效的 UTF-8 JSON，请重新下载或选择原始导出文件。'); }
  const wrapper = record(input);
  const list = Array.isArray(input) ? input : Array.isArray(wrapper?.conversations) ? wrapper.conversations : wrapper && (wrapper.mapping || wrapper.messages) ? [wrapper] : undefined;
  if (!list) fail('JSON 顶层不是会话列表，未找到 conversations。请勿选择 user.json。');
  if (list.length > MAX_CONVERSATIONS) fail('导出文件超过 20,000 条会话，请拆分后导入。');
  const conversations: Conversation[] = [];
  const warnings: string[] = [];
  const ids = new Set<string>();
  list.forEach((value, index) => {
    const id = safeId(record(value)?.id ?? record(value)?.conversation_id ?? record(value)?.uuid, `conversation-${index + 1}`);
    try {
      const conversation = parseConversation(value, index);
      if (ids.has(conversation.id)) fail('同一导出文件中会话 ID 重复，已跳过重复记录。');
      ids.add(conversation.id);
      conversations.push(conversation);
    } catch (error) {
      warnings.push(`会话 ${id} 解析失败：${error instanceof Error ? error.message : '结构无法识别。'}`);
    }
  });
  if (list.length && !conversations.length) fail(`导出文件中没有可导入的会话。${warnings.slice(0, 3).join(' ')}`);
  return { conversations, warnings, conversationsJson: json };
}

export function latestBranch(conversation: Conversation): ConversationBranch {
  const branch = conversation.branches.reduce<ConversationBranch | undefined>((latest, candidate) => !latest || candidate.updatedAt > latest.updatedAt ? candidate : latest, undefined);
  if (!branch) fail('会话没有可导入的分支。');
  return branch;
}
export function summarizeConversation(conversation: Conversation, imported = false): ConversationSummary {
  const messageIds = new Set(conversation.branches.flatMap(branch => branch.messages.map(message => message.id)));
  return {
    id: conversation.id, title: conversation.title, createdAt: conversation.createdAt, updatedAt: conversation.updatedAt,
    messageCount: messageIds.size, branchCount: conversation.branches.length, attachmentCount: conversation.attachmentCount,
    warnings: conversation.warnings, imported,
  };
}
