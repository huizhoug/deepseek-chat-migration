import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Context } from '@deepseek-ai/cordis';
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client';
import type { SessionId } from '@deepseek-ai/dsh-session/types';
import type {} from '@deepseek-ai/dsh-client-locale/client';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client';
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client';
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client';
import type {} from '@deepseek-ai/dsh-api-session-controller/client';
import type { PluginActivationOwnerProps, PluginConfigViewProps } from '@deepseek-ai/dsh-client-ui-plugin-manager/client';
import type { CleanupMode, CleanupTask, Conversation, ConversationSummary, ImportJob, ImportRequest, ImporterState, MetadataRepairState, UploadSummary } from './types.js';
import { en, zh, type LocaleKey, type Translate } from './locales.js';
import styles from './client.css';
export { reportData } from './report.js';

export const PANEL_ID = 'deepseek-chat-migration' as MainPanelId;
export const PACKAGE_NAME = 'deepseek-chat-migration';
export const API_PREFIX = '/api/deepseek-chat-migration';
export const UPLOAD_API = '/api/deepseek-chat-migration.upload';
export const NS = 'deepseekChatMigration';
export const inject = ['slots', 'locale', 'layout', 'uiWorkspace', 'workspaces', 'sessions'];

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { deepseekChatMigration: LocaleKey }
}

export interface NativeNavigation {
  currentWorkspace(): string | undefined;
  openSession(sessionId: string): void;
  refreshSessions(): Promise<void>;
}
export interface MigrationApi {
  request<T>(path: string, options?: RequestInit): Promise<T>;
  upload(file: File, onProgress: (percent: number) => void, signal: AbortSignal): Promise<UploadSummary>;
}

export function apiRoute(path: string, method = 'GET'): string {
  const params = new URLSearchParams({ route: path });
  if (method === 'DELETE') params.set('method', 'DELETE');
  return `${path === '/uploads' && method === 'POST' ? UPLOAD_API : API_PREFIX}?${params}`;
}

/** Fetch uses the same authenticated origin as the Harness application. */
export const migrationApi: MigrationApi = {
  async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const method = options.method || 'GET';
    const response = await fetch(apiRoute(path, method), { credentials: 'same-origin', ...options, method: method === 'DELETE' ? 'POST' : method });
    const data = await response.json() as T & { error?: string };
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  },
  upload(file, onProgress, signal) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', apiRoute('/uploads', 'POST'));
      xhr.withCredentials = true;
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name));
      xhr.responseType = 'json';
      xhr.upload.onprogress = event => { if (event.lengthComputable) onProgress(Math.round(event.loaded / event.total * 100)); };
      const abort = () => { xhr.abort(); };
      const clean = () => { signal.removeEventListener('abort', abort); };
      xhr.onload = () => {
        clean();
        const data = xhr.response as UploadSummary & { error?: string } | null;
        if (xhr.status >= 200 && xhr.status < 300 && data) resolve(data);
        else reject(new Error(data?.error || `HTTP ${xhr.status}`));
      };
      xhr.onerror = () => { clean(); reject(new Error('Network request failed')); };
      xhr.onabort = () => { clean(); reject(new DOMException('Upload cancelled', 'AbortError')); };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) { clean(); reject(new DOMException('Upload cancelled', 'AbortError')); return; }
      xhr.send(file);
    });
  },
};

export function filterConversations(rows: ConversationSummary[], query: string, order: string): ConversationSummary[] {
  const search = query.trim().toLocaleLowerCase();
  return rows.filter(row => !search || row.title.toLocaleLowerCase().includes(search)).sort((a, b) => {
    if (order === 'oldest') return a.createdAt - b.createdAt;
    if (order === 'title') return a.title.localeCompare(b.title);
    return b.updatedAt - a.updatedAt;
  });
}

