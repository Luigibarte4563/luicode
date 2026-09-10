import { LuicodeConfig, ProviderInfo } from '../types';
import { AnthropicClient, ModelClient, MockProvider, OllamaClient } from './clients';
import { LLMProvider, PROVIDER_REGISTRY, apiKeyFor, resolveModel } from './provider';

export function providerInfo(name: string, config: LuicodeConfig): ProviderInfo {
  const override = config.providers?.[name];
  const base = PROVIDER_REGISTRY[name];
  const info: ProviderInfo = base
    ? { ...base }
    : { name, kind: 'openai', baseUrl: 'http://localhost:4000/v1' };
  if (override?.baseUrl) info.baseUrl = override.baseUrl;
  if (override?.apiKey) info.apiKeyEnv = 'LUICODE_CONFIG_KEY';
  return info;
}

export function createProvider(name: string, model: string | undefined, config: LuicodeConfig): LLMProvider {
  const info = providerInfo(name, config);
  if (name === 'mock') return new MockProvider();
  const modelName = resolveModel(name, model ?? config.providers?.[name]?.model);
  const apiKey =
    info.name === 'LUICODE_CONFIG_KEY'
      ? config.providers?.[name]?.apiKey
      : apiKeyFor(info) ?? config.providers?.[name]?.apiKey;
  switch (info.kind) {
    case 'anthropic':
      return new AnthropicClient(info, modelName, { apiKey });
    case 'ollama':
      return new OllamaClient(info, modelName);
    case 'gemini':
    case 'openai':
    default:
      return new ModelClient(info, modelName, { apiKey });
  }
}