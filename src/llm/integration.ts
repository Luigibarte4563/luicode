import * as fs from 'fs';
import { LuicodeConfig, ModelReply, ProviderConfig, ProviderInfo, ProviderKind, TaskKind } from '../types';
import {
  DEFAULT_CONFIG,
  configProjectFile,
  configUserFile,
  readConfigFile,
  settingsLockFile,
  writeConfigFile
} from '../config/schema';
import { createProvider } from './factory';
import { PROVIDER_REGISTRY, apiKeyFor, resolveModel } from './provider';

export const TASK_KINDS: TaskKind[] = ['planner', 'coder', 'reviewer', 'fallback'];

export interface ModelSpec {
  provider: string;
  model?: string;
}

export function parseModelSpec(spec: string): ModelSpec {
  const idx = spec.indexOf('/');
  if (idx > 0 && spec[idx + 1] !== '/') {
    return { provider: spec.slice(0, idx), model: spec.slice(idx + 1) };
  }
  return { provider: spec };
}

export function formatModelSpec(spec: ModelSpec): string {
  return spec.model ? `${spec.provider}/${spec.model}` : spec.provider;
}

export function defaultModelForTask(task: TaskKind): string {
  return DEFAULT_CONFIG.models[task] ?? 'mock';
}

export function routingSummary(config: LuicodeConfig): Partial<Record<TaskKind, string>> {
  const out: Partial<Record<TaskKind, string>> = {};
  for (const task of TASK_KINDS) {
    out[task] = config.models?.[task] ?? defaultModelForTask(task);
  }
  return out;
}

export interface ProviderIntegration {
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  apiKeyEnv?: string;
  apiKeySet: boolean;
  defaultModel: string;
  local: boolean;
  freeTier: boolean;
  custom: boolean;
  configured: boolean;
}

export function listProviderIntegrations(config: LuicodeConfig): ProviderIntegration[] {
  const names = new Set<string>([...Object.keys(PROVIDER_REGISTRY), ...Object.keys(config.providers ?? {})]);
  const out: ProviderIntegration[] = [];
  for (const name of Array.from(names).sort()) {
    const base = PROVIDER_REGISTRY[name];
    const override = config.providers?.[name];
    const info: ProviderInfo = base
      ? { ...base }
      : { name, kind: 'openai', baseUrl: 'http://localhost:4000/v1' };
    if (override?.baseUrl) info.baseUrl = override.baseUrl;
    const apiKeySet = override?.apiKey ? true : apiKeyFor(info) !== undefined;
    out.push({
      name,
      kind: info.kind,
      baseUrl: info.baseUrl ?? '',
      apiKeyEnv: override?.apiKey ? '[config.apiKey]' : info.apiKeyEnv,
      apiKeySet,
      defaultModel: resolveModel(name, override?.model),
      local: Boolean(info.local),
      freeTier: Boolean(info.freeTier || info.local),
      custom: !base,
      configured: Boolean(override)
    });
  }
  return out;
}

function pickDefined<T>(o: T): Partial<T> {
  const src = o as Record<string, unknown>;
  const out: Partial<T> = {};
  for (const k of Object.keys(src)) {
    const v = src[k];
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

export function setDefaultProvider(config: LuicodeConfig, provider: string): LuicodeConfig {
  const next = structuredClone(config);
  next.provider = provider;
  return next;
}

export function setTaskModel(config: LuicodeConfig, task: TaskKind, spec: string): LuicodeConfig {
  const next = structuredClone(config);
  next.models = { ...next.models, [task]: spec };
  return next;
}

export interface ProviderOverrideOptions {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
}

export function addProviderOverride(
  config: LuicodeConfig,
  name: string,
  opts: ProviderOverrideOptions
): LuicodeConfig {
  const next = structuredClone(config);
  const prev: ProviderConfig = next.providers?.[name] ?? {};
  next.providers = {
    ...(next.providers ?? {}),
    [name]: { ...prev, ...pickDefined(opts) }
  };
  return next;
}

export interface ConfigChanges {
  provider?: string;
  models?: Partial<Record<TaskKind, string>>;
  providers?: Record<string, ProviderConfig>;
}

export type ConfigScope = 'user' | 'local';

export function saveConfigChanges(
  changes: ConfigChanges,
  opts: { scope?: ConfigScope; cwd?: string } = {}
): string {
  const scope = opts.scope ?? 'user';
  const cwd = opts.cwd ?? process.cwd();
  let file: string;
  if (scope === 'local') {
    // Prefer the model-lock pattern (.luicode/settings.lock.json) when it exists.
    file = fs.existsSync(settingsLockFile(cwd)) ? settingsLockFile(cwd) : configProjectFile(cwd);
  } else {
    file = configUserFile();
  }
  const existing = readConfigFile(file) ?? {};
  const merged: Record<string, unknown> = { ...existing };
  if (changes.provider !== undefined) merged.provider = changes.provider;
  if (changes.models !== undefined) merged.models = changes.models;
  if (changes.providers !== undefined) {
    const cur = merged.providers;
    merged.providers = isPlainRecord(cur) ? { ...cur, ...changes.providers } : { ...changes.providers };
  }
  writeConfigFile(file, merged);
  return file;
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export interface IntegrationTestOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export interface IntegrationTestResult {
  ok: boolean;
  provider: string;
  model: string;
  latencyMs: number;
  reply: string;
  error?: string;
}

const PING_PROMPT = 'Reply with the single word OK.';

export async function testIntegration(
  config: LuicodeConfig,
  spec: string,
  opts: IntegrationTestOptions = {}
): Promise<IntegrationTestResult> {
  const parsed = parseModelSpec(spec);
  const model = opts.model ?? parsed.model ?? resolveModel(parsed.provider);
  const testConfig = addProviderOverride(config, parsed.provider, {
    baseUrl: opts.baseUrl,
    apiKey: opts.apiKey,
    model
  });
  const provider = createProvider(parsed.provider, model, testConfig, { fetch: opts.fetch });
  const started = Date.now();
  let reply: ModelReply;
  try {
    reply = await provider.chat([{ role: 'user', content: PING_PROMPT }], {
      timeoutMs: opts.timeoutMs ?? 20000,
      maxTokens: 8,
      temperature: 0
    });
  } catch (err) {
    return {
      ok: false,
      provider: parsed.provider,
      model,
      latencyMs: Date.now() - started,
      reply: '',
      error: err instanceof Error ? err.message : String(err)
    };
  }
  return {
    ok: true,
    provider: parsed.provider,
    model,
    latencyMs: Date.now() - started,
    reply: reply.content.slice(0, 120)
  };
}

export function isKnownProvider(config: LuicodeConfig, name: string): boolean {
  return Boolean(PROVIDER_REGISTRY[name] ?? config.providers?.[name]);
}