export function dateLabel(timestamp: number, t: Translate): string {
  return timestamp > 0 ? new Date(timestamp).toLocaleDateString() : t('unknownDate');
}
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);
const pathId = (value: string): string => encodeURIComponent(value);
const jsonPost = (body?: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

function downloadReport(job: ImportJob) {
  const anchor = document.createElement('a');
  anchor.href = apiRoute(`/jobs/${pathId(job.id)}/report`);
  anchor.download = `deepseek-migration-${job.id}.json`; anchor.click();
}

export function cleanupSessionIds(job: ImportJob): string[] {
  return [...new Set(job.results.filter(result => result.status !== 'failed' && result.sessionId).map(result => result.sessionId))];
}

export function cleanupConfirmation(job: ImportJob, mode: CleanupMode, t: Translate): string {
  return mode === 'records' ? t('clearRecordsConfirm') : t('deleteImportedConfirm').replace('{count}', String(cleanupSessionIds(job).length));
}

export function ConversationDetail({ conversation, t, onClose }: { conversation: Conversation; t: Translate; onClose(): void }) {
  const [branchId, setBranchId] = useState(conversation.branches[0]?.id || '');
  const dialog = useRef<HTMLDivElement>(null);
  const branch = conversation.branches.find(item => item.id === branchId) || conversation.branches[0];
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); }
      if (event.key !== 'Tab') return;
      const elements = [...dialog.current?.querySelectorAll<HTMLElement>('button,select,summary,[tabindex="0"]') || []];
      const first = elements[0], last = elements.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); previous?.focus(); };
  }, [onClose]);
  return <div className="dcm-detail-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="dcm-detail" role="dialog" aria-modal="true" aria-label={t('detail')} ref={dialog}>
      <header><h2>{conversation.title || t('untitled')}</h2><button onClick={onClose}>{t('close')}</button></header>
      {conversation.branches.length > 1 && <label>{t('branch')} <select value={branch?.id || ''} onChange={event => setBranchId(event.target.value)}>
        {conversation.branches.map((item, index) => <option key={item.id} value={item.id}>{t('branch')} {index + 1} · {item.messages.length} {t('messages')}</option>)}
      </select></label>}
      {conversation.attachmentCount > 0 && <p className="dcm-alert">{t('attachmentNotice')}</p>}
      <Warnings warnings={conversation.warnings} t={t} />
      {branch?.messages.map(message => <article className="dcm-message" key={message.id}>
        <strong>{t(message.role === 'user' ? 'user' : 'assistant')}</strong>
        {message.model && <small> · {message.model}</small>}
        {/* React text nodes escape all source content, including HTML and code. */}
        <pre>{message.text || t('emptyMessage')}</pre>
        {message.reasoning && <details><summary>{t('reasoning')}</summary><pre>{message.reasoning}</pre></details>}
        {message.attachments.length > 0 && <p><small>{t('attachments')}: {message.attachments.map(item => item.name).join(' · ')}</small></p>}
      </article>)}
    </div>
  </div>;
}

