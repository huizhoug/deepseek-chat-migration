export type BranchMode = 'all' | 'latest';

export interface SourceAttachment {
  name: string;
  sourceId?: string;
  available: boolean;
}

export interface SourceCitation {
  title: string;
  url?: string;
  snippet?: string;
}

export interface ConversationMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  reasoning: string;
  timestamp: number;
  model?: string;
  attachments: SourceAttachment[];
  citations: SourceCitation[];
}

export interface ConversationBranch {
  id: string;
  messages: ConversationMessage[];
  updatedAt: number;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  branches: ConversationBranch[];
  warnings: string[];
  attachmentCount: number;
}

export interface ParsedExport {
  conversations: Conversation[];
  warnings: string[];
  conversationsJson: Uint8Array;
}

export interface ConversationSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  branchCount: number;
  attachmentCount: number;
  warnings: string[];
  imported: boolean;
}

export interface WorkspaceSummary {
  id: string;
  title: string;
  path: string;
}

export interface ImportRequest {
  workspaceId: string;
  conversationIds: string[];
  branchMode: BranchMode;
  includeReasoning: boolean;
}

export interface ImportedSession {
  sessionId: string;
  workspaceId: string;
  title: string;
  messageCount: number;
}

export interface ImportResult extends ImportedSession {
  sourceId: string;
  branchId: string;
  status: 'imported' | 'skipped' | 'failed';
  error?: string;
}

export interface ImportJob {
  id: string;
  status: 'running' | 'completed' | 'cancelled' | 'failed' | 'interrupted';
  total: number;
  processed: number;
  imported: number;
  skipped: number;
  failed: number;
  currentTitle: string;
  startedAt: number;
  finishedAt?: number;
  results: ImportResult[];
  request: ImportRequest;
  error?: string;
}

export interface UploadSummary {
  id: string;
  filename: string;
  conversationCount: number;
  branchCount: number;
  messageCount: number;
  warnings: string[];
}

export interface ImporterState {
  version: string;
  compatible: boolean;
  compatibilityMessage?: string;
  workspaces: WorkspaceSummary[];
  uploads: UploadSummary[];
  jobs: ImportJob[];
  metadataRepair?: MetadataRepairState;
  cleanup?: CleanupTask;
}

export type CleanupMode = 'records' | 'sessions-and-records';

export interface CleanupTask {
  id: string;
  jobId: string;
  mode: CleanupMode;
  status: 'running' | 'completed' | 'interrupted';
  total: number;
  processed: number;
  deleted: number;
  missing: number;
  failed: number;
  results: Array<{ sessionId: string; status: 'deleted' | 'missing' | 'failed'; error?: string }>;
  recordsCleared: boolean;
  startedAt: number;
  finishedAt?: number;
  error?: string;
}

export interface MetadataRepairState {
  status: 'running' | 'completed';
  total: number;
  processed: number;
  repaired: number;
  missing: number;
  failed: number;
  errors: Array<{ sessionId: string; error: string }>;
  startedAt: number;
  finishedAt?: number;
}

export interface HarnessImportInput {
  conversation: Conversation;
  branch: ConversationBranch;
  workspaceId: string;
  includeReasoning: boolean;
  title: string;
  sessionId: string;
}

export interface HarnessAdapter {
  listWorkspaces(): Promise<WorkspaceSummary[]>;
  importConversation(input: HarnessImportInput): Promise<ImportedSession>;
  sessionExists(sessionId: string): Promise<boolean>;
  recoverConversation?(input: HarnessImportInput): Promise<ImportedSession | undefined>;
  /** Rebuild sidebar projections from the current native history without changing it. */
  repairSessionMetadata?(sessionId: string): Promise<boolean>;
  /** Permanently remove a ledger-owned session; reject live or owned sessions. */
  deleteImportedSession?(sessionId: string): Promise<boolean>;
  /** Reconcile optional search projections once after a deletion batch. */
  finalizeSessionDeletion?(): Promise<void>;
}
