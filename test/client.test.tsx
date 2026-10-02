import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Context } from '@deepseek-ai/cordis';
import {
  API_PREFIX, UPLOAD_API, PACKAGE_NAME, PANEL_ID, ConversationDetail, MigrationPage, apiRoute, apply,
  filterConversations, migrationApi, nativeNavigation, reportData,
  cleanupConfirmation, cleanupSessionIds,
} from '../src/client.js';
import type { MigrationApi } from '../src/client.js';
import { en, zh, type LocaleKey } from '../src/locales.js';
import type { CleanupTask, Conversation, ConversationSummary, ImportJob, ImportRequest, ImporterState, MetadataRepairState, UploadSummary } from '../src/types.js';

const translate = (key: LocaleKey) => zh[key];
const row = (id: string, title: string, createdAt: number, updatedAt: number): ConversationSummary => ({
  id, title, createdAt, updatedAt, messageCount: 2, branchCount: 1, attachmentCount: 0, warnings: [], imported: false,
});

test('chat search and both date orders preserve the source list', () => {
  const source = [row('a', 'Alpha 工作', 10, 30), row('b', 'Beta', 20, 10), row('c', 'ALPHA 生活', 30, 20)];
  assert.deepEqual(filterConversations(source, ' alpha ', 'newest').map(item => item.id), ['a', 'c']);
  assert.deepEqual(filterConversations(source, '', 'oldest').map(item => item.id), ['a', 'b', 'c']);
  assert.deepEqual(source.map(item => item.id), ['a', 'b', 'c']);
});

test('source HTML, reasoning, and filenames render only as escaped text', () => {
  const attack = '<img src=x onerror="alert(1)"><script>window.pwned=1</script>';
  const conversation: Conversation = {
    id: 'safe', title: attack, createdAt: 0, updatedAt: 0, attachmentCount: 1, warnings: [attack],
    branches: [{ id: 'branch', updatedAt: 0, messages: [{ id: 'm', role: 'assistant', text: attack,
      reasoning: attack, timestamp: 0, attachments: [{ name: attack, available: false }], citations: [] }] }],
  };
  const html = renderToStaticMarkup(<ConversationDetail conversation={conversation} t={translate} onClose={() => {}} />);
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('&lt;img'));
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<img src=x'));
  assert.ok(html.includes(zh.reasoning));
  assert.ok(html.includes(zh.attachmentNotice));
});

test('migration UI is local-file-first and the import action starts disabled', () => {
  const html = renderToStaticMarkup(<MigrationPage native={{ currentWorkspace: () => undefined, openSession() {}, async refreshSessions() {} }} />);
  assert.ok(html.includes(zh.choose));
  assert.ok(html.includes('accept=".zip,.json,application/zip,application/json"'));
  assert.ok(html.includes(zh.privacy));
  assert.ok(!html.includes('type="password"'));
});

test('report explicitly excludes arbitrary source messages and user.json', () => {
  const job = {
    id: 'job', status: 'completed', total: 1, processed: 1, imported: 1, skipped: 0, failed: 0,
    currentTitle: '', startedAt: 1, request: { workspaceId: 'workspace', conversationIds: ['chat'], branchMode: 'all', includeReasoning: false },
    results: [{ sourceId: 'chat', branchId: 'branch', sessionId: 'session', workspaceId: 'workspace', title: 'Synthetic test', messageCount: 2, status: 'imported', text: 'PRIVATE_MESSAGE', user: 'PRIVATE_USER' }],
    source: { 'user.json': 'PRIVATE_ACCOUNT' },
  } as unknown as ImportJob;
  const json = JSON.stringify(reportData(job));
  assert.ok(json.includes('session'));
  for (const secret of ['PRIVATE_MESSAGE', 'PRIVATE_USER', 'PRIVATE_ACCOUNT', 'user.json']) assert.ok(!json.includes(secret));
});

test('fixed Connection Fetch route retains logical path and tunnels DELETE', async () => {
  assert.equal(new URL(apiRoute('/uploads/chat 1'), 'http://localhost').searchParams.get('route'), '/uploads/chat 1');
  assert.equal(new URL(apiRoute('/state'), 'http://localhost').pathname, API_PREFIX);
  assert.equal(new URL(apiRoute('/uploads', 'POST'), 'http://localhost').pathname, UPLOAD_API);
  assert.equal(new URL(apiRoute('/uploads', 'GET'), 'http://localhost').pathname, API_PREFIX);
  assert.equal(new URL(apiRoute('/uploads/chat/jobs', 'POST'), 'http://localhost').pathname, API_PREFIX);
  const original = globalThis.fetch;
  let input: string | URL | Request | undefined;
  let options: RequestInit | undefined;
  globalThis.fetch = async (url, init) => { input = url; options = init; return Response.json({ deleted: true }); };
  try {
    assert.deepEqual(await migrationApi.request('/uploads/id', { method: 'DELETE' }), { deleted: true });
    const url = new URL(String(input), 'http://localhost');
    assert.equal(url.pathname, API_PREFIX);
    assert.equal(url.searchParams.get('method'), 'DELETE');
    assert.equal(url.searchParams.get('route'), '/uploads/id');
    assert.equal(options?.method, 'POST');
    assert.equal(options?.credentials, 'same-origin');
  } finally { globalThis.fetch = original; }
});