function Warnings({ warnings, t }: { warnings: string[]; t: Translate }) {
  return warnings.length ? <details className="dcm-alert"><summary>{t('warnings')} ({warnings.length})</summary><ul>{warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details> : null;
}

const translateZh: Translate = key => zh[key];
export function MigrationPage({ t = translateZh, native, api = migrationApi }: { t?: Translate; native: NativeNavigation; api?: MigrationApi }) {
  const [state, setState] = useState<ImporterState | null>(null);
  const [upload, setUpload] = useState<UploadSummary | null>(null);
  const [rows, setRows] = useState<ConversationSummary[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [workspaceId, setWorkspaceId] = useState('');
  const [branchMode, setBranchMode] = useState<'all' | 'latest'>('all');
  const [includeReasoning, setIncludeReasoning] = useState(false);
  const [query, setQuery] = useState(''); const [order, setOrder] = useState('newest');
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false); const [percent, setPercent] = useState<number | null>(null);
  const [detail, setDetail] = useState<Conversation | null>(null); const [job, setJob] = useState<ImportJob | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const input = useRef<HTMLInputElement>(null); const uploadAbort = useRef<AbortController | null>(null);
  const lifetime = useRef<AbortController | null>(null); const previewGeneration = useRef(0);
  const currentUploadId = useRef<string | null>(null); currentUploadId.current = upload?.id || null;
  const refreshedRepairs = useRef(new Set<number>());
  const refreshedJobs = useRef(new Set<string>());
  const refreshedCleanups = useRef(new Set<string>());
  const [removedSessions, setRemovedSessions] = useState(new Set<string>());
  const running = job?.status === 'running';
  const repair = state?.metadataRepair;
  const repairing = repair?.status === 'running';
  const cleanup = state?.cleanup;
  const cleaning = cleanup?.status === 'running';
  const cleanupPending = !!cleanup && !cleanup.recordsCleared && cleanup.results.some(result => result.status !== 'failed');
  const cleanupJob = state?.jobs.find(item => item.id === cleanup?.jobId) || (job?.id === cleanup?.jobId ? job : undefined);
  const cleanupResults = useMemo(() => new Map(cleanup?.results.map(result => [result.sessionId, result]) || []), [cleanup]);
  const deletedSessions = useMemo(() => new Set([...removedSessions, ...[...cleanupResults.values()]
    .filter(result => result.status !== 'failed').map(result => result.sessionId)]), [removedSessions, cleanupResults]);
  const hasImportedRecords = (repair?.total || 0) > 0 || (job?.imported || 0) > 0 || (job?.skipped || 0) > 0
    || !!state?.jobs.some(item => item.imported > 0 || item.skipped > 0);
  const visible = useMemo(() => filterConversations(rows, query, order), [rows, query, order]);
  const closeDetail = useCallback(() => setDetail(null), []);

  const loadPreview = useCallback(async (id: string, select = false) => {
    const generation = ++previewGeneration.current;
    const result = await api.request<{ upload: UploadSummary; conversations: ConversationSummary[] }>(`/uploads/${pathId(id)}`);
    if (lifetime.current?.signal.aborted || generation !== previewGeneration.current) return;
    setUpload(result.upload); setRows(result.conversations);
    if (select) setSelected(new Set(result.conversations.map(item => item.id)));
  }, [api]);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const result = await api.request<ImporterState>('/state', { signal });
    if (lifetime.current?.signal.aborted || signal?.aborted) return;
    setState(result);
    setWorkspaceId(current => result.workspaces.some(item => item.id === current) ? current
      : result.workspaces.find(item => item.id === native.currentWorkspace())?.id || result.workspaces[0]?.id || '');
    return result;
  }, [api, native]);

  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller;
    void api.request<ImporterState>('/state', { signal: controller.signal }).then(async result => {
      if (controller.signal.aborted) return;
      setState(result);
      setWorkspaceId(result.workspaces.find(item => item.id === native.currentWorkspace())?.id || result.workspaces[0]?.id || '');
      setJob([...result.jobs].sort((a, b) => b.startedAt - a.startedAt)[0] || null);
      if (result.uploads[0]) await loadPreview(result.uploads[0].id, true);
    }).catch(reason => { if (!controller.signal.aborted) setError(errorText(reason)); });
    return () => { controller.abort(); uploadAbort.current?.abort(); previewGeneration.current++; };
  }, [api, native, loadPreview]);

  useEffect(() => {
    if (!cleanup?.results.length) return;
    const removed = cleanup.results.filter(result => result.status !== 'failed').map(result => result.sessionId);
    if (removed.length) setRemovedSessions(previous => new Set([...previous, ...removed]));
  }, [cleanup?.id, cleanup?.processed, cleanup?.status]);

  useEffect(() => {
    if (!cleaning) return;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const result = await refresh(controller.signal);
        if (controller.signal.aborted) return;
        setError(current => current.startsWith(t('cleanupReconnect')) ? '' : current);
        if (result?.cleanup?.status === 'running') timer = setTimeout(() => { void poll(); }, 1000);
      } catch (reason) {
        if (!controller.signal.aborted) {
          setError(`${t('cleanupReconnect')} ${errorText(reason)}`);
          timer = setTimeout(() => { void poll(); }, 2500);
        }
      }
    };
    timer = setTimeout(() => { void poll(); }, 1000);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [cleaning, cleanup?.id, refresh, t]);

  useEffect(() => {
    if (!cleanup || cleanup.status === 'running') return;
    const key = `${cleanup.id}:${cleanup.status}:${cleanup.finishedAt || 0}:${cleanup.recordsCleared}`;
    if (refreshedCleanups.current.has(key)) return;
    refreshedCleanups.current.add(key);
    let active = true;
    void native.refreshSessions().then(async () => {
      if (!active) return;
      const result = await refresh();
      if (!active || !result) return;
      setJob(current => current ? result.jobs.find(item => item.id === current.id) || null : current);
      const uploadId = currentUploadId.current;
      if (uploadId) {
        if (result.uploads.some(item => item.id === uploadId)) await loadPreview(uploadId);
        else {
          previewGeneration.current++; setUpload(null); setRows([]); setSelected(new Set()); setDetail(null);
        }
      }
    }).catch(reason => { if (active) setError(errorText(reason)); });
    return () => { active = false; };
  }, [cleanup?.id, cleanup?.status, cleanup?.finishedAt, cleanup?.recordsCleared, native, refresh, loadPreview]);

  useEffect(() => {
    if (!repairing) return;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const result = await refresh(controller.signal);
        if (controller.signal.aborted) return;
        setError(current => current.startsWith(t('repairTitlesReconnect')) ? '' : current);
        if (result?.metadataRepair?.status === 'running') timer = setTimeout(() => { void poll(); }, 1000);
      } catch (reason) {
        if (!controller.signal.aborted) {
          setError(`${t('repairTitlesReconnect')} ${errorText(reason)}`);
          timer = setTimeout(() => { void poll(); }, 2500);
        }
      }
    };
    timer = setTimeout(() => { void poll(); }, 1000);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [repairing, repair?.startedAt, refresh, t]);

  useEffect(() => {
    if (!repair || repair.status !== 'completed' || !repair.total || refreshedRepairs.current.has(repair.startedAt)) return;
    refreshedRepairs.current.add(repair.startedAt);
    let active = true;
    void native.refreshSessions().catch(reason => { if (active) setError(errorText(reason)); });
    return () => { active = false; };
  }, [repair?.status, repair?.startedAt, repair?.total, native]);

  useEffect(() => {
    if (!job || job.status !== 'running') return;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const result = await api.request<ImportJob>(`/jobs/${pathId(job.id)}`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setError(current => current.startsWith(t('progressReconnect')) ? '' : current);
        setJob(result);
        if (result.status === 'running') timer = setTimeout(() => { void poll(); }, 900);
      } catch (reason) {
        if (!controller.signal.aborted) {
          setError(`${t('progressReconnect')} ${errorText(reason)}`);
          timer = setTimeout(() => { void poll(); }, 2500);
        }
      }
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [job?.id, job?.status, api, t]);

  // Also handle a job that finishes before its POST response, or via Stop import.
  useEffect(() => {
    if (!job || job.status === 'running' || cleaning || cleanup?.jobId === job.id && cleanup.recordsCleared) return;
    const key = `${job.id}:${job.status}`;
    if (refreshedJobs.current.has(key)) return;
    refreshedJobs.current.add(key);
    let active = true;
    setCancelling(false);
    void native.refreshSessions().then(async () => {
      if (active && upload) await loadPreview(upload.id);
    }).catch(reason => { if (active) setError(errorText(reason)); });
    return () => { active = false; };
  }, [job?.id, job?.status, cleaning, cleanup?.jobId, cleanup?.recordsCleared, native, upload?.id, loadPreview]);

  const execute = useCallback(async (operation: () => Promise<void>) => {
    setBusy(true); setError('');
    try { await operation(); } catch (reason) { if (!lifetime.current?.signal.aborted) setError(errorText(reason)); }
    finally { if (!lifetime.current?.signal.aborted) setBusy(false); }
  }, []);

  const chooseFile = async (file: File) => {
    if (busy || running || cleaning || percent !== null) return;
    if (!/\.(zip|json)$/i.test(file.name)) { setError(t('invalidFile')); return; }
    if (file.size === 0) { setError(t('emptyFile')); return; }
    setError(''); setPercent(0); setBusy(true);
    const controller = new AbortController(); uploadAbort.current = controller;
    try {
      const result = await api.upload(file, setPercent, controller.signal);
      if (lifetime.current?.signal.aborted) return;
      await loadPreview(result.id, true); setJob(null); setQuery('');
      await refresh();
    } catch (reason) {
      if (!lifetime.current?.signal.aborted) setError(controller.signal.aborted ? t('uploadCancelled') : errorText(reason));
    } finally {
      uploadAbort.current = null;
      if (!lifetime.current?.signal.aborted) { setPercent(null); setBusy(false); }
    }
  };

  const startImport = () => execute(async () => {
    if (!upload || !workspaceId || !selected.size || repairing || cleaning || cleanupPending) return;
    const request: ImportRequest = { workspaceId, conversationIds: [...selected], branchMode, includeReasoning };
    setJob(await api.request<ImportJob>(`/uploads/${pathId(upload.id)}/jobs`, jsonPost(request)));
  });
  const showDetail = (id: string) => execute(async () => {
    if (!upload) return;
    setDetail(await api.request<Conversation>(`/uploads/${pathId(upload.id)}/conversations/${pathId(id)}`));
  });
  const toggleSelected = (id: string, checked: boolean) => setSelected(previous => { const next = new Set(previous); if (checked) next.add(id); else next.delete(id); return next; });
  const repairTitles = () => execute(async () => {
    if (cleaning || running || repairing) return;
    const result = await api.request<MetadataRepairState>('/metadata/repair', jsonPost());
    if (lifetime.current?.signal.aborted) return;
    setState(current => current ? { ...current, metadataRepair: result } : current);
    await refresh();
  });
  const clearJob = (target: ImportJob, mode: CleanupMode) => {
    if (cleanupPending && (target.id !== cleanup?.jobId || mode !== 'sessions-and-records')) return;
    if (busy || running || repairing || cleaning || !window.confirm(cleanupConfirmation(target, mode, t))) return;
    void execute(async () => {
      const result = await api.request<CleanupTask>(`/jobs/${pathId(target.id)}/clear`, jsonPost({ mode }));
      if (lifetime.current?.signal.aborted) return;
      setState(current => current ? { ...current, cleanup: result } : current);
      await refresh();
    });
  };

  return <main className="dcm">
    <span className="dcm-badge">{t('localOnly')}</span><h1>{t('title')}</h1><p>{t('intro')}</p>
    <p className="dcm-muted"><small>{t('privacy')}</small></p>
    <details><summary>{t('exportHelp')}</summary><p className="dcm-muted">{t('exportSteps')}</p></details>
    {error && <div className="dcm-alert" data-error="true" role="alert"><strong>{t('error')}</strong><p>{error}</p><button onClick={() => { void execute(async () => { await refresh(); if (upload) await loadPreview(upload.id); }); }}>{t('refresh')}</button></div>}
    {!state && <p role="status">{t('loading')}</p>}
    {state && !state.compatible && <div className="dcm-alert" data-error="true"><strong>{t('compatibility')}</strong><p>{state.compatibilityMessage || t('compatibilityHint')}</p></div>}
    {state && <div className="dcm-toolbar"><button className="dcm-text-button" disabled={busy} onClick={() => { void execute(async () => { await refresh(); }); }}>{t('refresh')}</button>
      {hasImportedRecords && <button disabled={busy || running || repairing || cleaning || !state.compatible} onClick={() => { void repairTitles(); }}>{t(repair?.failed ? 'repairTitlesRetry' : 'repairTitles')}</button>}
    </div>}
    {repair && (repairing || repair.total > 0) && <div className="dcm-alert" data-error={repair.failed > 0}>
      <p role="status">{t(repairing ? 'repairingTitles' : 'repairedTitles')} · {repair.processed} / {repair.total}</p>
      {repairing && <progress value={repair.processed} max={Math.max(repair.total, 1)} aria-label={t('repairingTitles')} />}
      {repair.failed > 0 && <p>{t('repairTitlesFailed')} ({repair.failed})</p>}
      {repair.missing > 0 && <p><small>{t('repairTitlesMissing')}: {repair.missing}</small></p>}
      <small>{t('repairTitlesHint')}</small>
    </div>}
    <div className="dcm-drop" data-active={dragging} onDragOver={event => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)}
      onDrop={event => { event.preventDefault(); setDragging(false); if (event.dataTransfer.files.length !== 1) setError(t('oneFile')); else void chooseFile(event.dataTransfer.files[0]!); }}>
      <svg className="dcm-drop-icon" width="34" height="34" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 16V3m0 0L7 8m5-5 5 5M4 14v6h16v-6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
      {percent === null ? <><strong>{t('drop')}</strong><p><small>{t('fileHint')}</small></p><button className="dcm-primary" disabled={busy || running || cleaning} onClick={() => input.current?.click()}>{t(upload ? 'newExport' : 'choose')}</button></>
        : <><p role="status">{t('uploading')} · {percent}%</p><progress value={percent} max={100} aria-label={t('uploading')} /><div className="dcm-actions"><button onClick={() => uploadAbort.current?.abort()}>{t('cancelUpload')}</button></div></>}
      <input ref={input} hidden type="file" accept=".zip,.json,application/zip,application/json" onChange={event => { const file = event.target.files?.[0]; if (file) void chooseFile(file); event.target.value = ''; }} />
    </div>
    {!!state?.uploads.length && <div className="dcm-toolbar"><label>{t('savedExports')} <select value={upload?.id || ''} disabled={busy || running || cleaning} onChange={event => { void execute(async () => { await loadPreview(event.target.value, true); setJob(null); }); }}>
      {!upload && <option value="">—</option>}{state.uploads.map(item => <option key={item.id} value={item.id}>{item.filename} · {item.conversationCount} {t('conversations')}</option>)}
    </select></label>{upload && <button className="dcm-text-button" disabled={busy || running || cleaning} onClick={() => {
      if (window.confirm(t('removeConfirm'))) void execute(async () => { await api.request(`/uploads/${pathId(upload.id)}`, { method: 'DELETE' }); setUpload(null); setRows([]); setSelected(new Set()); await refresh(); });
    }}>{t('removeUpload')}</button>}</div>}
    {upload && <>
      <div className="dcm-card"><h2>{t('preview')}</h2><p className="dcm-muted">{upload.conversationCount} {t('conversations')} · {upload.branchCount} {t('branches')} · {upload.messageCount} {t('messages')}</p><Warnings warnings={upload.warnings} t={t} />
        <div className="dcm-toolbar"><input type="search" aria-label={t('search')} placeholder={t('search')} value={query} onChange={event => setQuery(event.target.value)} /><select aria-label={t('newest')} value={order} onChange={event => setOrder(event.target.value)}><option value="newest">{t('newest')}</option><option value="oldest">{t('oldest')}</option><option value="title">{t('titleSort')}</option></select></div>
        <div className="dcm-toolbar"><button disabled={running || busy} onClick={() => setSelected(previous => new Set([...previous, ...visible.map(item => item.id)]))}>{t('selectVisible')}</button><button disabled={running || busy} onClick={() => setSelected(previous => new Set([...previous].filter(id => !visible.some(item => item.id === id))))}>{t('clearVisible')}</button><small>{selected.size} {t('selected')}</small></div>
        <div className="dcm-list">{!visible.length && <p className="dcm-empty">{t('noResults')}</p>}{visible.map(row => <div className="dcm-row" key={row.id}>
          <input type="checkbox" checked={selected.has(row.id)} disabled={running || busy} aria-label={row.title || t('untitled')} onChange={event => toggleSelected(row.id, event.target.checked)} />
          <div className="dcm-row-copy"><span className="dcm-row-title" onClick={() => { if (!running && !busy) toggleSelected(row.id, !selected.has(row.id)); }}>{row.title || t('untitled')}</span><small>{dateLabel(row.updatedAt, t)} · {row.messageCount} {t('messages')} · {row.branchCount} {t('branches')}{row.imported && ` · ${t('previouslyImported')}`}</small></div>
          <button className="dcm-text-button" disabled={busy} onClick={() => { void showDetail(row.id); }}>{t('viewConversation')}</button>
        </div>)}</div>
      </div>
      <section className="dcm-card"><h2>{t('target')}</h2><div className="dcm-options"><div className="dcm-field"><label htmlFor="dcm-workspace">{t('workspace')}</label><select id="dcm-workspace" value={workspaceId} disabled={running || busy} onChange={event => setWorkspaceId(event.target.value)}>{state?.workspaces.map(item => <option value={item.id} key={item.id}>{item.title || item.path}</option>)}</select>{!state?.workspaces.length && <p className="dcm-alert">{t('noWorkspace')}</p>}</div><div className="dcm-field"><label htmlFor="dcm-branches">{t('branchMode')}</label><select id="dcm-branches" value={branchMode} disabled={running || busy} onChange={event => setBranchMode(event.target.value as 'all' | 'latest')}><option value="all">{t('allBranches')}</option><option value="latest">{t('latestBranch')}</option></select></div></div>
        <p><small>{t('branchHint')}</small></p><label className="dcm-check"><input type="checkbox" checked={includeReasoning} disabled={running || busy} onChange={event => setIncludeReasoning(event.target.checked)} />{t('includeReasoning')}</label><small>{t('reasoningHint')}</small>
        <div className="dcm-actions"><button className="dcm-primary" disabled={running || repairing || cleaning || cleanupPending || busy || !selected.size || !workspaceId || !state?.compatible} onClick={() => { void startImport(); }}>{t('import')} ({selected.size})</button></div>
      </section>
    </>}
    {job && <section className="dcm-card" aria-label={t('resultSessions')}><h2>{t(job.status === 'running' ? 'importing' : job.status === 'completed' ? 'completed' : job.status === 'cancelled' ? 'cancelled' : job.status === 'interrupted' ? 'interrupted' : 'failed')}</h2>
      <progress value={job.processed} max={Math.max(job.total, 1)} aria-label={t('processed')} />
      <p className="dcm-live" role="status">{job.processed} / {job.total} {t('processed')}{running && job.currentTitle ? ` · ${job.currentTitle}` : ''}</p>
      <div className="dcm-stats"><span><strong>{job.imported}</strong>{t('imported')}</span><span><strong>{job.skipped}</strong>{t('skipped')}</span><span><strong>{job.failed}</strong>{t('failedCount')}</span></div>
      {job.error && <p className="dcm-alert" data-error="true">{job.error}</p>}
      <div className="dcm-actions">{running ? <button disabled={cancelling} onClick={() => { setCancelling(true); void api.request<ImportJob>(`/jobs/${pathId(job.id)}/cancel`, jsonPost()).then(setJob).catch(reason => { setError(errorText(reason)); setCancelling(false); }); }}>{t(cancelling ? 'cancelling' : 'cancelJob')}</button>
        : <>{(job.failed > 0 || ['cancelled', 'failed', 'interrupted'].includes(job.status)) && <button className="dcm-primary" disabled={busy || repairing || cleaning || cleanupPending || !state?.compatible} onClick={() => { void execute(async () => { setJob(await api.request<ImportJob>(`/jobs/${pathId(job.id)}/retry`, jsonPost())); }); }}>{t('retryJob')}</button>}<button disabled={cleaning} onClick={() => downloadReport(job)}>{t('report')}</button></>}</div>
      {!running && <div className="dcm-actions"><button disabled={busy || repairing || cleaning || cleanupPending} onClick={() => clearJob(job, 'records')}>{t('clearRecords')}</button><button disabled={busy || repairing || cleaning || cleanupPending && job.id !== cleanup?.jobId || !state?.compatible || !cleanupSessionIds(job).length} onClick={() => clearJob(job, 'sessions-and-records')}>{t('deleteImportedSessions')}</button></div>}
      <p><small>{t(running ? 'stopHint' : 'reportHint')}</small></p>
      {job.results.map((result, index) => {
        const cleared = cleanupResults.get(result.sessionId);
        const removed = deletedSessions.has(result.sessionId);
        return <div className="dcm-result" key={`${result.sourceId}-${result.branchId}-${index}`}><span>{result.title || t('untitled')}<small> · {t(removed ? cleared?.status === 'missing' ? 'cleanupMissing' : 'cleanupDeleted' : result.status === 'failed' ? 'failedCount' : result.status === 'skipped' ? 'skipped' : 'imported')}{(cleared?.error || result.error) && ` · ${cleared?.error || result.error}`}</small></span>{!removed && result.status !== 'failed' && result.sessionId && <button disabled={cleaning} onClick={() => { try { native.openSession(result.sessionId); } catch { setError(t('navigationError')); } }}>{t('continueChat')}</button>}</div>;
      })}
    </section>}
    {cleanup && <section className="dcm-card" aria-label={t('cleanupSummary')}>
      <h2>{t(cleaning ? cleanup.mode === 'records' ? 'clearingRecords' : 'deletingImportedSessions' : cleanup.recordsCleared ? 'cleanupCompleted' : 'cleanupIncomplete')}</h2>
      {cleanup.mode === 'sessions-and-records' && <><progress value={cleanup.processed} max={Math.max(cleanup.total, 1)} aria-label={t('cleanupSummary')} /><p role="status">{cleanup.processed} / {cleanup.total} {t('processed')}</p><div className="dcm-stats"><span><strong>{cleanup.deleted}</strong>{t('cleanupDeleted')}</span><span><strong>{cleanup.missing}</strong>{t('cleanupMissing')}</span><span><strong>{cleanup.failed}</strong>{t('failedCount')}</span></div></>}
      {cleanup.error && <p className="dcm-alert" data-error="true">{cleanup.error}</p>}
      {!cleaning && cleanupPending && <p className="dcm-alert">{t('cleanupPending')}</p>}
      {cleanup.results.some(result => result.status === 'failed') && <div className="dcm-alert" data-error="true"><ul>{cleanup.results.filter(result => result.status === 'failed').map(result => <li key={result.sessionId}>{job?.results.find(item => item.sessionId === result.sessionId)?.title || result.sessionId}: {result.error || t('failedCount')}</li>)}</ul></div>}
      {!cleaning && !cleanup.recordsCleared && cleanupJob && <><p><small>{t('cleanupRetryHint')}</small></p><button disabled={busy || running || repairing} onClick={() => clearJob(cleanupJob, cleanup.mode)}>{t('cleanupRetry')}</button></>}
    </section>}
    {detail && <ConversationDetail conversation={detail} t={t} onClose={closeDetail} />}
  </main>;
}

