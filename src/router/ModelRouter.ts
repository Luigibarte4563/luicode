import { ChatOptions, LuicodeConfig, ModelMessage, ModelReply, ModelRouterLike, TaskKind } from '../types';
import { createProvider } from '../llm/factory';
import { LLMProvider } from '../llm/provider';
import { DEFAULT_CONFIG } from '../config/schema';

const ROUTE_DEFAULTS: Record<TaskKind, string> = {
  planner: DEFAULT_CONFIG.models.planner as string,
  coder: DEFAULT_CONFIG.models.coder as string,
  reviewer: DEFAULT_CONFIG.models.reviewer as string,
  fallback: DEFAULT_CONFIG.models.fallback as string
};

function parseSpec(spec: string): { provider: string; model?: string } {
  const idx = spec.indexOf('/');
  if (idx > 0 && spec[idx + 1] !== '/') {
    return { provider: spec.slice(0, idx), model: spec.slice(idx + 1) };
  }
  return { provider: spec };
}

export class ModelRouter implements ModelRouterLike {
  private providers: Map<string, LLMProvider> = new Map();

  constructor(private config: LuicodeConfig) {}

  specFor(task: TaskKind): string {
    return this.config.models?.[task] ?? ROUTE_DEFAULTS[task] ?? this.config.models.coder ?? 'mock';
  }

  isMock(task: TaskKind): boolean {
    const spec = parseSpec(this.specFor(task));
    return spec.provider === 'mock' || this.config.provider === 'mock';
  }

  private getProvider(name: string, model?: string): LLMProvider {
    const key = `${name}:${model ?? ''}`;
    if (!this.providers.has(key)) {
      this.providers.set(key, createProvider(name, model, this.config));
    }
    return this.providers.get(key) as LLMProvider;
  }

  route(task: TaskKind): { name: string; provider: LLMProvider } {
    const spec = parseSpec(this.specFor(task));
    return { name: spec.provider, provider: this.getProvider(spec.provider, spec.model) };
  }

  async complete(task: TaskKind, messages: ModelMessage[], options: ChatOptions = {}): Promise<ModelReply> {
    const primary = parseSpec(this.specFor(task));

    const baseOrder = this.config.fallbackOrder?.length ? this.config.fallbackOrder : DEFAULT_CONFIG.fallbackOrder;
    const order = [primary.provider, ...baseOrder].filter(
      (name, i, arr) => arr.indexOf(name) === i && name !== 'mock'
    );
    if (primary.provider === 'mock' || this.config.provider === 'mock' || !order.length) {
      const mock = this.getProvider('mock');
      return mock.chat(messages, options);
    }

    let lastError: Error | undefined;
    for (const name of order) {
      const model =
        name === primary.provider
          ? primary.model
          : parseSpec(this.config.models?.[task] ?? '').provider === name
            ? parseSpec(this.config.models?.[task] as string).model
            : undefined;
      const provider = this.getProvider(name, model);
      try {
        return await provider.chat(messages, options);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (name === primary.provider) continue;
      }
    }
    if (lastError) {
      throw new Error(
        `All LLM providers unavailable (${order.join(', ')}). Last error: ${lastError.message}`
      );
    }
    const mock = this.getProvider('mock');
    return mock.chat(messages, options);
  }
}