test('backend business errors remain visible and do not become success responses', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ error: 'Unsupported export schema' }, { status: 422 });
  try { await assert.rejects(migrationApi.request('/state'), /Unsupported export schema/); }
  finally { globalThis.fetch = original; }
});

test('upload transport encodes filenames, carries raw bytes, reports progress, and aborts', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'XMLHttpRequest');
  const requests: FakeXHR[] = [];
  class FakeXHR {
    method = ''; url = ''; withCredentials = false; responseType = ''; status = 0; response: unknown; sent: unknown;
    headers: Record<string, string> = {};
    upload = { onprogress: null as ((event: ProgressEvent) => void) | null };
    onload: (() => void) | null = null; onerror: (() => void) | null = null; onabort: (() => void) | null = null;
    constructor() { requests.push(this); }
    open(method: string, url: string) { this.method = method; this.url = url; }
    setRequestHeader(key: string, value: string) { this.headers[key] = value; }
    send(body: unknown) { this.sent = body; }
    abort() { this.onabort?.(); }
  }
  Object.defineProperty(globalThis, 'XMLHttpRequest', { configurable: true, writable: true, value: FakeXHR });
  try {
    const file = { name: '官网导出 #1.zip', size: 20 } as File;
    let progress = 0;
    const result = migrationApi.upload(file, value => { progress = value; }, new AbortController().signal);
    const xhr = requests[0]!;
    assert.equal(xhr.method, 'POST');
    assert.equal(new URL(xhr.url, 'http://localhost').pathname, UPLOAD_API);
    assert.equal(new URL(xhr.url, 'http://localhost').searchParams.get('route'), '/uploads');
    assert.equal(xhr.headers['X-File-Name'], encodeURIComponent(file.name));
    assert.equal(xhr.headers['Content-Type'], 'application/octet-stream');
    assert.equal(xhr.withCredentials, true);
    assert.equal(xhr.sent, file);
    xhr.upload.onprogress!({ lengthComputable: true, loaded: 5, total: 20 } as ProgressEvent);
    assert.equal(progress, 25);
    const summary = { id: 'upload', filename: file.name, conversationCount: 1, branchCount: 1, messageCount: 2, warnings: [] };
    xhr.status = 200; xhr.response = summary; xhr.onload!();
    assert.deepEqual(await result, summary);
    const abort = new AbortController();
    const cancelled = migrationApi.upload(file, () => {}, abort.signal);
    abort.abort();
    await assert.rejects(cancelled, error => error instanceof DOMException && error.name === 'AbortError');
  } finally {
    if (original) Object.defineProperty(globalThis, 'XMLHttpRequest', original);
    else Reflect.deleteProperty(globalThis, 'XMLHttpRequest');
  }
});

test('current destination and Continue chat use public Harness providers', async () => {
  let opened: string | undefined;
  let refreshed = false;
  const ctx = {
    sessions: {
      list: { getSnapshot: () => ({ ids: ['background', 'current'] }) },
      retainInfo: (id: string) => ({ getSnapshot: () => ({ retainedBy: { mainView: id === 'current' ? 1 : 0 } }) }),
      refresh: async () => { refreshed = true; },
    },
    workspaces: { list: { getSnapshot: () => ({ items: [{ workspaceId: 'first', sessionIds: ['background'] }, { workspaceId: 'active', sessionIds: ['current'] }] }) } },
    uiWorkspace: { openSession: (id: string) => { opened = id; } },
  } as unknown as Context;
  const navigation = nativeNavigation(ctx);
  assert.equal(navigation.currentWorkspace(), 'active');
  navigation.openSession('imported');
  assert.equal(opened, 'imported');
  await navigation.refreshSessions();
  assert.equal(refreshed, true);
});

