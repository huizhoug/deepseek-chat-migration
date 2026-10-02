import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { strToU8, zipSync } from 'fflate';
import { latestBranch, MAX_ARCHIVE_BYTES, MAX_CONVERSATIONS_BYTES, parseExport, summarizeConversation } from '../src/archive.js';

const json = (value: unknown) => strToU8(JSON.stringify(value));
const node = (parent: string | null, fragments: unknown[], inserted_at = '2026-01-01T00:00:00Z') => ({ parent, children: [], message: { inserted_at, fragments } });
const request = (content: string) => ({ type: 'REQUEST', content });
const response = (content: string) => ({ type: 'RESPONSE', content });

test('DeepSeek parent graph preserves all leaves and message order without current_node', () => {
  const fixture = readFileSync(new URL('./fixtures/deepseek-branches.json', import.meta.url));
  const parsed = parseExport(fixture, 'conversations.json');
  const conversation = parsed.conversations[0]!;
  assert.equal(conversation.branches.length, 2);
  assert.deepEqual(conversation.branches.find(branch => branch.id === 'answer-a')!.messages.map(message => message.id), ['question', 'answer-a']);
  assert.deepEqual(conversation.branches.find(branch => branch.id === 'answer-b')!.messages.map(message => message.id), ['question', 'answer-b']);
  assert.equal(latestBranch(conversation).id, 'answer-b');
  assert.equal(summarizeConversation(conversation).messageCount, 3);
  assert.match(conversation.warnings.join(' '), /未提供可核实的当前活动分支/);
});

test('mixed DeepSeek fragments keep text and reasoning in order, with limited attachment metadata', () => {
  const parsed = parseExport(json([{ id: 'synthetic', mapping: {
    question: node(null, [request('问题'), { type: 'FILE', files: [{ id: 'file-1', file_name: '例子.pdf', download_url: 'https://secret.invalid/token', metadata: { private: true } }] }]),
    answer: node('question', [
      { type: 'THINK', content: '思考一' }, response('回答一'), { type: 'THINK', content: '思考二' }, response('回答二'),
      { type: 'SEARCH', results: [{ title: '引用一', url: 'https://example.com/a', snippet: '摘要一' }] },
      { type: 'TOOL_SEARCH', results: [{ title: '引用二', url: 'https://example.com/b', content: '摘要二' }, { title: '无效链接', url: 'javascript:alert(1)' }] },
      { type: 'TOOL_OPEN' },
    ]),
  } }]), 'conversations.json');
  const conversation = parsed.conversations[0]!;
  const [question, answer] = conversation.branches[0]!.messages;
  assert.equal(question!.role, 'user');
  assert.deepEqual(question!.attachments, [{ name: '例子.pdf', sourceId: 'file-1', available: false }]);
  assert.equal(conversation.attachmentCount, 1);
  assert.equal(answer!.role, 'assistant');
  assert.equal(answer!.reasoning, '思考一\n\n思考二');
  assert.match(answer!.text, /^回答一\n\n回答二/);
  assert.match(answer!.text, /网页打开记录/);
  assert.equal(answer!.citations.length, 3);
  assert.equal(answer!.citations[1]!.snippet, '摘要二');
  assert.equal(answer!.citations[2]!.url, undefined);
  assert.equal(JSON.stringify(parsed.conversations).includes('secret.invalid'), false);
  assert.equal(JSON.stringify(parsed.conversations).includes('metadata'), false);
});

test('empty and unknown fragments become explicit records instead of disappearing', () => {
  const parsed = parseExport(json([{ id: 'unknowns', mapping: {
    empty: node(null, [request('')]),
    next: node('empty', [{ type: 'FUTURE_PAYLOAD', credentials: 'synthetic-secret' }]),
  } }]), 'conversations.json');
  const conversation = parsed.conversations[0]!;
  assert.equal(conversation.branches[0]!.messages.length, 2);
  assert.match(conversation.branches[0]!.messages[0]!.text, /空消息/);
  assert.match(conversation.branches[0]!.messages[1]!.text, /未识别的导出片段/);
  assert.ok(conversation.warnings.length >= 2);
  assert.equal(JSON.stringify(parsed.conversations).includes('synthetic-secret'), false);
});

test('ChatGPT mapping and direct message exports remain supported', () => {
  const chatgpt = { id: 'chatgpt', create_time: 1_700_000_000, mapping: {
    root: { parent: null, message: null },
    first: { parent: 'root', message: { author: { role: 'user' }, create_time: 1_700_000_001, content: { content_type: 'text', parts: ['第一段', '第二段'] } } },
    second: { parent: 'first', message: { author: { role: 'assistant' }, content: { parts: ['答复'] }, metadata: { model_slug: 'synthetic-model' } } },
  } };
  const direct = { id: 'direct', messages: [{ role: 'human', content: '问题' }, { role: 'model', content: [{ type: 'text', text: '回答' }], reasoning_content: '解释' }] };
  const parsed = parseExport(json({ conversations: [chatgpt, direct] }), 'conversations.json');
  assert.equal(parsed.conversations.length, 2);
  assert.equal(parsed.conversations[0]!.createdAt, 1_700_000_000_000);
  assert.equal(parsed.conversations[0]!.branches[0]!.messages[0]!.text, '第一段\n\n第二段');
  assert.equal(parsed.conversations[0]!.branches[0]!.messages[1]!.model, 'synthetic-model');
  assert.equal(parsed.conversations[1]!.branches[0]!.messages[1]!.reasoning, '解释');
});

