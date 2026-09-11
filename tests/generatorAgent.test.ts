import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GeneratorAgent } from '../src/agent/GeneratorAgent';
import { classifyTask, TaskType, TASK_PROMPTS } from '../src/agent/taskRouter';
import { verifyOutput } from '../src/agent/verifier';
import { Toolkit } from '../src/agent/toolkit';
import { Workspace } from '../src/workspace/Workspace';
import { DEFAULT_CONFIG } from '../src/config/schema';
import { ModelMessage, ModelRouterLike, TaskKind } from '../src/types';

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'luicode-gen-agent-'));
}

function makeToolkit(dir: string): Toolkit {
  return new Toolkit({
    ws: new Workspace(dir),
    config: structuredClone(DEFAULT_CONFIG),
    mode: 'full',
    emit: () => undefined,
    askCommandApproval: async () => true
  });
}

type RouterScript = (messages: ModelMessage[], call: number) => string;

function makeRouter(script: RouterScript): ModelRouterLike {
  let calls = 0;
  return {
    complete: async (_task: TaskKind, messages: ModelMessage[]) => ({ content: script(messages, ++calls) })
  } as unknown as ModelRouterLike;
}

// ---------------------------------------------------------------------------
// Task-type router eval harness (from the v2 spec)
// ---------------------------------------------------------------------------

