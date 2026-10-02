import { MigrationEngine, MigrationError } from './engine.js';
import { reportData } from './report.js';
export const API_PATH = '/api/deepseek-chat-migration';
export const UPLOAD_PATH = '/api/deepseek-chat-migration.upload';
const MAX_UPLOAD = 200 * 1024 * 1024;
async function readBody(request: Request, limit: number): Promise<Uint8Array> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) throw new MigrationError('文件过大，请选择 200 MB 以内的导出文件。', 413);
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) { const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength; if (size > limit) { await reader.cancel(); throw new MigrationError('请求过大。', 413); } chunks.push(value); }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; } return bytes;
}
function json(value: unknown, status = 200): Response { return new Response(JSON.stringify(value), { status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } }); }
/** Registered with Harness Connection: desktop IPC and authenticated Web use the same handler. */
export function createApiHandler(engine: MigrationEngine): (request: Request) => Promise<Response> {
  return async request => {
    try {
      const url = new URL(request.url); const route = url.searchParams.get('route') ?? '/state';
      const method = url.searchParams.get('method') === 'DELETE' && request.method === 'POST' ? 'DELETE' : request.method;
      const parts = route.split('/').filter(Boolean).map(decodeURIComponent);
      if (parts.length === 1 && parts[0] === 'state' && method === 'GET') return json(await engine.state());
      if (parts.length === 2 && parts[0] === 'metadata' && parts[1] === 'repair' && method === 'POST') {
        return json(await engine.startMetadataRepair(), 202);
      }
      if (parts[0] === 'uploads') {
        if (parts.length === 1 && method === 'POST') {
          let filename: string; try { filename = decodeURIComponent(request.headers.get('X-File-Name') ?? 'conversations.json'); } catch { throw new MigrationError('文件名无效。'); }
          return json(await engine.upload(await readBody(request, MAX_UPLOAD), filename), 201);
        }
        const id = parts[1]!;
        if (parts.length === 2 && method === 'GET') return json(await engine.uploadDetail(id));
        if (parts.length === 2 && method === 'DELETE') { await engine.removeUpload(id); return json({ ok: true }); }
        if (parts.length === 4 && parts[2] === 'conversations' && method === 'GET') return json(await engine.conversation(id, parts[3]!));
        if (parts.length === 3 && parts[2] === 'jobs' && method === 'POST') {
          const bytes = await readBody(request, 1024 * 1024); let options: unknown;
          try { options = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new MigrationError('导入选项不是有效 JSON。'); }
          return json(await engine.start(id, options as Parameters<MigrationEngine['start']>[1]), 202);
        }
      }
      if (parts[0] === 'jobs') {
        if (parts.length === 2 && method === 'GET') return json(engine.job(parts[1]!));
        if (parts.length === 3 && method === 'GET' && parts[2] === 'report') {
          const job = engine.job(parts[1]!);
          return new Response(JSON.stringify(reportData(job), null, 2), { headers: { 'Content-Type': 'application/json; charset=utf-8',
            'Content-Disposition': `attachment; filename="deepseek-migration-${job.id}.json"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
        }
        if (parts.length === 3 && method === 'POST' && parts[2] === 'cancel') return json(engine.cancel(parts[1]!));
        if (parts.length === 3 && method === 'POST' && parts[2] === 'retry') return json(await engine.retry(parts[1]!), 202);
        if (parts.length === 3 && method === 'POST' && parts[2] === 'clear') {
          const bytes = await readBody(request, 1024 * 1024); let options: unknown;
          try { options = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new MigrationError('清理选项不是有效 JSON。'); }
          if (!options || typeof options !== 'object' || Array.isArray(options) || !('mode' in options)) throw new MigrationError('清理选项无效，请重新选择。');
          return json(await engine.startCleanup(parts[1]!, options.mode as Parameters<MigrationEngine['startCleanup']>[1]), 202);
        }
      }
      return json({ error: '接口不存在。' }, 404);
    } catch (error) { return json({ error: error instanceof Error ? error.message : '操作失败。' }, error instanceof MigrationError ? error.status : 400); }
  };
}