function ImportIcon({ size = 18 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 4h10l4 4v12H5V4Zm10 0v5h4M8 14h8m-3-3 3 3-3 3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

/** Real public Harness providers supply both the destination and conversation navigation. */
export function nativeNavigation(ctx: Context): NativeNavigation {
  return {
    currentWorkspace() {
      const ids = ctx.sessions.list.getSnapshot().ids;
      const current = ids.find(id => (ctx.sessions.retainInfo(id).getSnapshot().retainedBy.mainView || 0) > 0);
      return current ? ctx.workspaces.list.getSnapshot().items.find(item => item.sessionIds.includes(current))?.workspaceId : undefined;
    },
    openSession(id) { ctx.uiWorkspace.openSession(id as SessionId); },
    refreshSessions() { return ctx.sessions.refresh(); },
  };
}

/** This is a Harness Client plugin, not a separate app root or website. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'deepseek-chat-migration: dictionaries');
  ctx.effect(() => {
    const style = document.createElement('style'); style.dataset.deepseekChatMigration = ''; style.textContent = styles; document.head.append(style);
    return () => { style.remove(); };
  }, 'deepseek-chat-migration: styles');
  const native = nativeNavigation(ctx);
  const open = () => ctx.layout.selectPanel(PANEL_ID);
  const bound = ctx.locale.bind(NS);
  const Page = ({ t }: { t: Translate }) => <MigrationPage t={t} native={native} />;
  const Config = ({ t, view }: PluginConfigViewProps & { t: Translate }) => view === 'summary' ? <>{t('configBody')}</>
    : <div className="dcm dcm-guidance"><p>{t('configBody')}</p><button className="dcm-primary" onClick={open}>{t('openImporter')}</button></div>;
  const Activation = ({ t, onDismiss }: PluginActivationOwnerProps & { t: Translate }) => <div className="dcm-detail-backdrop"><div className="dcm dcm-detail dcm-guidance" role="dialog" aria-modal="true" aria-label={t('activationTitle')}><h2>{t('activationTitle')}</h2><p>{t('activationBody')}</p><div className="dcm-actions"><button className="dcm-primary" onClick={() => { onDismiss(); open(); }}>{t('openImporter')}</button><button onClick={onDismiss}>{t('later')}</button></div></div></div>;
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS }, Page));
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 10, locale: NS, label: () => bound('panel') }, ImportIcon));
  ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({ name: 'plugins.bundle.config', key: PACKAGE_NAME, locale: NS }, Config));
  ctx.slots.inject('plugins.bundle.activation', () => ctx.slots.register({ name: 'plugins.bundle.activation', key: PACKAGE_NAME, locale: NS }, Activation));
}
