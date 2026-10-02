import type { ImportJob } from './types.js';
/** A portable report contains outcome metadata, never conversation or account contents. */
export function reportData(job: ImportJob) {
  return { version: 1, generatedAt: new Date().toISOString(), jobId: job.id, status: job.status,
    workspaceId: job.request.workspaceId, branchMode: job.request.branchMode, includeReasoning: job.request.includeReasoning,
    total: job.total, imported: job.imported, skipped: job.skipped, failed: job.failed,
    results: job.results.map(({ sourceId, branchId, sessionId, workspaceId, title, messageCount, status, error }) =>
      ({ sourceId, branchId, sessionId, workspaceId, title, messageCount, status, ...(error ? { error } : {}) })),
  };
}
