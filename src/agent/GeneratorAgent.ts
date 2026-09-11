import { ModelRouterLike, ModelMessage, TaskKind, ToolCall } from '../types';
import { Toolkit } from './toolkit';
import { TaskType, classifyTask, buildSystemPrompt } from './taskRouter';
import { verifyOutput } from './verifier';

// ---------------------------------------------------------------------------
// Universal Generator Agent v2
//
// A reasoning + tools orchestrator layered on top of the existing
// Router → Toolkit pipeline. Implements the v2 phases:
//   Phase 1  Understand   → task-type classification + clarify/assumption
//   Phase 2  Plan         → prompted multi-step planning in THOUGHT
//   Phase 3  Execute      → ReAct-style ACTION: <tool> / ARGS loop
//   Phase 4  Verify       → mechanical output verification + one correction pass
//   Phase 5  Deliver      → final answer, assumptions surfaced
// ---------------------------------------------------------------------------

export interface GeneratorAgentOptions {
  router: ModelRouterLike;
  toolkit: Toolkit;
  /** Max reasoning/tool steps before forcing a partial answer (default 6). */
  maxSteps?: number;
  /** Max output tokens per LLM reply (default 1200). */
  maxTokens?: number;
  /** Override automatic task-type classification. */
  taskType?: TaskType;
  /** Truncation for tool observations fed back to the model (default 3000). */
  maxObservationChars?: number;
}

export interface GeneratorToolCall {
  name: string;
  args: Record<string, unknown>;
  output: string;
  ok: boolean;
}

export interface GeneratorResult {
  answer: string;
  taskType: TaskType;
  steps: number;
  toolCalls: GeneratorToolCall[];
  assumptions: string[];
  verified: boolean;
  /** true when the verification pass rewrote the output */
  corrected: boolean;
  /** true when the loop ended early (max steps / duplicate tool call) */
  halted: boolean;
  clarificationNeeded?: string;
  error?: string;
}

interface ParsedTurn {
  action: 'tool' | 'final' | 'clarify' | 'none';
  tool?: string;
  args?: Record<string, unknown>;
  question?: string;
  answer?: string;
  thoughts: string[];
}

const COMMAND_TOOL = 'run_command';

export class GeneratorAgent {
  private readonly opts: GeneratorAgentOptions;

  constructor(opts: GeneratorAgentOptions) {
    if (!opts.router) throw new Error('GeneratorAgent requires a router');
    if (!opts.toolkit) throw new Error('GeneratorAgent requires a toolkit');
    this.opts = {
      maxSteps: 6,
      maxTokens: 1200,
      maxObservationChars: 3000,
      ...opts
    };
  }

  toolNames(): string[] {
    return [...this.opts.toolkit.names(), COMMAND_TOOL].sort();
  }

