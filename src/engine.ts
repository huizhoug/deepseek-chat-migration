import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, unlink, open } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { withFileLock } from '@deepseek-ai/dsh-atomic-write';
import { parseExport, latestBranch, summarizeConversation } from './archive.js';
import type { CleanupMode, CleanupTask, Conversation, HarnessAdapter, ImporterState, ImportJob, ImportRequest, ImportResult, MetadataRepairState, ParsedExport, UploadSummary } from './types.js';

export const VERSION = '1.0.2';
const CONVERTER_VERSION = 1;
interface UploadRecord { summary: UploadSummary; storedAt: number; }
interface LedgerEntry { key: string; sourceId: string; sessionId: string; state: 'pending' | 'committed'; result?: ImportResult; }
interface StoredJob { job: ImportJob; uploadId: string; }
interface Database { schema: 1; uploads: Record<string, UploadRecord>; ledger: Record<string, LedgerEntry>; jobs: StoredJob[]; cleanup?: CleanupTask; }
const hash = (value: Uint8Array | string): string => createHash('sha256').update(value).digest('hex');
const messageOf = (error: unknown): string => error instanceof Error ? error.message : '操作失败，请重试。';
const clone = <T>(value: T): T => structuredClone(value);
export class MigrationError extends Error { constructor(message: string, readonly status = 400) { super(message); } }

/** Import orchestration is independent of Harness and its physical session storage. */
export class MigrationEngine {
  private database: Database = { schema: 1, uploads: {}, ledger: {}, jobs: [] };
  private exports = new Map<string, ParsedExport>();
  private activeJob?: ImportJob;
  private running?: Promise<void>;
  private metadataRepair?: MetadataRepairState;
  private repairing?: Promise<void>;
  private cleaning?: Promise<void>;
  private writeTail = Promise.resolve();
  private mutationTail = Promise.resolve();
  private cancelled = new Set<string>();
  private closing = false;
  private releaseLock?: () => void;
  private lockTask?: Promise<void>;
  constructor(readonly root: string, readonly adapter: HarnessAdapter) {}

