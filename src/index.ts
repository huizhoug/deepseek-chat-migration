import type { Context } from '@deepseek-ai/cordis';
import { dshHomePath } from '@deepseek-ai/dsh-home-paths';
import type {} from '@deepseek-ai/dsh-client-connection';
import { createHarnessAdapter } from './harness.js';
import { MigrationEngine, VERSION } from './engine.js';
import { API_PATH, UPLOAD_PATH, createApiHandler } from './http.js';

export const name = 'deepseek-chat-migration';
export const inject = ['connection', 'sessions', 'agents', 'sessionPersistence', 'workspaceRegistry', 'sessionProjections', 'sessionProjectionCache', 'sessionTitle', 'storageDomain', 'sessionQuery'];
export async function apply(ctx: Context): Promise<void> {
  const engine = new MigrationEngine(dshHomePath('plugin-data', name), createHarnessAdapter(ctx));
  let initError: string | undefined;
  try { await engine.init(); } catch (error) { initError = error instanceof Error ? error.message : '迁移数据无法读取。'; }
  const handler = initError ? async (request: Request): Promise<Response> => {
    const isState = request.method === 'GET' && new URL(request.url).searchParams.get('route') === '/state';
    return Response.json(isState ? { version: VERSION, compatible: false, compatibilityMessage: initError, workspaces: [], uploads: [], jobs: [] } : { error: initError }, { status: isState ? 200 : 503, headers: { 'Cache-Control': 'no-store' } });
  } : createApiHandler(engine);
  ctx.connection.fetch.register({ path: API_PATH, methods: ['GET', 'POST'], requestBody: 'buffered', fetch: handler });
  ctx.connection.fetch.register({ path: UPLOAD_PATH, methods: ['POST'], requestBody: 'streaming', fetch: handler });
  ctx.effect(() => () => engine.close(), 'deepseek-chat-migration: finish current write and close');
}
