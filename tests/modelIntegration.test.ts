import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LuicodeConfig } from '../src/types';
import { DEFAULT_CONFIG, readConfigFile } from '../src/config/schema';
import {
  addProviderOverride,
  isKnownProvider,
  listProviderIntegrations,
  parseModelSpec,
  routingSummary,
  saveConfigChanges,
  setDefaultProvider,
  setTaskModel,
  testIntegration
} from '../src/llm/integration';

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'luicode-integration-test-'));
}

function baseConfig(): LuicodeConfig {
  return structuredClone(DEFAULT_CONFIG);
}

function fakeFetchOk(): typeof fetch {
  const fn = (async () => ({
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({ choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }], usage: {} })
  })) as unknown as typeof fetch;
  return fn;
}

describe('parseModelSpec', () => {
  it('splits provider/model specs', () => {
    expect(parseModelSpec('openai/gpt-4o-mini')).toEqual({ provider: 'openai', model: 'gpt-4o-mini' });
    expect(parseModelSpec('ollama')).toEqual({ provider: 'ollama', model: undefined });
  });
});

describe('routingSummary', () => {
  it('falls back to built-in defaults', () => {
    const s = routingSummary(baseConfig());
    expect(s.coder).toBe('qwen/qwen-coder-plus');
    expect(s.planner).toBe('anthropic/claude-3-5-sonnet-latest');
  });

  it('reflects configured per-task models', () => {
    const s = routingSummary(setTaskModel(baseConfig(), 'coder', 'ollama/llama3.1'));
    expect(s.coder).toBe('ollama/llama3.1');
  });
});

describe('listProviderIntegrations', () => {
  it('includes registry providers and marks custom ones', () => {
    const cfg = addProviderOverride(baseConfig(), 'myproxy', {
      baseUrl: 'http://proxy.test/v1',
      apiKey: 'sk-test',
      model: 'llama-3.1'
    });
    const rows = listProviderIntegrations(cfg);
    const openai = rows.find((r) => r.name === 'openai');
    expect(openai).toBeDefined();
    expect(openai!.kind).toBe('openai');
    expect(openai!.custom).toBe(false);
    expect(openai!.apiKeyEnv).toBe('OPENAI_API_KEY');
    const custom = rows.find((r) => r.name === 'myproxy');
    expect(custom).toBeDefined();
    expect(custom!.custom).toBe(true);
    expect(custom!.configured).toBe(true);
    expect(custom!.defaultModel).toBe('llama-3.1');
    expect(custom!.apiKeyEnv).toBe('[config.apiKey]');
  });

  it('reports whether an API key is set for key-based providers', () => {
    const rows = listProviderIntegrations(baseConfig());
    const mock = rows.find((r) => r.name === 'mock');
    expect(mock!.apiKeySet).toBe(false);
    expect(mock!.apiKeyEnv).toBeUndefined();
  });
});

describe('config mutations', () => {
  it('setDefaultProvider updates the provider without mutating the input', () => {
    const cfg = baseConfig();
    const next = setDefaultProvider(cfg, 'ollama');
    expect(next.provider).toBe('ollama');
    expect(cfg.provider).toBe('litellm');
  });

  it('setTaskModel updates a single task only', () => {
    const next = setTaskModel(baseConfig(), 'coder', 'ollama/llama3.1');
    expect(next.models.coder).toBe('ollama/llama3.1');
    expect(next.models.planner).toBe('anthropic/claude-3-5-sonnet-latest');
  });

  it('addProviderOverride preserves already-set keys', () => {
    const cfg = addProviderOverride(baseConfig(), 'openai', { baseUrl: 'http://x/v1' });
    const next = addProviderOverride(cfg, 'openai', { model: 'gpt-4o' });
    expect(next.providers.openai.baseUrl).toBe('http://x/v1');
    expect(next.providers.openai.model).toBe('gpt-4o');
  });
});

describe('saveConfigChanges', () => {
  it('writes a project-local config file', () => {
    const dir = tmpdir();
    const file = saveConfigChanges(
      { provider: 'ollama', models: { coder: 'ollama/llama3.1' } },
      { scope: 'local', cwd: dir }
    );
    expect(file).toBe(path.join(dir, '.luicode', 'config.yaml'));
    expect(fs.existsSync(file)).toBe(true);
    const read = readConfigFile(file);
    expect(read!.provider).toBe('ollama');
    expect((read!.models as Record<string, string>).coder).toBe('ollama/llama3.1');
  });

  it('merges provider overrides into an existing config file', () => {
    const dir = tmpdir();
    const file = path.join(dir, '.luicode', 'config.yaml');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'provider: openai\nproviders:\n  myproxy:\n    baseUrl: http://old/v1\n');
    saveConfigChanges(
      { provider: 'myproxy', providers: { myproxy: { baseUrl: 'http://new/v1', model: 'x' } } },
      { scope: 'local', cwd: dir }
    );
    const read = readConfigFile(file);
    expect(read!.provider).toBe('myproxy');
    const provs = read!.providers as Record<string, { baseUrl?: string; model?: string }>;
    expect(provs.myproxy.baseUrl).toBe('http://new/v1');
    expect(provs.myproxy.model).toBe('x');
  });
});

describe('isKnownProvider', () => {
  it('recognizes registry and configured providers', () => {
    const cfg = addProviderOverride(baseConfig(), 'internal', { baseUrl: 'http://internal/v1' });
    expect(isKnownProvider(cfg, 'anthropic')).toBe(true);
    expect(isKnownProvider(cfg, 'internal')).toBe(true);
    expect(isKnownProvider(cfg, 'nope')).toBe(false);
  });
});

describe('testIntegration', () => {
  it('returns ok when the endpoint answers', async () => {
    const cfg = addProviderOverride(baseConfig(), 'myproxy', { baseUrl: 'http://proxy.test/v1' });
    const result = await testIntegration(cfg, 'myproxy/llama-3.1', { fetch: fakeFetchOk() });
    expect(result.ok).toBe(true);
    expect(result.provider).toBe('myproxy');
    expect(result.model).toBe('llama-3.1');
    expect(typeof result.latencyMs).toBe('number');
  });

  it('reports failures with a diagnostic message', async () => {
    const cfg = addProviderOverride(baseConfig(), 'myproxy', { baseUrl: 'http://proxy.test/v1' });
    const failing = (async () => ({
      ok: false,
      status: 401,
      text: async () => 'unauthorized'
    })) as unknown as typeof fetch;
    const result = await testIntegration(cfg, 'myproxy/llama-3.1', { fetch: failing });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/401/);
  });

  it('works for an unregistered provider given a baseUrl override', async () => {
    const result = await testIntegration(baseConfig(), 'random/model-x', {
      fetch: fakeFetchOk(),
      baseUrl: 'http://proxy.test/v1'
    });
    expect(result.ok).toBe(true);
    expect(result.model).toBe('model-x');
  });

  it('uses the provider default model when none is supplied', async () => {
    const result = await testIntegration(baseConfig(), 'openai', { fetch: fakeFetchOk() });
    expect(result.ok).toBe(true);
    expect(result.model).toBe('gpt-4o-mini');
  });
});