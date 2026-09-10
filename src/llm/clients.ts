import { ChatOptions, ModelMessage, ModelReply, ProviderInfo } from '../types';
import { LLMProvider } from './provider';

export interface HttpClientConfig {
  fetch?: typeof fetch;
}

class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

export class ModelClient implements LLMProvider {
  readonly info: ProviderInfo;
  private model: string;
  private apiKey?: string;
  private fetcher: typeof fetch;
  private headers: Record<string, string>;

  constructor(
    info: ProviderInfo,
    model: string,
    opts?: {
      apiKey?: string;
      extraHeaders?: Record<string, string>;
      fetch?: typeof fetch;
    }
  ) {
    this.info = info;
    this.model = model;
    this.apiKey = opts?.apiKey;
    this.fetcher = opts?.fetch ?? globalThis.fetch;
    this.headers = { 'Content-Type': 'application/json', ...(opts?.extraHeaders ?? {}) };
    if (this.apiKey) this.headers.Authorization = `Bearer ${this.apiKey}`;
  }

  async chat(messages: ModelMessage[], options: ChatOptions = {}): Promise<ModelReply> {
    const url = `${stripTrailingSlash(this.info.baseUrl ?? '')}/chat/completions`;
    const payload = {
      model: this.model,
      messages,
      temperature: options.temperature ?? 0.2,
      max_tokens: options.maxTokens ?? 2048,
      stream: false
    };
    let res: Response;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 120000);
      if (options.signal) {
        options.signal.addEventListener('abort', () => controller.abort());
      }
      res = await this.fetcher(url, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify(payload),
        signal: controller.signal
      }).finally(() => clearTimeout(timeout));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`LUITL error (${this.info.name}): ${msg}`);
    }
    const text = await res.text();
    if (!res.ok) {
      throw new HttpError(`LUITL error (${this.info.name}): HTTP ${res.status} — ${text.slice(0, 240)}`, res.status);
    }
    const data = JSON.parse(text) as {
      choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const content = data.choices?.[0]?.message?.content ?? '';
    return {
      content,
      finishReason: data.choices?.[0]?.finish_reason,
      usage: {
        inputTokens: data.usage?.prompt_tokens,
        outputTokens: data.usage?.completion_tokens
      }
    };
  }
}

export class AnthropicClient implements LLMProvider {
  readonly info: ProviderInfo;
  private model: string;
  private apiKey?: string;
  private fetcher: typeof fetch;

  constructor(info: ProviderInfo, model: string, opts?: { apiKey?: string; fetch?: typeof fetch }) {
    this.info = info;
    this.model = model;
    this.apiKey = opts?.apiKey;
    this.fetcher = opts?.fetch ?? globalThis.fetch;
  }

