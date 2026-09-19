export type StackConfidence = 'detected' | 'guessed';

export type AutonomyLevel = 'manual' | 'safe' | 'full';

export type ProviderKind = 'openai' | 'anthropic' | 'ollama' | 'gemini';

export type TaskKind = 'planner' | 'coder' | 'reviewer' | 'fallback';

export interface ProviderInfo {
  name: string;
  kind: ProviderKind;
  baseUrl?: string;
  apiKeyEnv?: string;
  model?: string;
  freeTier?: boolean;
  local?: boolean;
}

export interface AutoConfig {
  mode: AutonomyLevel;
  workspaceOnly: boolean;
}

export interface UiConfig {
  theme: 'dark' | 'light';
  showActivity: boolean;
}

export interface TerminalConfig {
  whitelist: string[];
  commandTimeoutMs: number;
  maxOutputBytes: number;
}

export interface AgentConfig {
  maxIterations: number;
  autoFix: boolean;
  runTestsOnChange: boolean;
}

export interface ProviderConfig {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
}

export interface SandboxConfig {
  enabled: boolean;
  cpuTimeLimitMs: number;
  maxOutputBytes: number;
}

export interface AdapterOverrideConfig {
  install?: string;
  installOne?: string;
  test?: string;
  build?: string;
  scaffold?: string;
  lockfile?: string;
  verify?: string;
  registry?: string;
}

export interface VectorStoreConfig {
  embeddingModel: string;
  chunkSize: number;
  chunkOverlap: number;
  maxFileSizeBytes: number;
  topK: number;
  extensions: string[];
  excludeDirs: string[];
}

export interface LuicodeConfig {
  provider: string;
  models: Partial<Record<TaskKind, string>>;
  fallbackOrder: string[];
  auto: AutoConfig;
  git: { enabled: boolean };
  ui: UiConfig;
  terminal: TerminalConfig;
  agent: AgentConfig;
  providers: Record<string, ProviderConfig>;
  sandbox: SandboxConfig;
  vectorStore: VectorStoreConfig;
  adapters: Record<string, AdapterOverrideConfig>;
}

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

export interface ChatMessage {
  role: MessageRole;
  content: string;
  name?: string;
  timestamp: number;
}

export interface ModelMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export interface ModelReply {
  content: string;
  finishReason?: string;
  usage?: ModelUsage;
}

export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export type PlanStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'editing'
  | 'implemented'
  | 'cancelled';

export type StepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export type StepType = 'scaffold' | 'install' | 'edit' | 'run' | 'review';

export type PlanTier = 'safe' | 'modify' | 'modify+network' | 'blocked';

export interface PlanStep {
  id: string;
  title: string;
  status: StepStatus;
  stepType?: StepType;
  action?: string;
  why?: string;
  risk?: PlanTier;
}

export interface Plan {
  id: string;
  task: string;
  analysis: string;
  filesToCreate: string[];
  filesToModify: string[];
  steps: PlanStep[];
  tests: string[];
  risk: 'low' | 'medium' | 'high';
  status: PlanStatus;
  createdAt: number;
}

export type ToolStatus = 'running' | 'ok' | 'error';

export interface ToolCall {
  id: string;
  name: string;
  args: string;
  status: ToolStatus;
  output?: string;
  error?: string;
  startedAt: number;
  endedAt?: number;
}

export interface FileChange {
  path: string;
  action: 'create' | 'modify' | 'delete' | 'rename' | 'move';
}

export type CommandRisk = 'safe' | 'modify' | 'blocked';

export interface CommandRecord {
  command: string;
  stdout: string;
  stderr: string;
  code: number | null;
  durationMs: number;
  risk?: CommandRisk;
}

export interface TestResult {
  command: string;
  passed: boolean;
  summary: string;
  output?: string;
}

export interface Session {
  id: string;
  createdAt: number;
  updatedAt: number;
  task: string;
  mode: AutonomyLevel;
  messages: ChatMessage[];
  plan?: Plan;
  actions: ToolCall[];
  fileChanges: FileChange[];
  commands: CommandRecord[];
  testResults: TestResult[];
  errors: string[];
  finalSummary?: string;
  status: 'active' | 'done' | 'canceled';
  workingMemoryPath?: string;
  checkpoints: string[];
  ragEnabled: boolean;
}

export type AgentEventType =
  | 'status'
  | 'message'
  | 'comment'
  | 'tool'
  | 'plan'
  | 'test'
  | 'command'
  | 'error'
  | 'file'
  | 'diff'
  | 'usage'
  | 'summary'
  | 'approval'
  | 'thought'
  | 'checkpoint';

export interface AgentEvent {
  type: AgentEventType;
  timestamp: number;
  text?: string;
  tool?: ToolCall;
  plan?: Plan;
  step?: PlanStep;
  test?: TestResult;
  command?: CommandRecord;
  file?: FileChange;
  diff?: DiffEntry;
  usage?: ModelUsage;
  error?: Error;
  summary?: string;
  approved?: boolean;
  checkpointSha?: string;
  stepTitle?: string;
}

export type ApprovalKind = 'plan' | 'fileChanges' | 'command';

export interface AskApproval {
  kind: ApprovalKind;
  title: string;
  detail: string;
  items: string[];
}

export interface ApprovalDecision {
  approved: boolean;
  steps?: string[];
}

export interface ModelRouterLike {
  complete(task: TaskKind, messages: ModelMessage[], options?: ChatOptions): Promise<ModelReply>;
}

export type FileToolKind =
  | 'read_file'
  | 'write_file'
  | 'edit_file'
  | 'create_file'
  | 'delete_file'
  | 'rename_file'
  | 'move_file'
  | 'list_directory'
  | 'search_files'
  | 'search_code';

export interface DiffResult {
  actions: DiffAction[];
  addedLines: string[];
  removedLines: string[];
  additions: number;
  deletions: number;
}

export interface DiffEntry {
  path: string;
  lines: string[];
  additions: number;
  deletions: number;
}

export type DiffAction =
  | { type: 'equal'; text: string }
  | { type: 'add'; text: string }
  | { type: 'remove'; text: string };

export interface FileDraft {
  path: string;
  content: string;
}

export interface ToolContext {
  workspace: unknown;
  agent: unknown;
  config: LuicodeConfig;
  permission: unknown;
}

export interface FileOperation {
  action: 'create' | 'modify' | 'delete';
  path: string;
  content?: string; // for create/modify
  oldContent?: string; // for modify (optional, for diff)
}

export interface MultiFileOutput {
  operations: FileOperation[];
  summary?: string;
}