describe('Eval harness — task-type classification', () => {
  const TEST_CASES: Array<[string, TaskType]> = [
    ['Write a Python script for a web scraper', 'code'],
    ['Generate a CSV of 5 mock user profiles', 'structured_data'],
    ['Draft an email requesting a deadline extension', 'general'],
    ["What's the current version of the OpenAI SDK?", 'research'],
    ['Make me a thing', 'general']
  ];

  it.each(TEST_CASES)('classifies %j as %s', (prompt, expected) => {
    expect(classifyTask(prompt)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// Orchestration loop
// ---------------------------------------------------------------------------

describe('GeneratorAgent orchestration', () => {
  it('runs a tool call, observes the result, then answers', async () => {
    const dir = tmpdir();
    const agent = new GeneratorAgent({
      router: makeRouter((messages, call) => {
        // Verify the system prompt carries the code sub-prompt
        const system = messages.find((m) => m.role === 'system')?.content ?? '';
        if (call === 1) {
          expect(system).toContain(TASK_PROMPTS.code.slice(0, 30));
          expect(system).toContain('write_file');
          return [
            'THOUGHT: ASSUMPTION: plain text file is acceptable',
            'ACTION: write_file',
            'ARGS:',
            '{"path":"gen.txt","content":"hello world"}'
          ].join('\n');
        }
        return ['THOUGHT: file written', 'ACTION: FINAL', '', 'ANSWER:', 'wrote gen.txt'].join('\n');
      }),
      toolkit: makeToolkit(dir)
    });

    const result = await agent.runAgentTask('Write a script that creates gen.txt with hello world');

    expect(result.taskType).toBe('code');
    expect(fs.readFileSync(path.join(dir, 'gen.txt'), 'utf8')).toBe('hello world');
    expect(result.answer).toContain('wrote gen.txt');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe('write_file');
    expect(result.toolCalls[0].ok).toBe(true);
    expect(result.assumptions).toEqual(['plain text file is acceptable']);
    expect(result.halted).toBe(false);
    expect(result.verified).toBe(true);
  });

  it('halts on a repeated identical tool call instead of looping', async () => {
    const agent = new GeneratorAgent({
      router: makeRouter(() =>
        [
          'THOUGHT: trying again',
          'ACTION: read_file',
          'ARGS:',
          '{"path":"missing.txt"}'
        ].join('\n')
      ),
      toolkit: makeToolkit(tmpdir()),
      maxSteps: 6
    });

    const result = await agent.runAgentTask('Find the file please');

    expect(result.halted).toBe(true);
    expect(result.toolCalls).toHaveLength(1);
  });

  it('applies one correction pass when structured data fails verification', async () => {
    const agent = new GeneratorAgent({
      router: makeRouter((messages, call) => {
        if (messages.some((m) => m.role === 'user' && m.content.startsWith('VERIFIER FEEDBACK'))) {
          return [
            'THOUGHT: fixing JSON',
            'ACTION: FINAL',
            '',
            'ANSWER:',
            '{"name":"Ada","role":"developer"}'
          ].join('\n');
        }
        return [
          'THOUGHT: emitting data',
          'ACTION: FINAL',
          '',
          'ANSWER:',
          '{ bad json'
        ].join('\n');
      }),
      toolkit: makeToolkit(tmpdir()),
      taskType: 'structured_data'
    });

    const result = await agent.runAgentTask('Generate a JSON user profile');

    expect(result.corrected).toBe(true);
    expect(result.verified).toBe(true);
    expect(JSON.parse(result.answer)).toEqual({ name: 'Ada', role: 'developer' });
  });

  it('returns a clarification request when the model asks for one', async () => {
    const agent = new GeneratorAgent({
      router: makeRouter(() =>
        [
          'THOUGHT: underspecified — format unknown',
          'ACTION: CLARIFY',
          'QUESTION: Which output format do you want — CSV or JSON?'
        ].join('\n')
      ),
      toolkit: makeToolkit(tmpdir())
    });

    const result = await agent.runAgentTask('Make me a thing');

    expect(result.clarificationNeeded).toBe('Which output format do you want — CSV or JSON?');
    expect(result.answer).toBe('');
  });

  it('surfaces an error observation and continues to a final answer', async () => {
    const agent = new GeneratorAgent({
      router: makeRouter((_messages, call) => {
        if (call === 1) {
          return [
            'THOUGHT: reading a missing file',
            'ACTION: read_file',
            'ARGS:',
            '{"path":"nope.txt"}'
          ].join('\n');
        }
        return ['THOUGHT: file did not exist', 'ACTION: FINAL', '', 'ANSWER:', 'file not found'].join('\n');
      }),
      toolkit: makeToolkit(tmpdir())
    });

    const result = await agent.runAgentTask('Read nope.txt');

    expect(result.toolCalls[0].ok).toBe(false);
    expect(result.toolCalls[0].output).toMatch(/not found|ERROR/i);
    expect(result.answer).toContain('file not found');
  });

  it('treats a bare reply without an ACTION marker as the final answer', async () => {
    const agent = new GeneratorAgent({
      router: makeRouter(() => 'Here is your answer.'),
      toolkit: makeToolkit(tmpdir())
    });

    const result = await agent.runAgentTask('Hello');

    expect(result.answer).toBe('Here is your answer.');
    expect(result.halted).toBe(false);
  });

  it('falls back to a partial result when the loop cap is hit without a final', async () => {
    const agent = new GeneratorAgent({
      router: makeRouter((_messages, call) => {
        if (call < 4) {
          return ['THOUGHT: keep looking', 'ACTION: search_files', 'ARGS:', '{"pattern":"*"}'].join('\n');
        }
        // never emits a unique call twice with the same args → dedupe would stop first anyway
        return ['THOUGHT: switching args', 'ACTION: search_files', 'ARGS:', '{"pattern":"*.ts"}'].join('\n');
      }),
      toolkit: makeToolkit(tmpdir()),
      maxSteps: 3
    });

    const result = await agent.runAgentTask('explore');

    expect(result.steps).toBeLessThanOrEqual(3);
    expect(result.halted || result.answer.length > 0).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Verifier
// ---------------------------------------------------------------------------

describe('verifyOutput', () => {
  it('accepts valid JSON for structured data', () => {
    expect(verifyOutput('{ "a": 1 }', { taskType: 'structured_data' }).passed).toBe(true);
  });

  it('rejects invalid JSON for structured data', () => {
    const r = verifyOutput('{ "a": 1, }', { taskType: 'structured_data' });
    expect(r.passed).toBe(false);
    expect(r.feedback).toMatch(/Invalid JSON/);
  });

  it('strips fences before validating JSON', () => {
    expect(verifyOutput('```json\n{"ok":true}\n```', { taskType: 'structured_data' }).passed).toBe(true);
  });

  it('finds syntax errors in code output', () => {
    const r = verifyOutput('function broken( { return; }', { taskType: 'code' });
    expect(r.passed).toBe(false);
    expect(r.feedback).toMatch(/Syntax errors/);
  });

  it('accepts syntactically valid code output', () => {
    const r = verifyOutput('export function add(a: number, b: number): number {\n  return a + b;\n}', {
      taskType: 'code'
    });
    expect(r.passed).toBe(true);
  });

  it('skips prose without a machine-verifiable format', () => {
    expect(verifyOutput('Just a friendly note.').passed).toBe(true);
  });
});