  async chat(messages: ModelMessage[], options: ChatOptions = {}): Promise<ModelReply> {
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
    const rest = messages.filter((m) => m.role !== 'system');
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: options.maxTokens ?? 2048,
      messages: rest
    };
    if (system) body.system = system;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 120000);
      if (options.signal) options.signal.addEventListener('abort', () => controller.abort());
      const res = await this.fetcher(`${stripTrailingSlash(this.info.baseUrl ?? '')}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey ?? '',
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify(body),
        signal: controller.signal
      }).finally(() => clearTimeout(timeout));
      const text = await res.text();
      if (!res.ok) {
        throw new HttpError(`LUI-ANTHROPIC error: HTTP ${res.status} — ${text.slice(0, 240)}`, res.status);
      }
      const data = JSON.parse(text) as {
        content?: Array<{ type?: string; text?: string }>;
        stop_reason?: string;
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      const content = (data.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
      return {
        content,
        finishReason: data.stop_reason,
        usage: { inputTokens: data.usage?.input_tokens, outputTokens: data.usage?.output_tokens }
      };
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new Error(`LUI-ANTHROPIC error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

export class OllamaClient implements LLMProvider {
  readonly info: ProviderInfo;
  private model: string;
  private fetcher: typeof fetch;

  constructor(info: ProviderInfo, model: string, opts?: { fetch?: typeof fetch }) {
    this.info = info;
    this.model = model;
    this.fetcher = opts?.fetch ?? globalThis.fetch;
  }

  async chat(messages: ModelMessage[], options: ChatOptions = {}): Promise<ModelReply> {
    const url = `${stripTrailingSlash(this.info.baseUrl ?? '')}/api/chat`;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 240000);
      if (options.signal) options.signal.addEventListener('abort', () => controller.abort());
      const res = await this.fetcher(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.model, messages, stream: false }),
        signal: controller.signal
      }).finally(() => clearTimeout(timeout));
      const text = await res.text();
      if (!res.ok) {
        throw new HttpError(`LUI-OLLAMA error: HTTP ${res.status} — ${text.slice(0, 240)}`, res.status);
      }
      const data = JSON.parse(text) as { message?: { content?: string }; done_reason?: string };
      return { content: data.message?.content ?? '', finishReason: data.done_reason };
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new Error(`LUI-OLLAMA error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

export class MockProvider implements LLMProvider {
  readonly info: ProviderInfo = { name: 'mock', kind: 'openai' };
  async chat(messages: ModelMessage[]): Promise<ModelReply> {
    const last = [...messages].reverse().find((m) => m.role === 'user');
    return { content: this.respond(last?.content ?? '') };
  }
  private respond(prompt: string): string {
    const low = prompt.toLowerCase();
    if (low.includes('plan') || low.includes('analysis') || low.includes('implementation plan')) {
      return this.planResponse(prompt);
    }
    if (low.includes('tool call') || low.includes('action:')) {
      return this.actionResponse(prompt);
    }
    if (low.includes('fix') || low.includes('error')) {
      return this.fixResponse();
    }
    return 'Understood. I will inspect the project and prepare an implementation plan.';
  }
  private findLines(s: string, keyword: string): string {
    return s
      .split('\n')
      .filter((l) => l.toLowerCase().includes(keyword))
      .join('\n');
  }
  private planResponse(prompt: string): string {
    const hint = prompt.split('\n').pop()?.trim() ?? 'the feature';
    const sources = this.findLines(prompt, '---');
    return `PLAN_START
TASK: ${hint}
PROJECT ANALYSIS:
${sources || '— React/TypeScript project, npm workspaces, Jest for testing —'}
STEPS:
1. Analyze existing architecture and locate integration points
2. Implement the requested feature with clean, typed code
3. Add a minimal test covering the new behavior
4. Run the test suite and fix any failures
5. Run the build and verify it compiles
FILES_TO_CREATE:
src/features/${hint.replace(/\s+/g, '-').replace(/[^a-z0-9-_]/gi, '').slice(0, 40) || 'feature'}/index.ts
FILES_TO_MODIFY:
README.md
TESTS:
npm test
PLAN_END`.replace(/## /g, '');
  }
  private actionResponse(prompt: string): string {
    const mt = prompt.match(/ACTION:\s*([A-Z_]+)/);
    const action = mt?.[1] ?? 'WRITE_FILE';
    if (action === 'RUN_COMMAND') {
      const cmd = this.writeTag(prompt, 'COMMAND');
      return `OUTPUT_START\nCMD: ${cmd || 'npm test'}\n$ command executed successfully (exit code 0)\nOUTPUT_END`;
    }
    const file = this.writeTag(prompt, 'FILE');
    const content = this.writeTag(prompt, 'CONTENT');
    return `${action === 'READ_FILE' ? 'READ_OK' : 'TOOL_OK'} file=${file || 'src/feature.ts'} bytes=${(content ?? '').length}`;
  }
  private fixResponse(): string {
    return 'OUTPUT_START\nFIX: applied targeted correction to failing module and re-ran tests.\nRESULT: all tests passing.\nOUTPUT_END';
  }
  private writeTag(s: string, tag: string): string {
    const rx = new RegExp(tag + ':\\s*(.*)');
    return s.match(rx)?.[1]?.trim() ?? '';
  }
}