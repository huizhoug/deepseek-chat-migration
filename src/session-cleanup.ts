import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { lstat, mkdir, open, readdir, realpath, rename, rmdir, stat, unlink } from 'node:fs/promises';
import type { Context } from '@deepseek-ai/cordis';
import { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session';
import type { SessionHeader, SessionId as NativeSessionId } from '@deepseek-ai/dsh-session';
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import { projectionCacheDomainSpec } from '@deepseek-ai/dsh-session-projection-cache';
import type {} from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-api-session-controller';

const BACKEND_VERSION = '0.2.0-rc.2';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const require = createRequire(import.meta.url);
const backendVersion: unknown = (require('@deepseek-ai/dsh-session-persistence-jsonl/package.json') as { version?: unknown }).version;

interface FileIdentity { size: number; sha256: string }
interface Journal {
  schema: 1;
  backendVersion: typeof BACKEND_VERSION;
  root: string;
  sessionId: string;
  sourceDir: string;
  filename: string;
  header: SessionHeader;
  file: FileIdentity;
  phase: 'prepared' | 'staged' | 'metadata-cleaned';
}

function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'; }
async function maybeStat(path: string) {
  try { return await lstat(path); } catch (error) { if (missing(error)) return undefined; throw error; }
}
function refuse(message: string): never { throw new Error(`无法清除导入对话：${message}`); }

/** rc.2's physical project key, pinned to the checked backend version below.
 * packages/session/session-persistence-jsonl/src/format.ts:projectKey.
 * It is used only to authenticate an existing locator/journal, never to write a log.
 */
function projectKey(cwd: string): string {
  let readable = '';
  let separatorRun = false;
  for (let i = 0; i < cwd.length; i += 1) {
    const code = cwd.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-';
      separatorRun = true;
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0');
      separatorRun = false;
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`;
}

function authenticateHeader(header: SessionHeader, id: string): void {
  if (header.version !== 4 || header.id !== id || header.isSeeded !== false
    || header.parentSession !== undefined || header.origin !== undefined || (header.delegationDepth ?? 0) !== 0
    || !Number.isSafeInteger(header.createdAt) || header.createdAt < 0
    || typeof header.cwd !== 'string' || !isAbsolute(header.cwd) || !header.cwd) {
    refuse('原生会话身份或格式与本插件的迁移会话不符。');
  }
}

function expectedDir(root: string, header: SessionHeader): string {
  return join(root, projectKey(header.cwd!), header.id);
}

async function safeDescendant(root: string, target: string, directory: boolean, allowMissing = false): Promise<boolean> {
  const path = relative(root, target);
  if (!path || path.startsWith('..' + sep) || path === '..' || isAbsolute(path)) refuse('存储路径不在认证目录内。');
  const parts = path.split(sep);
  let current = root;
  for (let i = 0; i < parts.length; i += 1) {
    current = join(current, parts[i]!);
    const info = await maybeStat(current);
    if (!info) { if (allowMissing) return false; refuse('存储路径已消失，请重试。'); }
    if (info.isSymbolicLink()) refuse('存储路径含符号链接，已保留所有记录。');
    if (i < parts.length - 1 || directory) {
      if (!info.isDirectory()) refuse('存储目录类型不符。');
    } else if (!info.isFile() || info.nlink !== 1) {
      refuse('会话内容不是独立的常规文件。');
    }
  }
  return true;
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function fingerprint(path: string): Promise<FileIdentity> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1) refuse('会话内容不是独立的常规文件。');
    const digest = createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      digest.update(buffer.subarray(0, bytesRead));
    }
    const after = await handle.stat();
    if (after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ino !== info.ino) refuse('会话内容在核对期间发生变化。');
    return { size: info.size, sha256: digest.digest('hex') };
  } finally { await handle.close(); }
}

async function verifyFile(path: string, identity: FileIdentity): Promise<void> {
  const actual = await fingerprint(path);
  if (actual.size !== identity.size || actual.sha256 !== identity.sha256) refuse('待清除日志与删除事务不一致，已保留文件。');
}

async function saveJournal(dir: string, journal: Journal): Promise<void> {
  const temp = join(dir, `.manifest-${randomUUID()}.tmp`);
  const handle = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(JSON.stringify(journal)); await handle.sync(); } finally { await handle.close(); }
  try { await rename(temp, join(dir, 'manifest.json')); await syncDirectory(dir); }
  finally { await unlink(temp).catch(error => { if (!missing(error)) throw error; }); }
}

async function readJournal(dir: string): Promise<unknown> {
  const path = join(dir, 'manifest.json');
  if (!await maybeStat(path)) return undefined;
  await safeDescendant(dir, path, false);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if ((await handle.stat()).size > 64 * 1024) refuse('删除事务记录过大。');
    return JSON.parse(await handle.readFile('utf8')) as unknown;
  } finally { await handle.close(); }
}

function validateJournal(value: unknown, root: string, id: string, filename: string): Journal {
  if (!value || typeof value !== 'object') refuse('删除事务记录无法验证。');
  const item = value as Partial<Journal>;
  if (item.schema !== 1 || item.backendVersion !== BACKEND_VERSION || item.root !== root || item.sessionId !== id
    || item.filename !== filename || !item.header || !item.file
    || !Number.isSafeInteger(item.file.size) || item.file.size < 0 || !/^[0-9a-f]{64}$/.test(item.file.sha256)
    || !['prepared', 'staged', 'metadata-cleaned'].includes(item.phase ?? '')) refuse('删除事务记录无法验证。');
  authenticateHeader(item.header, id);
  if (item.sourceDir !== expectedDir(root, item.header)) refuse('删除事务的原生路径与会话身份不一致。');
  return item as Journal;
}

/** The engine authorizes IDs from its durable migration ledger before calling
 * this adapter. This backend never traverses arbitrary directories or deletes
 * a live session. Later replies and renames belong to the authorized whole log.
 */
export function createSessionCleanup(ctx: Context): (sessionId: string) => Promise<boolean> {
  const running = new Set<string>();
  const idle = (id: NativeSessionId, persistence: JsonlSessionPersistence): void => {
    if (ctx.get('sessions')?.get(id) || ctx.get('agents')?.get(id) || persistence.hasPendingSession(id)) {
      refuse('该对话正在使用，请关闭它并重启 Harness 后重试。');
    }
  };
  const metadata = async (id: NativeSessionId): Promise<void> => {
    for (const workspace of ctx.workspaceRegistry.list()) await workspace.detachSession(id);
    await ctx.workspaceRegistry.unarchiveSession(id);
    await ctx.workspaceRegistry.unpinSession(id);
    const domain = ctx.storageDomain.get(projectionCacheDomainSpec.name);
    if (!domain) refuse('侧栏缓存尚未就绪，请重试。');
    await domain.table('sessions').delete(id);
    ctx.emit('api-session/removed', id);
  };
  return async (sessionId: string): Promise<boolean> => {
    if (!UUID.test(sessionId)) refuse('目标 ID 不是本插件生成的迁移 UUID。');
    if (running.has(sessionId)) refuse('同一对话的清除操作尚未完成。');
    const persistence = ctx.get('sessionPersistence');
    if (!(persistence instanceof JsonlSessionPersistence) || backendVersion !== BACKEND_VERSION || SESSION_FORMAT_VERSION !== 4) {
      refuse('当前会话存储版本尚未验证安全删除；仅支持官方 0.2.0-rc.2 JSONL 存储。');
    }
    if (process.platform !== 'darwin' && process.platform !== 'linux') refuse('当前清除功能仅支持 macOS 和 Linux。');
    if (!ctx.get('workspaceRegistry') || !ctx.get('storageDomain')) refuse('工作区或侧栏缓存服务未加载。');
    const id = SessionId(sessionId);
    idle(id, persistence);
    running.add(sessionId);
    try {
      const configuredRoot = resolve(persistence.config.root);
      const rootInfo = await maybeStat(configuredRoot);
      if (rootInfo?.isSymbolicLink() || (rootInfo && !rootInfo.isDirectory())) refuse('会话存储根目录不是普通目录。');
      // Canonicalize ancestor aliases such as macOS /var -> /private/var.
      const root = rootInfo ? await realpath(configuredRoot) : join(await realpath(dirname(configuredRoot)), basename(configuredRoot));
      const stagingRoot = join(dirname(root), `.deepseek-chat-migration-cleanup-${createHash('sha256').update(root).digest('hex').slice(0, 24)}`);
      const stagingDir = join(stagingRoot, sessionId);
      const filename = persistence.config.compression === 'none' ? 'session.v4.jsonl' : 'session.v4.jsonl.zstd';
      const stagingInfo = await maybeStat(stagingRoot);
      if (stagingInfo && (!stagingInfo.isDirectory() || stagingInfo.isSymbolicLink())) refuse('删除事务目录不是普通目录。');
      let hasStage = stagingInfo && await safeDescendant(stagingRoot, stagingDir, true, true);
      const rawJournal = hasStage ? await readJournal(stagingDir) : undefined;
      let journal = rawJournal === undefined ? undefined : validateJournal(rawJournal, root, sessionId, filename);
      const removeUnpublishedStage = async (): Promise<void> => {
        if (!hasStage || journal) return;
        const entries = await readdir(stagingDir);
        if (entries.some(entry => !/^\.manifest-[0-9a-f-]+\.tmp$/.test(entry))) refuse('存在未完成且无法验证的删除事务，已保留记录。');
        for (const entry of entries) { await safeDescendant(stagingRoot, join(stagingDir, entry), false); await unlink(join(stagingDir, entry)); }
        await rmdir(stagingDir);
        await syncDirectory(stagingRoot);
        hasStage = false;
      };
      if (hasStage && !journal) {
        // A crash before the first journal publish or after its final unlink
        // can leave an empty directory or an unpublished temporary manifest.
        // A moved log without its manifest is never accepted.
        const entries = await readdir(stagingDir);
        if (entries.some(entry => !/^\.manifest-[0-9a-f-]+\.tmp$/.test(entry))) refuse('存在未完成且无法验证的删除事务，已保留记录。');
        // Do not remove these before taking the native lease: another process
        // could still be publishing its first journal under that lease.
      }
      const locator = await persistence.resolveCurrentLog(id);
      const locatorRelative = locator ? relative(configuredRoot, locator) : undefined;
      if (locatorRelative && (locatorRelative === '..' || locatorRelative.startsWith('..' + sep) || isAbsolute(locatorRelative))) refuse('会话定位不在官方存储根目录内。');
      const current = locatorRelative ? join(root, locatorRelative) : undefined;
      const snapshot = await persistence.stat(id);
      if (!journal && !current) {
        if (snapshot) refuse('会话存在但不是当前格式日志，未删除。');
        idle(id, persistence);
        await metadata(id);
        await removeUnpublishedStage();
        return false;
      }
      if (!journal && current) {
        await safeDescendant(root, current, false);
        if (!snapshot) refuse('会话定位与原生元数据不一致。');
        authenticateHeader(snapshot.header, sessionId);
        if (dirname(current) !== expectedDir(root, snapshot.header) || basename(current) !== filename) refuse('原生会话路径与身份不一致。');
      }
      if (journal) await safeDescendant(root, journal.sourceDir, true);
      const sourceDir = journal?.sourceDir ?? dirname(current!);
      // Refuse old generations, unknown session-local artifacts and symlinks.
      // This release's imported sessions contain only one v4 log and its lock.
      for (const entry of await readdir(sourceDir)) {
        if (entry !== filename && entry !== 'session.lock') refuse('会话目录含未验证的额外文件，未删除。');
        await safeDescendant(root, join(sourceDir, entry), false);
      }
      if (hasStage) {
        for (const entry of await readdir(stagingDir)) {
          if (entry !== 'manifest.json' && entry !== filename && !/^\.manifest-[0-9a-f-]+\.tmp$/.test(entry)) refuse('删除事务目录含未知文件。');
          await safeDescendant(stagingRoot, join(stagingDir, entry), false);
        }
      }
      // Ordinary deletions take the public write handle's in-process claim and
      // cross-process lease. A crashed staged transaction has no log to open;
      // use the concrete backend's public materialization lease on its exact
      // authenticated original directory, retaining the same lock inode.
      const held = current ? await persistence.open(id, 'write') : await persistence.acquireWriteLease(journal!.header);
      try {
        idle(id, persistence);
        if ('header' in held) {
          authenticateHeader(held.header, sessionId);
          if (expectedDir(root, held.header) !== sourceDir) refuse('持锁会话的目录与目标不一致。');
        }
        const sourcePath = join(sourceDir, filename);
        const stagedPath = join(stagingDir, filename);
        if (!journal) {
          await removeUnpublishedStage();
          if (!await maybeStat(stagingRoot)) {
            await mkdir(stagingRoot, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
            const created = await lstat(stagingRoot);
            if (!created.isDirectory() || created.isSymbolicLink()) refuse('删除事务目录不是普通目录。');
            await syncDirectory(dirname(root));
          }
          if ((await stat(stagingRoot)).dev !== (await stat(sourceDir)).dev) refuse('删除事务目录不在同一文件系统。');
          await mkdir(stagingDir, { mode: 0o700 });
          await syncDirectory(stagingRoot);
          journal = { schema: 1, backendVersion: BACKEND_VERSION, root, sessionId, sourceDir, filename,
            header: 'header' in held ? held.header : snapshot!.header, file: await fingerprint(sourcePath), phase: 'prepared' };
          try { await saveJournal(stagingDir, journal); }
          catch (error) { await rmdir(stagingDir).catch(() => {}); throw error; }
        }
        const sourceExists = await safeDescendant(root, sourcePath, false, true);
        const stagedExists = await safeDescendant(stagingRoot, stagedPath, false, true);
        if (sourceExists && stagedExists) refuse('目标日志已重新出现，删除事务不能覆盖它。');
        if (sourceExists) {
          if (journal.phase !== 'prepared') refuse('删除事务已移出日志，但原路径出现新日志，未删除新内容。');
          await verifyFile(sourcePath, journal.file);
          try {
            await rename(sourcePath, stagedPath);
            await syncDirectory(sourceDir);
            await syncDirectory(stagingDir);
            journal.phase = 'staged';
            await saveJournal(stagingDir, journal);
          } catch (error) {
            // Metadata has not changed. Put the exact bytes back on any staging
            // failure; if rollback itself fails, retain the durable journal.
            try {
              if (await maybeStat(stagedPath)) {
                if (await maybeStat(sourcePath)) refuse('回滚目标已有新文件。');
                await verifyFile(stagedPath, journal.file);
                await rename(stagedPath, sourcePath);
                await syncDirectory(sourceDir);
              }
              await unlink(join(stagingDir, 'manifest.json'));
              await rmdir(stagingDir);
              await syncDirectory(stagingRoot);
            } catch (rollback) { throw new AggregateError([error, rollback], '清除暂存失败，删除事务已保留供重试。'); }
            throw error;
          }
        } else if (stagedExists) {
          await verifyFile(stagedPath, journal.file);
          if (journal.phase === 'prepared') { journal.phase = 'staged'; await saveJournal(stagingDir, journal); }
        } else if (journal.phase !== 'metadata-cleaned') {
          refuse('删除事务的原日志和暂存日志均缺失，请保留事务目录检查。');
        }
        idle(id, persistence);
        await metadata(id);
        journal.phase = 'metadata-cleaned';
        await saveJournal(stagingDir, journal);
        if (await maybeStat(stagedPath)) { await verifyFile(stagedPath, journal.file); await unlink(stagedPath); await syncDirectory(stagingDir); }
        // Clean only our authenticated transaction files, never the native
        // session directory, lock, workspace files or shared attachments.
        for (const entry of await readdir(stagingDir)) {
          if (entry === 'manifest.json' || /^\.manifest-[0-9a-f-]+\.tmp$/.test(entry)) {
            await safeDescendant(stagingRoot, join(stagingDir, entry), false);
            await unlink(join(stagingDir, entry));
          } else refuse('删除事务目录出现未知文件，未移除它。');
        }
        await rmdir(stagingDir);
        await syncDirectory(stagingRoot);
        if (await persistence.stat(id)) refuse('日志清除后同 ID 仍存在，请检查并重试。');
        return true;
      } finally {
        if ('close' in held) await held.close();
        else await held.release();
      }
    } finally { running.delete(sessionId); }
  };
}