test('isolated paths are retained and cycles fail one conversation without discarding others', () => {
  const parsed = parseExport(json([
    { id: 'cycle', mapping: { a: node('b', [request('a')]), b: node('a', [response('b')]) } },
    { id: 'isolated', mapping: { orphan: node('missing', [request('孤立记录')]) } },
  ]), 'conversations.json');
  assert.equal(parsed.conversations.length, 1);
  assert.equal(parsed.conversations[0]!.id, 'isolated');
  assert.match(parsed.conversations[0]!.warnings.join(' '), /父节点缺失/);
  assert.match(parsed.warnings.join(' '), /会话 cycle 解析失败.*循环/);
  assert.equal(parsed.warnings.join(' ').includes('孤立记录'), false);
  assert.throws(() => parseExport(json([{ id: 'cycle', mapping: { a: node('a', [request('a')]) } }]), 'conversations.json'), /循环/);
});

test('ZIP decodes only conversations.json and never parses account data', () => {
  const archive = zipSync({
    'conversations.json': json([{ id: 'zip', messages: [{ role: 'user', content: '例子' }] }]),
    'user.json': strToU8('deliberately invalid JSON: synthetic-account-secret'),
  });
  const parsed = parseExport(archive, 'deepseek_data.zip');
  assert.equal(parsed.conversations[0]!.id, 'zip');
  assert.equal(new TextDecoder().decode(parsed.conversationsJson).includes('synthetic-account-secret'), false);
});

test('unselected user.json is not decompressed even when its declared expanded size is huge', () => {
  const archive = zipSync({
    'conversations.json': json([{ id: 'filtered', messages: [{ role: 'user', content: '合成例子' }] }]),
    'user.json': strToU8('account-data-is-not-an-import-input'),
  });
  const view = new DataView(archive.buffer);
  for (let index = 0; index < archive.length - 46; index++) {
    if (view.getUint32(index, true) !== 0x02014b50) continue;
    const nameLength = view.getUint16(index + 28, true);
    const name = new TextDecoder().decode(archive.subarray(index + 46, index + 46 + nameLength));
    if (name === 'user.json') view.setUint32(index + 24, 1024 * 1024 * 1024, true);
  }
  const parsed = parseExport(archive, 'data.zip');
  assert.equal(parsed.conversations[0]!.id, 'filtered');
});

test('ZIP path traversal, ambiguous conversations, corruption and malformed JSON are rejected', () => {
  const valid = json([{ id: 'ok', messages: [{ role: 'user', content: 'example' }] }]);
  assert.throws(() => parseExport(zipSync({ '../user.json': strToU8('{}'), 'conversations.json': valid }), 'data.zip'), /不安全/);
  assert.throws(() => parseExport(zipSync({ 'C:/user.json': strToU8('{}'), 'conversations.json': valid }), 'data.zip'), /不安全/);
  assert.throws(() => parseExport(zipSync({ 'conversations.json': valid, 'nested/conversations.json': valid }), 'data.zip'), /多个 conversations/);
  const archive = zipSync({ 'conversations.json': valid }, { level: 0 });
  assert.throws(() => parseExport(archive.subarray(0, archive.length - 8), 'data.zip'), /ZIP/);
  const corrupted = archive.slice();
  const view = new DataView(corrupted.buffer);
  const start = 30 + view.getUint16(26, true) + view.getUint16(28, true);
  corrupted[start + 1] ^= 1;
  assert.throws(() => parseExport(corrupted, 'data.zip'), /完整性校验/);
  assert.throws(() => parseExport(strToU8('{bad-json'), 'conversations.json'), /不是有效的 UTF-8 JSON/);
  assert.throws(() => parseExport(zipSync({ 'user.json': strToU8('{}') }), 'data.zip'), /未找到 conversations/);
  assert.throws(() => parseExport(strToU8('{"email":"synthetic"}'), 'user.json'), /请勿选择 user.json/);
});

test('ZIP selected entry size is checked before decompression', () => {
  const archive = zipSync({ 'conversations.json': strToU8('[]') });
  const view = new DataView(archive.buffer);
  let directory = -1;
  for (let index = 0; index < archive.length - 4; index++) if (view.getUint32(index, true) === 0x02014b50) { directory = index; break; }
  assert.ok(directory >= 0);
  view.setUint32(directory + 24, MAX_CONVERSATIONS_BYTES + 1, true);
  assert.throws(() => parseExport(archive, 'data.zip'), /128 MiB/);
  assert.equal(MAX_ARCHIVE_BYTES, 200 * 1024 * 1024);
});

test('many invalid conversations cannot expand into an unbounded warning report', () => {
  assert.throws(() => parseExport(json(Array(20_001).fill(null)), 'conversations.json'), /20,000 条会话/);
});