  async init(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await mkdir(join(this.root, 'exports'), { recursive: true, mode: 0o700 });
    let acquired!: () => void; let refused!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => { acquired = resolve; refused = reject; });
    const lifetime = new Promise<void>(resolve => { this.releaseLock = resolve; });
    this.lockTask = withFileLock(join(this.root, 'writer'), async () => { acquired(); await lifetime; }, { waitMs: 0 })
      .catch(error => { refused(new MigrationError(messageOf(error).includes('timed out waiting for the writer lock')
        ? '另一个 Harness 实例正在使用迁移数据。请关闭另一个实例后，重新启用此插件。'
        : `无法锁定迁移数据目录：${messageOf(error)}`, 409)); });
    await ready;
    try {
      const value = JSON.parse(await readFile(join(this.root, 'state.json'), 'utf8'));
      if (value?.schema !== 1 || typeof value.uploads !== 'object' || typeof value.ledger !== 'object' || !Array.isArray(value.jobs)) {
        throw new Error('迁移记录格式无法识别，请保留原文件并联系插件作者。');
      }
      this.database = value as Database;
      for (const stored of this.database.jobs) if (stored.job.status === 'running') {
        stored.job.status = 'interrupted'; stored.job.finishedAt = Date.now();
        stored.job.error = '上次导入被应用退出中断，可以重试；已完成的对话不会重复导入。';
      }
      if (this.database.cleanup?.status === 'running') {
        this.database.cleanup.status = 'interrupted'; this.database.cleanup.finishedAt = Date.now();
        this.database.cleanup.error = '上次清理被应用退出中断。请检查结果后手动重试；不会自动继续删除。';
      }
      await this.save();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { this.releaseLock?.(); await this.lockTask; throw error; }
    }
    if (this.adapter.repairSessionMetadata) await this.startMetadataRepair();
  }

  private async atomicFile(path: string, contents: Uint8Array | string): Promise<void> {
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, contents, { mode: 0o600, flag: 'wx' });
      const file = await open(temporary, 'r+');
      try { await file.sync(); } finally { await file.close(); }
      await rename(temporary, path);
    } finally { await unlink(temporary).catch(() => undefined); }
  }

  private save(): Promise<void> {
    // Snapshot at invocation time, then serialize disk replacement. No partial JSON on exit.
    const contents = JSON.stringify(this.database);
    const operation = this.writeTail.then(() => this.atomicFile(join(this.root, 'state.json'), contents));
    this.writeTail = operation.catch(() => undefined);
    return operation;
  }

  private mutate<T>(action: () => Promise<T>): Promise<T> {
    const operation = this.mutationTail.then(action);
    this.mutationTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private hasUnfinishedDeletions(): boolean {
    return Boolean(this.database.cleanup && !this.database.cleanup.recordsCleared
      && this.database.cleanup.results.some(result => result.status === 'deleted' || result.status === 'missing'));
  }

  async state(): Promise<ImporterState> {
    let workspaces: ImporterState['workspaces'] = []; let compatibilityMessage: string | undefined;
    try { workspaces = await this.adapter.listWorkspaces(); } catch (error) { compatibilityMessage = messageOf(error); }
    return { version: VERSION, compatible: !compatibilityMessage, compatibilityMessage, workspaces,
      uploads: Object.values(this.database.uploads).sort((a,b) => b.storedAt-a.storedAt).map(record => clone(record.summary)),
      jobs: this.database.jobs.slice().reverse().map(record => clone(record.job)),
      metadataRepair: this.metadataRepair ? clone(this.metadataRepair) : undefined,
      cleanup: this.database.cleanup ? clone(this.database.cleanup) : undefined };
  }

  async startMetadataRepair(): Promise<MetadataRepairState> {
    return this.mutate(async () => {
      if (this.closing) throw new MigrationError('插件正在退出。', 503);
      if (this.activeJob) throw new MigrationError('已有导入任务正在运行，请等待完成后修复侧栏缓存。', 409);
      if (this.database.cleanup?.status === 'running') throw new MigrationError('迁移清理正在进行，请等待完成后修复侧栏缓存。', 409);
      if (this.metadataRepair?.status === 'running') return clone(this.metadataRepair);
      if (!this.adapter.repairSessionMetadata) throw new MigrationError('当前 Harness 不支持侧栏缓存修复。');
      // The ledger survives removal of uploaded files. Repair only its native projection,
      // never re-import messages or infer deleted sessions from the original export.
      const sessionIds = [...new Set(Object.values(this.database.ledger)
        .filter(entry => entry.state === 'committed')
        .map(entry => entry.sessionId))];
      const repair: MetadataRepairState = { status: 'running', total: sessionIds.length, processed: 0,
        repaired: 0, missing: 0, failed: 0, errors: [], startedAt: Date.now() };
      this.metadataRepair = repair;
      this.repairing = this.runMetadataRepair(repair, sessionIds);
      return clone(repair);
    });
  }

  private async runMetadataRepair(repair: MetadataRepairState, sessionIds: string[]): Promise<void> {
    try {
      for (const sessionId of sessionIds) {
        if (this.closing) break;
        try {
          if (await this.adapter.repairSessionMetadata!(sessionId)) repair.repaired++;
          else repair.missing++;
        } catch (error) {
          repair.failed++; repair.errors.push({ sessionId, error: messageOf(error) });
        }
        repair.processed++;
        await new Promise<void>(resolve => setImmediate(resolve));
      }
    } finally { repair.status = 'completed'; repair.finishedAt = Date.now(); }
  }

  async startCleanup(jobId: string, mode: CleanupMode): Promise<CleanupTask> {
    return this.mutate(async () => {
      if (this.closing) throw new MigrationError('插件正在退出。', 503);
      if (this.activeJob) throw new MigrationError('已有导入任务正在运行，请等待完成后清理。', 409);
      if (this.metadataRepair?.status === 'running') throw new MigrationError('侧栏缓存正在修复，请等待完成后清理。', 409);
      if (this.database.cleanup?.status === 'running') throw new MigrationError('已有迁移清理任务正在运行，请等待完成。', 409);
      if (mode !== 'records' && mode !== 'sessions-and-records') throw new MigrationError('清理选项无效，请重新选择。');
      const previous = this.database.cleanup;
      if (this.hasUnfinishedDeletions() && !(previous!.jobId === jobId && mode === 'sessions-and-records')) {
        throw new MigrationError('上次清理已删除部分会话，迁移记录尚未清除。请先重试该报告的会话清理；已完成的删除会跳过。', 409);
      }
      const record = this.database.jobs.find(item => item.job.id === jobId);
      if (!record) throw new MigrationError('导入任务不存在。', 404);
      if (record.job.status === 'running') throw new MigrationError('该导入任务还在运行，请等待完成后清理。', 409);
      let sessionIds: string[] = [];
      if (mode === 'sessions-and-records') {
        if (!this.adapter.deleteImportedSession) throw new MigrationError('当前 Harness 不支持永久删除迁移会话。');
        sessionIds = [...new Set(record.job.results
          .filter(result => result.status === 'imported' || result.status === 'skipped')
          .map(result => result.sessionId))];
        const owned = new Set(Object.values(this.database.ledger).map(entry => entry.sessionId));
        if (sessionIds.some(id => typeof id !== 'string' || !id || !owned.has(id))) {
          throw new MigrationError('报告中的会话不在迁移账本中，未执行删除。请先核对迁移记录。');
        }
      }
      const resumable = mode === 'sessions-and-records' && previous?.jobId === jobId
        && previous.mode === mode && !previous.recordsCleared;
      const selectedIds = new Set(sessionIds);
      const completed = resumable ? previous.results.filter(result => result.status !== 'failed' && selectedIds.has(result.sessionId)) : [];
      const results = [...new Map(completed.map(result => [result.sessionId, clone(result)])).values()];
      const task: CleanupTask = { id: resumable ? previous.id : randomUUID(), jobId, mode, status: 'running',
        total: sessionIds.length, processed: results.length,
        deleted: results.filter(result => result.status === 'deleted').length,
        missing: results.filter(result => result.status === 'missing').length,
        failed: 0, results, recordsCleared: false, startedAt: resumable ? previous.startedAt : Date.now() };
      this.database.cleanup = task;
      try { await this.save(); } catch (error) { this.database.cleanup = previous; throw error; }
      this.cleaning = this.runCleanup(task, sessionIds);
      return clone(task);
    });
  }

  private async runCleanup(task: CleanupTask, sessionIds: string[]): Promise<void> {
    try {
      const completed = new Set(task.results.map(result => result.sessionId));
      for (const sessionId of sessionIds) {
        if (completed.has(sessionId)) continue;
        if (this.closing) break;
        try {
          const deleted = await this.adapter.deleteImportedSession!(sessionId);
          task.results.push({ sessionId, status: deleted ? 'deleted' : 'missing' });
          if (deleted) task.deleted++; else task.missing++;
        } catch (error) {
          task.results.push({ sessionId, status: 'failed', error: messageOf(error) }); task.failed++;
        }
        task.processed++;
        // A durable result is recorded between complete native deletions. On
        // restart, explicit retry resumes only work not already confirmed.
        await this.save();
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      if (this.closing) {
        task.status = 'interrupted'; task.error = '清理被应用退出中断，请检查结果后手动重试。';
      } else {
        if (task.mode === 'sessions-and-records' && task.results.some(result => result.status !== 'failed')) {
          await this.adapter.finalizeSessionDeletion?.();
        }
        if (this.closing) {
          task.status = 'interrupted'; task.error = '清理被应用退出中断，请检查结果后手动重试。';
          return;
        }
        if (!task.failed && task.processed === task.total) {
          await this.mutate(() => this.clearCleanupRecords(task, new Set(sessionIds)));
        }
        task.status = 'completed';
      }
    } catch (error) { task.status = 'interrupted'; task.error = `清理任务中断：${messageOf(error)}`; }
    finally {
      task.finishedAt = Date.now();
      await this.save().catch(error => { task.status = 'interrupted'; task.error = `保存清理结果失败：${messageOf(error)}`; });
    }
  }

  private async clearCleanupRecords(task: CleanupTask, sessionIds: Set<string>): Promise<void> {
    if (this.closing) throw new MigrationError('插件正在退出，迁移记录已保留，请手动重试清理。', 503);
    const before = this.database;
    if (task.mode === 'records') {
      this.database = { ...before, jobs: before.jobs.filter(record => record.job.id !== task.jobId) };
    } else {
      const affectedUploads = new Set<string>();
      const jobs: StoredJob[] = [];
      for (const record of before.jobs) {
        if (record.job.id === task.jobId) { affectedUploads.add(record.uploadId); continue; }
        const results = record.job.results.filter(result => !sessionIds.has(result.sessionId));
        if (results.length === record.job.results.length) { jobs.push(record); continue; }
        if (!results.length && record.job.processed >= record.job.total) { affectedUploads.add(record.uploadId); continue; }
        const job = { ...record.job, results,
          total: Math.max(results.length, record.job.total - (record.job.results.length - results.length)),
          processed: results.length,
          imported: results.filter(result => result.status === 'imported').length,
          skipped: results.filter(result => result.status === 'skipped').length,
          failed: results.filter(result => result.status === 'failed').length };
        jobs.push({ ...record, job });
      }
      const uploads = { ...before.uploads };
      const removedUploads: string[] = [];
      for (const id of affectedUploads) if (Object.hasOwn(uploads, id) && !jobs.some(record => record.uploadId === id)) {
        if (!/^[a-f0-9]{32}$/.test(id)) throw new MigrationError('本机暂存文件标识无效，未删除该文件。');
        // Only this plugin's hashed local copy is removed. The source ZIP path
        // is never stored in the database or passed to unlink.
        await unlink(join(this.root, 'exports', `${id}.json`)).catch(error => { if (error.code !== 'ENOENT') throw error; });
        delete uploads[id]; removedUploads.push(id);
      }
      const ledger = Object.fromEntries(Object.entries(before.ledger).filter(([, entry]) => !sessionIds.has(entry.sessionId)));
      this.database = { ...before, uploads, ledger, jobs };
      task.recordsCleared = true; task.status = 'completed'; task.finishedAt = Date.now();
      try { await this.save(); }
      catch (error) { task.recordsCleared = false; this.database = before; throw error; }
      for (const id of removedUploads) this.exports.delete(id);
      this.metadataRepair = undefined;
      return;
    }
    task.recordsCleared = true; task.status = 'completed'; task.finishedAt = Date.now();
    try { await this.save(); }
    catch (error) { task.recordsCleared = false; this.database = before; throw error; }
  }

  async upload(bytes: Uint8Array, filename: string): Promise<UploadSummary> {
    if (this.closing) throw new MigrationError('插件正在退出，请稍后重试。', 503);
    // Parsing ignores user.json; only the exact conversations.json bytes are retained privately.
    const parsed = parseExport(bytes, filename);
    const id = hash(parsed.conversationsJson).slice(0, 32);
    return this.mutate(async () => {
      const previous = this.database.uploads[id];
      if (previous) { this.exports.set(id, parsed); return clone(previous.summary); }
      if (Object.keys(this.database.uploads).length >= 10) throw new MigrationError('最多保留 10 份导出文件，请先移除不用的文件。');
      const cleanName = basename(filename.replaceAll('\\', '/')).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 200) || 'conversations.json';
      const summary: UploadSummary = { id, filename: cleanName,
        conversationCount: parsed.conversations.length,
        branchCount: parsed.conversations.reduce((count, item) => count + item.branches.length, 0),
        messageCount: parsed.conversations.reduce((count, item) => count + summarizeConversation(item).messageCount, 0), warnings: parsed.warnings };
      await this.atomicFile(join(this.root, 'exports', `${id}.json`), parsed.conversationsJson);
      this.database.uploads[id] = { summary, storedAt: Date.now() };
      this.exports.set(id, parsed);
      try { await this.save(); } catch (error) { delete this.database.uploads[id]; this.exports.delete(id); throw error; }
      return clone(summary);
    });
  }

  private async load(id: string): Promise<ParsedExport> {
    if (!/^[a-f0-9]{32}$/.test(id) || !Object.hasOwn(this.database.uploads, id)) throw new MigrationError('导出文件不存在，请重新选择 ZIP。', 404);
    const cached = this.exports.get(id); if (cached) return cached;
    const parsed = parseExport(await readFile(join(this.root, 'exports', `${id}.json`)), 'conversations.json');
    this.exports.set(id, parsed); return parsed;
  }

  async uploadDetail(id: string) {
    const parsed = await this.load(id);
    const importedIds = new Set(Object.values(this.database.ledger).filter(entry => entry.state === 'committed').map(entry => entry.sourceId));
    return { upload: clone(this.database.uploads[id]!.summary), conversations: parsed.conversations.map(item => summarizeConversation(item, importedIds.has(item.id))) };
  }

  async conversation(id: string, conversationId: string): Promise<Conversation> {
    const item = (await this.load(id)).conversations.find(conversation => conversation.id === conversationId);
    if (!item) throw new MigrationError('对话不存在。', 404); return clone(item);
  }

  async removeUpload(id: string): Promise<void> {
    return this.mutate(async () => {
      if (this.activeJob && this.database.jobs.find(item => item.job.id === this.activeJob?.id)?.uploadId === id) {
        throw new MigrationError('该文件正在导入，请先取消并等待当前对话完成。', 409);
      }
      if (!/^[a-f0-9]{32}$/.test(id) || !Object.hasOwn(this.database.uploads, id)) throw new MigrationError('导出文件不存在。', 404);
      const old = this.database.uploads[id]!; delete this.database.uploads[id];
      try { await this.save(); } catch (error) { this.database.uploads[id] = old; throw error; }
      this.exports.delete(id); await unlink(join(this.root, 'exports', `${id}.json`)).catch(error => { if (error.code !== 'ENOENT') throw error; });
    });
  }

  async start(uploadId: string, request: ImportRequest): Promise<ImportJob> {
    return this.mutate(async () => {
      if (this.closing) throw new MigrationError('插件正在退出。', 503);
      if (this.metadataRepair?.status === 'running') throw new MigrationError('侧栏缓存正在修复，请等待完成后导入。', 409);
      if (this.database.cleanup?.status === 'running') throw new MigrationError('迁移清理正在进行，请等待完成后导入。', 409);
      if (this.hasUnfinishedDeletions()) throw new MigrationError('上次清理尚未完成，请先重试清理完成后再导入。', 409);
      if (this.activeJob) throw new MigrationError('已有导入任务正在运行，请等待完成或取消。', 409);
      this.validateRequest(request);
      const parsed = await this.load(uploadId);
      const workspaces = await this.adapter.listWorkspaces();
      if (!workspaces.some(item => item.id === request.workspaceId)) throw new MigrationError('请先在 Harness 创建或选择有效的工作区。');
      const ids = new Set(request.conversationIds);
      const selected = parsed.conversations.filter(item => ids.has(item.id));
      if (selected.length !== ids.size) throw new MigrationError('选择中含有不存在的对话，请重新选择。');
      const total = selected.reduce((count, item) => count + (request.branchMode === 'all' ? item.branches.length : 1), 0);
      if (!total) throw new MigrationError('请选择至少一个有内容的对话。');
      const job: ImportJob = { id: randomUUID(), status: 'running', total, processed: 0, imported: 0, skipped: 0, failed: 0,
        currentTitle: '', startedAt: Date.now(), results: [], request: clone(request) };
      this.database.jobs.push({ job, uploadId }); this.activeJob = job;
      try { await this.save(); } catch (error) { this.database.jobs.pop(); this.activeJob = undefined; throw error; }
      this.running = this.run(job, selected, workspaces.find(item => item.id === request.workspaceId)!.path);
      return clone(job);
    });
  }

  private validateRequest(request: ImportRequest): void {
    if (!request || typeof request.workspaceId !== 'string' || !request.workspaceId || !Array.isArray(request.conversationIds)
      || request.conversationIds.length > 20000 || !request.conversationIds.every(id => typeof id === 'string')
      || !['all', 'latest'].includes(request.branchMode) || typeof request.includeReasoning !== 'boolean') {
      throw new MigrationError('导入选项无效，请重新选择。');
    }
  }

  private async run(job: ImportJob, selected: Conversation[], workspacePath: string): Promise<void> {
    try {
      for (const conversation of selected) {
        const branches = job.request.branchMode === 'all' ? conversation.branches : [latestBranch(conversation)];
        for (const [index, branch] of branches.entries()) {
          if (this.cancelled.has(job.id) || this.closing) { job.status = 'cancelled'; break; }
          // Stable branch titles keep latest -> all imports idempotent for the same leaf.
          const branchIndex = conversation.branches.findIndex(item => item.id === branch.id);
          const title = conversation.branches.length > 1 ? `${conversation.title} · 分支 ${branchIndex + 1}/${conversation.branches.length}` : conversation.title;
          job.currentTitle = title;
          const key = hash(JSON.stringify({ converter: CONVERTER_VERSION, sourceId: conversation.id, branchId: branch.id,
            messages: branch.messages, createdAt: conversation.createdAt, title, workspaceId: job.request.workspaceId, workspacePath,
            includeReasoning: job.request.includeReasoning }));
          let entry: LedgerEntry | undefined = this.database.ledger[key];
          const base = { sourceId: conversation.id, branchId: branch.id, workspaceId: job.request.workspaceId, title, messageCount: branch.messages.length };
          let result: ImportResult;
          try {
            if (entry?.state === 'committed' && await this.adapter.sessionExists(entry.sessionId)) {
              result = { ...base, ...entry.result, status: 'skipped', sessionId: entry.sessionId };
            } else {
              if (entry?.state === 'committed') entry = undefined; // deleted native session: create a fresh copy on an explicit new import
              if (!entry) {
                entry = { key, sourceId: conversation.id, sessionId: randomUUID(), state: 'pending' };
                this.database.ledger[key] = entry; await this.save();
              }
              const input = { conversation, branch, workspaceId: job.request.workspaceId, includeReasoning: job.request.includeReasoning, title, sessionId: entry.sessionId };
              const recovered = this.adapter.recoverConversation ? await this.adapter.recoverConversation(input) : undefined;
              const imported = recovered ?? await this.adapter.importConversation(input);
              result = { ...base, ...imported, status: 'imported' };
              entry.state = 'committed'; entry.result = result;
              await this.save();
            }
          } catch (error) {
            result = { ...base, status: 'failed', sessionId: entry?.sessionId ?? '', error: messageOf(error) };
          }
          job.results.push(result); job.processed++;
          if (result.status === 'imported') job.imported++;
          else if (result.status === 'skipped') job.skipped++;
          else job.failed++;
          await this.save();
          // Yield to UI requests and allow cancellation between complete native writes.
          await new Promise<void>(resolve => setImmediate(resolve));
        }
        if (job.status === 'cancelled') break;
      }
      if (job.status === 'running') job.status = 'completed';
    } catch (error) { job.status = 'failed'; job.error = messageOf(error); }
    finally {
      job.finishedAt = Date.now(); job.currentTitle = ''; this.cancelled.delete(job.id);
      await this.save().catch(error => { job.status = 'failed'; job.error = `保存迁移报告失败：${messageOf(error)}`; });
      if (this.activeJob === job) this.activeJob = undefined;
    }
  }

  job(id: string): ImportJob {
    const record = this.database.jobs.find(item => item.job.id === id);
    if (!record) throw new MigrationError('导入任务不存在。', 404); return clone(record.job);
  }
  cancel(id: string): ImportJob { const job = this.job(id); if (job.status === 'running') this.cancelled.add(id); return job; }
  async retry(id: string): Promise<ImportJob> {
    const record = this.database.jobs.find(item => item.job.id === id);
    if (!record) throw new MigrationError('导入任务不存在。', 404);
    if (record.job.status === 'running') throw new MigrationError('任务还在运行。', 409);
    // Replay selection with the durable ledger: failed/missed branches retry, committed branches skip.
    return this.start(record.uploadId, record.job.request);
  }
  async idle(): Promise<void> { await this.running; await this.repairing; await this.cleaning; await this.writeTail; }
  async close(): Promise<void> {
    this.closing = true;
    try { await this.mutationTail; await this.idle(); this.exports.clear(); }
    finally { this.releaseLock?.(); await this.lockTask; }
  }
}