test('plugin registers actual sidebar, global page, config, and activation slots with lifecycle cleanup', () => {
  const originalDocument = globalThis.document;
  const registrations: { name: string; id?: string; key?: string; locale?: string }[] = [];
  const cleanup: (() => void)[] = [];
  let stylesRemoved = 0;
  let dictionariesRemoved = 0;
  let selectedPanel: string | undefined;
  const style = { dataset: {}, textContent: '', remove: () => { stylesRemoved++; } };
  globalThis.document = { createElement: () => style, head: { append() {} } } as unknown as Document;
  const ctx = {
    effect: (factory: () => (() => void) | undefined) => { const dispose = factory(); if (dispose) cleanup.push(dispose); },
    locale: { register: () => () => { dictionariesRemoved++; }, bind: () => translate },
    slots: {
      inject: (_name: string, callback: () => unknown) => callback(),
      register: (options: { name: string; id?: string; key?: string; locale?: string }) => { registrations.push(options); return () => {}; },
    },
    layout: { selectPanel: (id: string) => { selectedPanel = id; } },
  } as unknown as Context;
  try {
    apply(ctx);
    assert.deepEqual(registrations.map(item => item.name), ['main', 'sidebar.panellist', 'plugins.bundle.config', 'plugins.bundle.activation']);
    assert.equal(registrations[0]?.key, PANEL_ID);
    assert.equal(registrations[1]?.id, PANEL_ID);
    assert.equal(registrations[2]?.key, PACKAGE_NAME);
    assert.equal(registrations[3]?.key, PACKAGE_NAME);
    assert.equal(selectedPanel, undefined, 'loading the plugin must not unexpectedly navigate');
    assert.ok(style.textContent.includes('.dcm'));
    cleanup.forEach(dispose => dispose());
    assert.equal(stylesRemoved, 1);
    assert.equal(dictionariesRemoved, 1);
  } finally { globalThis.document = originalDocument; }
});

test('all visible copy has both Chinese and English keys', () => {
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort());
});

