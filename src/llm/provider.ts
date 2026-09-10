import { ChatOptions, ModelMessage, ModelReply, ProviderInfo, ProviderKind } from '../types';

export interface LLMProvider {
  readonly info: ProviderInfo;
  chat(messages: ModelMessage[], options?: ChatOptions): Promise<ModelReply>;
}

export const PROVIDER_REGISTRY: Record<string, ProviderInfo> = {
  anthropic: { name: 'anthropic', kind: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKeyEnv: 'ANTHROPIC_API_KEY' },
  openai: { name: 'openai', kind: 'openai', baseUrl: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY' },
  gemini: { name: 'gemini', kind: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', apiKeyEnv: 'GEMINI_API_KEY' },
  openrouter: { name: 'openrouter', kind: 'openai', baseUrl: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY', freeTier: true },
  groq: { name: 'groq', kind: 'openai', baseUrl: 'https://api.groq.com/openai/v1', apiKeyEnv: 'GROQ_API_KEY', freeTier: true },
  deepseek: { name: 'deepseek', kind: 'openai', baseUrl: 'https://api.deepseek.com/v1', apiKeyEnv: 'DEEPSEEK_API_KEY', freeTier: true },
  qwen: { name: 'qwen', kind: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKeyEnv: 'DASHSCOPE_API_KEY', freeTier: true },
  together: { name: 'together', kind: 'openai', baseUrl: 'https://api.together.xyz/v1', apiKeyEnv: 'TOGETHER_API_KEY', freeTier: true },
  ollama: { name: 'ollama', kind: 'ollama', baseUrl: 'http://localhost:11434', local: true },
  vllm: { name: 'vllm', kind: 'openai', baseUrl: 'http://localhost:8000/v1', local: true },
  github: { name: 'github', kind: 'openai', baseUrl: 'https://models.inference.ai.azure.com', apiKeyEnv: 'GITHUB_TOKEN', freeTier: true },
  litellm: { name: 'litellm', kind: 'openai', baseUrl: 'http://localhost:4000/v1', local: true },
  mock: { name: 'mock', kind: 'openai', baseUrl: 'http://localhost:1/v1', local: true }
};

export function isFreeProvider(name: string): boolean {
  return PROVIDER_REGISTRY[name]?.freeTier === true || PROVIDER_REGISTRY[name]?.local === true;
}

const DEFAULT_MODELS: Record<string, string> = {
  anthropic: 'claude-3-5-sonnet-latest',
  openai: 'gpt-4o-mini',
  gemini: 'gemini-1.5-flash',
  openrouter: 'meta-llama/llama-3.3-70b-instruct',
  groq: 'llama-3.3-70b-versatile',
  deepseek: 'deepseek-chat',
  qwen: 'qwen-coder-plus',
  together: 'meta-llama/llama-3.3-70b-instruct',
  ollama: 'llama3.1',
  vllm: 'default',
  github: 'gpt-4o-mini',
  litellm: 'gpt-4o-mini',
  mock: 'mock'
};

export function resolveModel(providerName: string, override?: string): string {
  return override ?? DEFAULT_MODELS[providerName] ?? 'gpt-4o-mini';
}

export function apiKeyFor(info: ProviderInfo): string | undefined {
  if (!info.apiKeyEnv) return undefined;
  return process.env[info.apiKeyEnv] || undefined;
}