  async runAgentTask(request: string): Promise<GeneratorResult> {
    const taskType = this.opts.taskType ?? classifyTask(request);
    const messages: ModelMessage[] = [
      { role: 'system', content: buildSystemPrompt(taskType, this.toolNames()) },
      { role: 'user', content: request }
    ];

    const toolCalls: GeneratorToolCall[] = [];
    const assumptions: string[] = [];
    const seen = new Set<string>();
    const maxSteps = this.opts.maxSteps ?? 6;

    let finalAnswer: string | undefined;
    let clarification: string | undefined;
    let halted = false;
    let error: string | undefined;
    let lastRaw = '';

    for (let step = 1; step <= maxSteps; step++) {
      let raw: string;
      try {
        const reply = await this.opts.router.complete('coder' as TaskKind, messages, {
          maxTokens: this.opts.maxTokens
        });
        raw = reply.content;
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
        halted = true;
        break;
      }
      lastRaw = raw;
      const turn = parseTurn(raw);
      assumptions.push(...extractAssumptions(turn.thoughts));

      if (turn.action === 'clarify') {
        clarification = turn.question;
        break;
      }

      if (turn.action === 'final') {
        finalAnswer = turn.answer ?? '';
        break;
      }

      if (turn.action === 'tool' && turn.tool) {
        const key = `${turn.tool}\u0000${JSON.stringify(turn.args ?? {})}`;
        if (seen.has(key)) {
          halted = true;
          break;
        }
        seen.add(key);

        const call = await this.execTool(turn.tool, turn.args ?? {});
        toolCalls.push(call);
        messages.push({ role: 'assistant', content: raw });
        messages.push({
          role: 'user',
          content:
            `OBSERVATION from ${turn.tool}${call.ok ? '' : ' (error)'}:\n` +
            `${call.output.slice(0, this.opts.maxObservationChars ?? 3000)}\n\n` +
            `Continue. When the answer is ready — or no tool can help — respond with ACTION: FINAL and the ANSWER.`
        });
        continue;
      }

      // No ACTION marker — be lenient and treat the raw model output as the answer.
      finalAnswer = raw.trim();
      break;
    }

    if (finalAnswer === undefined && clarification === undefined && !error) {
      halted = true;
      finalAnswer = lastRaw.trim() || `[Max steps reached — returning best partial result.]`;
    }

    // Phase 4 — mechanical verification with one auto-correction pass.
    let answer = finalAnswer ?? '';
    let corrected = false;
    let verified = true;
    if (answer && clarification === undefined && !error) {
      const check = verifyOutput(answer, { taskType });
      if (!check.passed) {
        messages.push({ role: 'assistant', content: lastRaw });
        messages.push({
          role: 'user',
          content: `VERIFIER FEEDBACK:\n${check.feedback}\n\nReturn a corrected ACTION: FINAL reply containing the FIXED ANSWER.`
        });
        try {
          const fixReply = await this.opts.router.complete('coder' as TaskKind, messages, { maxTokens: this.opts.maxTokens });
          const fixTurn = parseTurn(fixReply.content);
          const fixed = fixTurn.action === 'final' && fixTurn.answer ? fixTurn.answer : fixReply.content.trim();
          const recheck = verifyOutput(fixed, { taskType });
          corrected = true;
          answer = fixed;
          verified = recheck.passed;
        } catch {
          corrected = true;
          verified = false;
        }
      }
    }

    return {
      answer,
      taskType,
      steps: Math.min(toolCalls.length + 1, maxSteps),
      toolCalls,
      assumptions: [...assumptions],
      verified,
      corrected,
      halted,
      ...(clarification !== undefined ? { clarificationNeeded: clarification } : {}),
      ...(error !== undefined ? { error } : {})
    };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async execTool(name: string, args: Record<string, unknown>): Promise<GeneratorToolCall> {
    try {
      if (name === COMMAND_TOOL) {
        const rec = await this.opts.toolkit.runCommandTool(String(args.command ?? ''));
        const output = `EXIT_CODE: ${rec.code}\n${rec.stdout}\n${rec.stderr}`.slice(0, this.opts.maxObservationChars ?? 3000);
        return { name, args, output, ok: rec.code === 0 };
      }
      const call: ToolCall = await this.opts.toolkit.runTool(name, args);
      const output = (call.output ?? call.error ?? '').slice(0, this.opts.maxObservationChars ?? 3000);
      return { name, args, output, ok: call.status === 'ok' };
    } catch (err) {
      return {
        name,
        args,
        output: `ERROR: ${err instanceof Error ? err.message : String(err)}`,
        ok: false
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Turn parser — decodes the textual THOUGHT/ACTION/ARGS/ANSWER protocol.
// ---------------------------------------------------------------------------

function parseTurn(text: string): ParsedTurn {
  const t = text.replace(/\r\n/g, '\n').trim();
  const thoughts: string[] = (t.match(/^THOUGHT:\s*([\s\S]*?)(?=^ACTION:|$)/m)?.[1] ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  const actionMatch = t.match(/^ACTION:\s*([A-Za-z_]+)\s*$/m);
  const actionName = actionMatch ? actionMatch[1].toUpperCase() : '';

  let action: ParsedTurn['action'] = 'none';
  let tool: string | undefined;
  if (actionName === 'FINAL') action = 'final';
  else if (actionName === 'CLARIFY') action = 'clarify';
  else if (actionMatch) {
    action = 'tool';
    tool = actionMatch[1];
  }

  const actionLineIndex = actionMatch
    ? t.slice(0, actionMatch.index).split('\n').length - 1
    : -1;
  const payload = actionLineIndex >= 0 ? t.split('\n').slice(actionLineIndex + 1).join('\n').trim() : t;

  let question: string | undefined;
  let answer: string | undefined;
  let args: Record<string, unknown> | undefined;

  if (payload.startsWith('QUESTION:')) {
    question = payload.slice('QUESTION:'.length).trim();
  } else if (payload.startsWith('ARGS:')) {
    const jsonText = payload.slice('ARGS:'.length).trim();
    try {
      const parsed = JSON.parse(jsonText) as unknown;
      args = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      args = {};
    }
  } else if (payload.startsWith('ANSWER:')) {
    answer = payload.slice('ANSWER:'.length).trim();
  } else if (payload.length > 0) {
    // Tolerant recovery: model skipped the marker — treat leftover payload as answer.
    answer = payload;
  }

  return { action, tool, args, question, answer, thoughts };
}

function extractAssumptions(thoughts: string[]): string[] {
  const out: string[] = [];
  for (const line of thoughts) {
    const m = line.match(/^ASSUMPTION:\s*(.+)$/i);
    if (m) out.push(m[1]);
  }
  return out;
}