test('file upload, preview selection, stop/retry, and Continue chat work through the UI', async () => {
  const { JSDOM } = createRequire(import.meta.url)('jsdom');
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' });
  const globals: Record<string, unknown> = { window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node,
    MutationObserver: dom.window.MutationObserver, File: dom.window.File, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = Object.fromEntries(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { render, fireEvent, waitFor, cleanup } = await import('@testing-library/react');
  const upload: UploadSummary = { id: 'export', filename: 'synthetic-export.zip', conversationCount: 2, branchCount: 2, messageCount: 4, warnings: [] };
  const summaries = [{ ...row('alpha', 'Alpha synthetic', 10, 20), imported: true }, row('beta', 'Beta synthetic', 20, 30)];
  const request: ImportRequest = { workspaceId: 'active', conversationIds: ['beta'], branchMode: 'all', includeReasoning: false };
  const started: ImportJob = { id: 'job', status: 'running', total: 1, processed: 0, imported: 0, skipped: 0, failed: 0, currentTitle: 'Beta synthetic', startedAt: 1, results: [], request };
  const finished: ImportJob = { ...started, status: 'completed', processed: 1, imported: 1,
    results: [{ sourceId: 'beta', branchId: 'branch', sessionId: 'native-session', workspaceId: 'active', title: 'Beta synthetic', messageCount: 2, status: 'imported' }] };
  const cancelled: ImportJob = { ...started, status: 'cancelled', currentTitle: '' };
  let uploaded = false, completed = false, submitted: ImportRequest | undefined, opened: string | undefined, refreshed = 0;
  let completeUpload: ((result: UploadSummary) => void) | undefined;
  const state = (): ImporterState => ({ version: 'test', compatible: true,
    workspaces: [{ id: 'first', title: 'First workspace', path: '/synthetic/first' }, { id: 'active', title: 'Current workspace', path: '/synthetic/current' }],
    uploads: uploaded ? [upload] : [], jobs: [] });
  const api: MigrationApi = {
    async request<T>(path: string, options?: RequestInit): Promise<T> {
      let value: unknown;
      if (path === '/state') value = state();
      else if (path === '/uploads/export') value = { upload, conversations: summaries.map(item => ({ ...item, imported: item.imported || completed && item.id === 'beta' })) };
      else if (path === '/uploads/export/conversations/beta') value = { id: 'beta', title: 'Beta synthetic', createdAt: 20, updatedAt: 30, attachmentCount: 0, warnings: [],
        branches: [{ id: 'branch', updatedAt: 30, messages: [{ id: 'message', role: 'assistant', text: '<script>synthetic attack</script>', reasoning: 'Synthetic reasoning', timestamp: 30, attachments: [], citations: [] }] }] } satisfies Conversation;
      else if (path === '/uploads/export/jobs') { submitted = JSON.parse(String(options?.body)) as ImportRequest; value = started; }
      else if (path === '/jobs/job') value = started;
      else if (path === '/jobs/job/cancel') { assert.equal(options?.method, 'POST'); value = cancelled; }
      else if (path === '/jobs/job/retry') { assert.equal(options?.method, 'POST'); value = { ...started, id: 'job-retry' }; }
      else if (path === '/jobs/job-retry') { completed = true; value = { ...finished, id: 'job-retry' }; }
      else throw new Error(`Unexpected test route ${path}`);
      return value as T;
    },
    upload(file, onProgress) {
      assert.equal(file.name, upload.filename); uploaded = true; onProgress(50);
      return new Promise(resolve => { completeUpload = resolve; });
    },
  };
  try {
    const view = render(<MigrationPage api={api} native={{ currentWorkspace: () => 'active', openSession: id => { opened = id; }, async refreshSessions() { refreshed++; } }} />);
    await waitFor(() => assert.ok(!view.queryByText(zh.loading)));
    const fileInput = view.container.querySelector<HTMLInputElement>('input[type=file]')!;
    fireEvent.change(fileInput, { target: { files: [new dom.window.File(['synthetic ZIP bytes'], upload.filename, { type: 'application/zip' })] } });
    await waitFor(() => assert.equal(view.getByRole('progressbar', { name: zh.uploading }).getAttribute('value'), '50'));
    completeUpload!(upload);
    await view.findByRole('heading', { name: zh.preview });
    await waitFor(() => assert.equal((view.getByRole('combobox', { name: zh.workspace }) as HTMLSelectElement).value, 'active'));
    assert.equal((view.getByRole('checkbox', { name: 'Alpha synthetic' }) as HTMLInputElement).checked, true, 'previous imports must remain selected to import additional branches');
    assert.ok(view.container.textContent?.includes(zh.previouslyImported));
    fireEvent.click(view.getByRole('button', { name: zh.clearVisible }));
    fireEvent.change(view.getByRole('searchbox', { name: zh.search }), { target: { value: 'beta' } });
    assert.ok(!view.queryByRole('checkbox', { name: 'Alpha synthetic' }));
    fireEvent.click(view.getByRole('button', { name: zh.selectVisible }));
    assert.equal((view.getByRole('checkbox', { name: 'Beta synthetic' }) as HTMLInputElement).checked, true);
    fireEvent.click(view.getByRole('button', { name: zh.viewConversation }));
    const preview = await view.findByRole('dialog', { name: zh.detail });
    assert.ok(preview.textContent?.includes('<script>synthetic attack</script>'));
    assert.equal(preview.querySelectorAll('script').length, 0);
    fireEvent.click(view.getByRole('button', { name: zh.close }));
    await waitFor(() => assert.ok(!view.queryByRole('dialog')));
    fireEvent.click(view.getByRole('button', { name: `${zh.import} (1)` }));
    const stop = await view.findByRole('button', { name: zh.cancelJob });
    fireEvent.click(stop);
    await view.findByRole('heading', { name: zh.cancelled });
    await waitFor(() => assert.equal(refreshed, 1));
    fireEvent.click(view.getByRole('button', { name: zh.retryJob }));
    await view.findByRole('heading', { name: zh.completed });
    assert.deepEqual(submitted, request);
    await waitFor(() => assert.equal(refreshed, 2));
    fireEvent.click(view.getByRole('button', { name: zh.continueChat }));
    assert.equal(opened, 'native-session');
    assert.ok(view.getByRole('button', { name: zh.report }));
  } finally {
    cleanup(); dom.window.close();
    for (const key of Object.keys(globals)) {
      const descriptor = previous[key];
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

async function browserTest() {
  const { JSDOM } = createRequire(import.meta.url)('jsdom');
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' });
  const globals: Record<string, unknown> = { window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node,
    MutationObserver: dom.window.MutationObserver, File: dom.window.File, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = Object.fromEntries(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const library = await import('@testing-library/react');
  return { ...library, restore() {
    library.cleanup(); dom.window.close();
    for (const key of Object.keys(globals)) {
      const descriptor = previous[key];
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  } };
}

test('automatic title repair polls state, blocks import, refreshes once, and retries without uploading', async () => {
  const { render, fireEvent, waitFor, restore } = await browserTest();
  const initial: MetadataRepairState = { status: 'running', total: 2, processed: 0, repaired: 0, missing: 0, failed: 0, errors: [], startedAt: 100 };
  const failed: MetadataRepairState = { ...initial, status: 'completed', processed: 2, repaired: 1, failed: 1, finishedAt: 110,
    errors: [{ sessionId: 'synthetic-failed', error: 'Synthetic repair error' }] };
  const complete: MetadataRepairState = { ...initial, status: 'completed', processed: 2, repaired: 2, failed: 0, startedAt: 200, finishedAt: 210 };
  const upload: UploadSummary = { id: 'old-export', filename: 'synthetic-old.zip', conversationCount: 1, branchCount: 1, messageCount: 2, warnings: [] };
  let reads = 0, refreshed = 0, posted = 0;
  const state = (): ImporterState => ({ version: '1.0.1', compatible: true, workspaces: [{ id: 'workspace', title: 'Synthetic workspace', path: '/synthetic' }], uploads: [upload], jobs: [],
    metadataRepair: posted ? complete : reads === 1 ? initial : reads === 2 ? { ...initial, processed: 1, repaired: 1 } : failed });
  const api: MigrationApi = {
    async request<T>(path: string, options?: RequestInit): Promise<T> {
      if (path === '/state') { reads++; return state() as T; }
      if (path === '/uploads/old-export') return { upload, conversations: [{ ...row('chat', 'Synthetic imported chat', 1, 2), imported: true }] } as T;
      if (path === '/metadata/repair') {
        assert.equal(options?.method, 'POST');
        assert.equal(new Headers(options?.headers).get('Content-Type'), 'application/json');
        posted++; return { ...initial, startedAt: 200 } as T;
      }
      throw new Error(`Unexpected repair test route ${path}`);
    },
    async upload() { throw new Error('Repair must never re-upload an export'); },
  };
  try {
    const view = render(<MigrationPage api={api} native={{ currentWorkspace: () => 'workspace', openSession() { throw new Error('Repair must not open each session'); }, async refreshSessions() { refreshed++; } }} />);
    await view.findByText(`${zh.repairingTitles} · 0 / 2`);
    assert.equal((view.getByRole('button', { name: zh.repairTitles }) as HTMLButtonElement).disabled, true);
    const importButton = await view.findByRole('button', { name: `${zh.import} (1)` });
    assert.equal((importButton as HTMLButtonElement).disabled, true);
    await waitFor(() => assert.ok(view.queryByText(`${zh.repairingTitles} · 1 / 2`)), { timeout: 1800 });
    await waitFor(() => assert.ok(view.queryByText(`${zh.repairTitlesFailed} (1)`)), { timeout: 1800 });
    await waitFor(() => assert.equal(refreshed, 1));
    assert.equal((view.getByRole('button', { name: `${zh.import} (1)` }) as HTMLButtonElement).disabled, false);
    const beforeRefresh = reads;
    fireEvent.click(view.getByRole('button', { name: zh.refresh }));
    await waitFor(() => assert.ok(reads > beforeRefresh));
    assert.equal(refreshed, 1, 're-reading the same repair must not refresh native sessions again');
    fireEvent.click(view.getByRole('button', { name: zh.repairTitlesRetry }));
    await waitFor(() => assert.equal(posted, 1));
    await waitFor(() => assert.equal(refreshed, 2));
    assert.ok(view.queryByText(`${zh.repairedTitles} · 2 / 2`));
    assert.ok(!view.queryByText(`${zh.repairTitlesFailed} (1)`));
  } finally { restore(); }
});

test('title repair is hidden without records and unavailable while a native import is running', async () => {
  const { render, waitFor, restore } = await browserTest();
  const request: ImportRequest = { workspaceId: 'workspace', conversationIds: ['chat'], branchMode: 'all', includeReasoning: false };
  const running: ImportJob = { id: 'active', status: 'running', total: 2, processed: 1, imported: 1, skipped: 0, failed: 0, currentTitle: 'Synthetic chat', startedAt: 1, results: [], request };
  const base: ImporterState = { version: '1.0.1', compatible: true, workspaces: [], uploads: [], jobs: [],
    metadataRepair: { status: 'completed', total: 0, processed: 0, repaired: 0, missing: 0, failed: 0, errors: [], startedAt: 1, finishedAt: 2 } };
  let active = false;
  const api: MigrationApi = {
    async request<T>(path: string): Promise<T> {
      if (path === '/state') return { ...base, jobs: active ? [running] : [] } as T;
      if (path === '/jobs/active') return running as T;
      throw new Error(`Unexpected disabled repair test route ${path}`);
    },
    async upload() { throw new Error('Not used'); },
  };
  const native = { currentWorkspace: () => undefined, openSession() {}, async refreshSessions() {} };
  try {
    const empty = render(<MigrationPage api={api} native={native} />);
    await waitFor(() => assert.ok(!empty.queryByText(zh.loading)));
    assert.ok(!empty.queryByRole('button', { name: zh.repairTitles }));
    empty.unmount();
    active = true;
    const importing = render(<MigrationPage api={api} native={native} />);
    const button = await importing.findByRole('button', { name: zh.repairTitles });
    assert.equal((button as HTMLButtonElement).disabled, true);
    assert.ok(importing.getByRole('button', { name: zh.cancelJob }));
  } finally { restore(); }
});

const cleanupFixture = () => {
  const upload: UploadSummary = { id: 'cleanup-export', filename: 'synthetic-cleanup.zip', conversationCount: 1, branchCount: 2, messageCount: 4, warnings: [] };
  const job: ImportJob = { id: 'scope/job', status: 'completed', total: 4, processed: 4, imported: 2, skipped: 1, failed: 1, currentTitle: '', startedAt: 1,
    request: { workspaceId: 'workspace', conversationIds: ['source'], branchMode: 'all', includeReasoning: false },
    results: [
      { sourceId: 'source', branchId: 'first', sessionId: 'native-1', workspaceId: 'workspace', title: 'Synthetic first', messageCount: 2, status: 'imported' },
      { sourceId: 'source', branchId: 'second', sessionId: 'native-2', workspaceId: 'workspace', title: 'Synthetic second', messageCount: 2, status: 'imported' },
      { sourceId: 'source', branchId: 'repeat', sessionId: 'native-1', workspaceId: 'workspace', title: 'Synthetic duplicate result', messageCount: 2, status: 'skipped' },
      { sourceId: 'source', branchId: 'failed', sessionId: 'not-created', workspaceId: 'workspace', title: 'Synthetic failed import', messageCount: 0, status: 'failed', error: 'Synthetic import failure' },
    ] };
  const base: ImporterState = { version: '1.0.2', compatible: true,
    workspaces: [{ id: 'workspace', title: 'Synthetic workspace', path: '/synthetic' }], uploads: [upload], jobs: [job] };
  const preview = { upload, conversations: [{ ...row('source', 'Synthetic source', 1, 2), branchCount: 2, imported: true }] };
  const task: CleanupTask = { id: 'cleanup', jobId: job.id, mode: 'sessions-and-records', status: 'running', total: 2, processed: 0, deleted: 0, missing: 0, failed: 0, results: [], recordsCleared: false, startedAt: 100 };
  return { upload, job, base, preview, task };
};

test('cleanup confirmations count unique successful IDs and cancel both scopes without a POST', async () => {
  const { render, fireEvent, waitFor, restore } = await browserTest();
  const { job, base, preview } = cleanupFixture();
  const confirmations: string[] = []; let posts = 0;
  window.confirm = (text = '') => { confirmations.push(text); return false; };
  const api: MigrationApi = {
    async request<T>(path: string, options?: RequestInit): Promise<T> {
      if (options?.method === 'POST') posts++;
      if (path === '/state') return base as T;
      if (path === '/uploads/cleanup-export') return preview as T;
      throw new Error(`Unexpected cancellation test route ${path}`);
    },
    async upload() { throw new Error('Not used'); },
  };
  try {
    assert.deepEqual(cleanupSessionIds(job), ['native-1', 'native-2']);
    assert.ok(cleanupConfirmation(job, 'sessions-and-records', translate).includes('2 条'));
    const view = render(<MigrationPage api={api} native={{ currentWorkspace: () => 'workspace', openSession() {}, async refreshSessions() {} }} />);
    await view.findByRole('button', { name: zh.clearRecords });
    await waitFor(() => assert.equal((view.getByRole('button', { name: zh.clearRecords }) as HTMLButtonElement).disabled, false));
    fireEvent.click(view.getByRole('button', { name: zh.clearRecords }));
    fireEvent.click(view.getByRole('button', { name: zh.deleteImportedSessions }));
    assert.equal(posts, 0);
    assert.equal(confirmations.length, 2);
    assert.ok(confirmations[0]!.includes('去重记录和本机上传暂存都会保留'));
    assert.ok(confirmations[1]!.includes('2 条已导入原生会话'));
    assert.ok(confirmations[1]!.includes('继续聊天的内容和修改的标题'));
    assert.ok(confirmations[1]!.includes('无法恢复'));
    assert.ok(view.getByRole('region', { name: zh.resultSessions }));
  } finally { restore(); }
});

test('record-only cleanup posts only the selected job scope and keeps sessions and the upload', async () => {
  const { render, fireEvent, waitFor, restore } = await browserTest();
  const { job, base, preview, task } = cleanupFixture();
  const working: CleanupTask = { ...task, mode: 'records', total: 0 };
  const complete: CleanupTask = { ...working, status: 'completed', recordsCleared: true, finishedAt: 120 };
  let phase = 'idle', phaseReads = 0, refreshed = 0;
  const submitted: Array<{ path: string; body: unknown }> = [];
  window.confirm = () => true;
  const api: MigrationApi = {
    async request<T>(path: string, options?: RequestInit): Promise<T> {
      if (path === '/state') {
        if (phase === 'working' && ++phaseReads > 1) phase = 'complete';
        return { ...base, jobs: phase === 'complete' ? [] : [job], cleanup: phase === 'idle' ? undefined : phase === 'complete' ? complete : working } as T;
      }
      if (path === '/uploads/cleanup-export') return preview as T;
      if (path === '/jobs/scope%2Fjob/clear') {
        assert.equal(options?.method, 'POST'); submitted.push({ path, body: JSON.parse(String(options?.body)) });
        phase = 'working'; return working as T;
      }
      throw new Error(`Unexpected record cleanup route ${path}`);
    },
    async upload() { throw new Error('Record cleanup must not upload'); },
  };
  try {
    const view = render(<MigrationPage api={api} native={{ currentWorkspace: () => 'workspace', openSession() {}, async refreshSessions() { refreshed++; } }} />);
    await view.findByRole('button', { name: zh.clearRecords });
    await waitFor(() => assert.equal(refreshed, 1));
    fireEvent.click(view.getByRole('button', { name: zh.clearRecords }));
    await view.findByRole('heading', { name: zh.clearingRecords });
    assert.deepEqual(submitted, [{ path: '/jobs/scope%2Fjob/clear', body: { mode: 'records' } }]);
    await view.findByRole('heading', { name: zh.cleanupCompleted }, { timeout: 1800 });
    await waitFor(() => assert.ok(!view.queryByRole('region', { name: zh.resultSessions })));
    assert.ok(view.getByRole('heading', { name: zh.preview }));
    assert.ok(view.getByRole('button', { name: zh.removeUpload }));
    assert.ok(!view.getByRole('region', { name: zh.cleanupSummary }).textContent?.includes('0 / 0'));
    assert.equal(refreshed, 2, 'completion refreshes native sessions once');
    fireEvent.click(view.getByRole('button', { name: zh.refresh }));
    await waitFor(() => assert.equal((view.getByRole('button', { name: zh.refresh }) as HTMLButtonElement).disabled, false));
    assert.equal(refreshed, 2);
  } finally { restore(); }
});

test('session cleanup blocks conflicts, hides deleted Continue actions, retries failures, and clears stale results', async () => {
  const { render, fireEvent, waitFor, restore } = await browserTest();
  const { job, base, preview, task } = cleanupFixture();
  const partial: CleanupTask = { ...task, status: 'completed', processed: 2, deleted: 1, failed: 1, finishedAt: 120,
    results: [{ sessionId: 'native-1', status: 'deleted' }, { sessionId: 'native-2', status: 'failed', error: 'Synthetic session is still active' }] };
  const working: CleanupTask = { ...task, processed: 1, deleted: 1, results: [{ sessionId: 'native-1', status: 'deleted' }] };
  const complete: CleanupTask = { ...working, status: 'completed', processed: 2, deleted: 1, recordsCleared: true, finishedAt: 220,
    results: [{ sessionId: 'native-1', status: 'deleted' }, { sessionId: 'native-2', status: 'missing' }], missing: 1 };
  let phase = 'idle', phaseReads = 0, refreshed = 0, confirms = 0;
  const submitted: unknown[] = [];
  window.confirm = (text = '') => { confirms++; assert.ok(text.includes('2 条')); assert.ok(text.includes('继续聊天')); return true; };
  const api: MigrationApi = {
    async request<T>(path: string, options?: RequestInit): Promise<T> {
      if (path === '/state') {
        if (phase === 'working' && ++phaseReads > 1) phase = 'partial';
        if (phase === 'retrying' && ++phaseReads > 1) phase = 'complete';
        return { ...base, jobs: phase === 'complete' ? [] : [job], uploads: phase === 'complete' ? [] : base.uploads,
          cleanup: phase === 'idle' ? undefined : phase === 'partial' ? partial : phase === 'complete' ? complete : working } as T;
      }
      if (path === '/uploads/cleanup-export') return preview as T;
      if (path === '/jobs/scope%2Fjob/clear') {
        assert.equal(options?.method, 'POST'); submitted.push(JSON.parse(String(options?.body)));
        phase = phase === 'idle' ? 'working' : 'retrying'; phaseReads = 0; return working as T;
      }
      throw new Error(`Unexpected session cleanup route ${path}`);
    },
    async upload() { throw new Error('Cleanup must not re-upload'); },
  };
  try {
    const view = render(<MigrationPage api={api} native={{ currentWorkspace: () => 'workspace', openSession() {}, async refreshSessions() { refreshed++; } }} />);
    await view.findByRole('button', { name: zh.deleteImportedSessions });
    await waitFor(() => assert.equal(refreshed, 1));
    fireEvent.click(view.getByRole('button', { name: zh.deleteImportedSessions }));
    await view.findByRole('heading', { name: zh.deletingImportedSessions });
    for (const name of [zh.clearRecords, zh.deleteImportedSessions, zh.removeUpload, zh.repairTitles, zh.retryJob, `${zh.import} (1)`]) {
      assert.equal((view.getByRole('button', { name }) as HTMLButtonElement).disabled, true, name);
    }
    const firstRow = [...view.container.querySelectorAll('.dcm-result')].find(item => item.textContent?.includes('Synthetic first'))!;
    assert.ok(firstRow.textContent?.includes(zh.cleanupDeleted));
    assert.equal(firstRow.querySelectorAll('button').length, 0);
    await view.findByRole('button', { name: zh.cleanupRetry }, { timeout: 1800 });
    await waitFor(() => assert.equal(refreshed, 2));
    assert.equal(view.getAllByRole('button', { name: zh.continueChat }).length, 1);
    assert.ok(view.container.textContent?.includes(zh.cleanupRetryHint));
    assert.ok(view.container.textContent?.includes('Synthetic session is still active'));
    fireEvent.click(view.getByRole('button', { name: zh.cleanupRetry }));
    await view.findByRole('heading', { name: zh.deletingImportedSessions });
    assert.deepEqual(submitted, [{ mode: 'sessions-and-records' }, { mode: 'sessions-and-records' }]);
    assert.equal(confirms, 2, 'retry must also ask for destructive confirmation');
    await view.findByRole('heading', { name: zh.cleanupCompleted }, { timeout: 1800 });
    await waitFor(() => assert.ok(!view.queryByRole('region', { name: zh.resultSessions })));
    assert.ok(!view.queryByRole('heading', { name: zh.preview }));
    assert.ok(!view.queryByRole('button', { name: zh.removeUpload }));
    assert.ok(!view.queryByRole('button', { name: zh.continueChat }));
    assert.equal(refreshed, 3, 'each finished attempt refreshes once, including a retry with the same task ID');
    fireEvent.click(view.getByRole('button', { name: zh.refresh }));
    await waitFor(() => assert.equal((view.getByRole('button', { name: zh.refresh }) as HTMLButtonElement).disabled, false));
    assert.equal(refreshed, 3);
  } finally { restore(); }
});

test('pending deleted work blocks other batches but keeps repair, upload, and the original cleanup retry available', async () => {
  const { render, fireEvent, waitFor, restore } = await browserTest();
  const { job, base, preview, task } = cleanupFixture();
  const other: ImportJob = { ...job, id: 'other-job', startedAt: 10 };
  const pending: CleanupTask = { ...task, status: 'completed', processed: 2, deleted: 1, failed: 1, finishedAt: 120,
    results: [{ sessionId: 'native-1', status: 'deleted' }, { sessionId: 'native-2', status: 'failed', error: 'Synthetic active session' }] };
  const newUpload: UploadSummary = { ...preview.upload, id: 'new-export', filename: 'synthetic-new.json' };
  let uploaded = false, startedRetry = false;
  const posts: Array<{ path: string; body: unknown }> = [];
  window.confirm = () => true;
  const api: MigrationApi = {
    async request<T>(path: string, options?: RequestInit): Promise<T> {
      if (path === '/state') return { ...base, jobs: [job, other], uploads: uploaded ? [preview.upload, newUpload] : base.uploads,
        cleanup: startedRetry ? { ...pending, status: 'running', failed: 0, results: [pending.results[0]], processed: 1 } : pending } as T;
      if (path === '/uploads/cleanup-export') return preview as T;
      if (path === '/uploads/new-export') return { ...preview, upload: newUpload } as T;
      if (options?.method === 'POST') {
        posts.push({ path, body: JSON.parse(String(options.body)) });
        assert.equal(path, '/jobs/scope%2Fjob/clear');
        startedRetry = true;
        return { ...pending, status: 'running', failed: 0, results: [pending.results[0]], processed: 1 } as T;
      }
      throw new Error(`Unexpected pending cleanup route ${path}`);
    },
    async upload(_file, onProgress) { uploaded = true; onProgress(100); return newUpload; },
  };
  try {
    const view = render(<MigrationPage api={api} native={{ currentWorkspace: () => 'workspace', openSession() {}, async refreshSessions() {} }} />);
    await view.findByText(zh.cleanupPending);
    await waitFor(() => assert.ok(view.queryByRole('button', { name: `${zh.import} (1)` })));
    for (const name of [zh.clearRecords, zh.deleteImportedSessions, zh.retryJob, `${zh.import} (1)`]) {
      const button = view.getByRole('button', { name }) as HTMLButtonElement;
      assert.equal(button.disabled, true, name); fireEvent.click(button);
    }
    assert.equal(posts.length, 0);
    assert.equal((view.getByRole('button', { name: zh.repairTitles }) as HTMLButtonElement).disabled, false);
    assert.equal((view.getByRole('button', { name: zh.newExport }) as HTMLButtonElement).disabled, false);
    const fileInput = view.container.querySelector<HTMLInputElement>('input[type=file]')!;
    fireEvent.change(fileInput, { target: { files: [new File(['{}'], newUpload.filename, { type: 'application/json' })] } });
    await waitFor(() => assert.equal(fileInput.value, ''));
    await waitFor(() => assert.ok(!view.queryByRole('region', { name: zh.resultSessions })));
    await waitFor(() => assert.equal((view.getByRole('button', { name: zh.cleanupRetry }) as HTMLButtonElement).disabled, false));
    assert.equal((view.getByRole('button', { name: `${zh.import} (1)` }) as HTMLButtonElement).disabled, true);
    fireEvent.click(view.getByRole('button', { name: zh.cleanupRetry }));
    await view.findByRole('heading', { name: zh.deletingImportedSessions });
    assert.deepEqual(posts, [{ path: '/jobs/scope%2Fjob/clear', body: { mode: 'sessions-and-records' } }]);
  } finally { restore(); }
});
