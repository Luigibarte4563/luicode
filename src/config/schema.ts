import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as YAML from 'yaml';
import { LuicodeConfig } from '../types';

export const DEFAULT_CONFIG: LuicodeConfig = {
  provider: 'litellm',
  models: {
    planner: 'anthropic/claude-3-5-sonnet-latest',
    coder: 'qwen/qwen-coder-plus',
    reviewer: 'deepseek/deepseek-chat',
    fallback: 'ollama/llama3.1'
  },
  fallbackOrder: ['litellm', 'anthropic', 'openai', 'openrouter', 'groq', 'deepseek', 'qwen', 'ollama'],
  auto: { mode: 'safe', workspaceOnly: true },
  git: { enabled: true },
  ui: { theme: 'dark', showActivity: true },
  terminal: {
    commandTimeoutMs: 120000,
    maxOutputBytes: 65536,
    whitelist: ['npm test', 'npm run build', 'npm run lint', 'npx tsc --noEmit', 'pnpm test', 'pnpm build', 'yarn test']
  },
  agent: { maxIterations: 12, autoFix: true, runTestsOnChange: true },
  providers: {},
  sandbox: {
    enabled: true,
    cpuTimeLimitMs: 60000,
    maxOutputBytes: 65536   // mirrors terminal.maxOutputBytes
  },
  vectorStore: {
    embeddingModel: 'local/minilm',
    chunkSize: 256,
    chunkOverlap: 32,
    maxFileSizeBytes: 1048576,
    topK: 5,
    indexDir: '.luicode/vector-index',
    extensions: ['.ts', '.js', '.py', '.json', '.md', '.txt'],
    excludeDirs: ['node_modules', '.git', '.luicode']
  },
  adapters: {}
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function deepMerge<T>(base: T, override: unknown): T {
  if (!isRecord(override)) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(override)) {
    if (v === undefined) continue;
    const cur = out[k];
    if (isRecord(cur) && isRecord(v)) {
      out[k] = deepMerge(cur, v);
    } else {
      out[k] = v;
    }
  }
  return out as T;
}

function parseFile(file: string): Record<string, unknown> | null {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    if (file.endsWith('.json')) return JSON.parse(raw) as Record<string, unknown>;
    const doc = YAML.parse(raw) as unknown;
    return isRecord(doc) ? doc : null;
  } catch {
    return null;
  }
}

function configCandidates(cwd: string): string[] {
  const home = os.homedir();
  const base = path.join(home, '.luicode');
  const project = path.join(cwd, '.luicode');
  return [
    path.join(base, 'settings.lock.json'),
    path.join(base, 'config.yaml'),
    path.join(base, 'config.json'),
    path.join(project, 'settings.lock.json'),
    path.join(project, 'config.yaml'),
    path.join(project, 'config.json')
  ];
}

export function loadConfig(cwd: string): LuicodeConfig {
  let cfg: LuicodeConfig = structuredClone(DEFAULT_CONFIG);
  for (const file of configCandidates(cwd)) {
    const parsed = parseFile(file);
    if (parsed) cfg = deepMerge(cfg, parsed);
  }
  return cfg;
}

export function configFilesFor(cwd: string): string[] {
  return configCandidates(cwd);
}

export function configUserFile(): string {
  return path.join(os.homedir(), '.luicode', 'config.yaml');
}

export function configProjectFile(cwd: string): string {
  return path.join(cwd, '.luicode', 'config.yaml');
}

export function settingsLockFile(cwd: string): string {
  return path.join(cwd, '.luicode', 'settings.lock.json');
}

export function userSettingsLockFile(): string {
  return path.join(os.homedir(), '.luicode', 'settings.lock.json');
}

export function readConfigFile(file: string): Record<string, unknown> | null {
  return parseFile(file);
}

export function writeConfigFile(file: string, data: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const out = file.endsWith('.json') ? JSON.stringify(data, null, 2) : YAML.stringify(data);
  fs.writeFileSync(file, out);
}