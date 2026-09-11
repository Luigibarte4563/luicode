import { selectSteps, renderPlanSummary } from '../src/agent/Agent';
import { extractCommentary } from '../src/agent/executor';
import { ModelRouter } from '../src/router/ModelRouter';
import { DEFAULT_CONFIG } from '../src/config/schema';
import { Plan } from '../src/types';

function makePlan(): Plan {
  return {
    id: 'plan-1',
    task: 'Add authentication',
    analysis: 'React app needing auth module.',
    filesToCreate: ['src/auth.ts'],
    filesToModify: ['README.md'],
    steps: [
      { id: '1', title: 'Analyze existing auth', status: 'pending' },
      { id: '2', title: 'Create login service', status: 'pending' },
      { id: '3', title: 'Add tests', status: 'pending' }
    ],
    tests: ['npm test'],
    risk: 'medium',
    status: 'pending',
    createdAt: Date.now()
  };
}

describe('selectSteps', () => {
  it('marks non-selected steps as skipped', () => {
    const plan = makePlan();
    selectSteps(plan, ['Analyze existing auth', 'Add tests']);
    expect(plan.steps[0].status).toBe('pending');
    expect(plan.steps[1].status).toBe('skipped');
    expect(plan.steps[2].status).toBe('pending');
  });

  it('selecting all keeps no steps skipped', () => {
    const plan = makePlan();
    selectSteps(plan, plan.steps.map((s) => s.title));
    expect(plan.steps.every((s) => s.status !== 'skipped')).toBe(true);
  });

  it('empty selection skips all steps', () => {
    const plan = makePlan();
    selectSteps(plan, []);
    expect(plan.steps.every((s) => s.status === 'skipped')).toBe(true);
  });

  it('is case-insensitive on titles', () => {
    const plan = makePlan();
    selectSteps(plan, ['ANALYZE EXISTING AUTH']);
    expect(plan.steps[0].status).toBe('pending');
    expect(plan.steps[1].status).toBe('skipped');
  });

  it('returns the plan instance', () => {
    const plan = makePlan();
    const result = selectSteps(plan, ['Add tests']);
    expect(result).toBe(plan);
  });
});

describe('renderPlanSummary', () => {
  it('includes plan id, task, steps, files and risk', () => {
    const plan = makePlan();
    const text = renderPlanSummary(plan);
    expect(text).toContain(plan.id);
    expect(text).toContain(plan.task);
    expect(text).toContain('Analyze existing auth');
    expect(text).toContain('src/auth.ts');
    expect(text).toContain('medium');
  });
});

describe('extractCommentary', () => {
  it('strips the commentary block and returns the action body', () => {
    const reply = `--- commentary ---
I will create the login service and wire it into routes.
--- end commentary ---
ACTION: WRITE_FILE
FILE: src/auth.ts
CONTENT:
export const auth = 1;

ACTION: DONE`;
    const { commentary, body } = extractCommentary(reply);
    expect(commentary).toContain('create the login service');
    expect(body).not.toContain('commentary');
    expect(body).toContain('ACTION: WRITE_FILE');
    expect(body).toContain('ACTION: DONE');
  });

  it('passes through messages without commentary unchanged', () => {
    const { commentary, body } = extractCommentary('ACTION: DONE');
    expect(commentary).toBe('');
    expect(body).toBe('ACTION: DONE');
  });

  it('handles missing end marker by treating whole text as body', () => {
    const { commentary, body } = extractCommentary('--- commentary ---\nno close');
    expect(commentary).toBe('');
    expect(body).toBe('--- commentary ---\nno close');
  });
});

describe('ModelRouter usage hook', () => {
  it('calls onUsage after a successful completion', async () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.provider = 'mock';
    const router = new ModelRouter(config);
    const calls: Array<{ usage: Record<string, unknown>; task: string }> = [];
    router.onUsage = (usage, task) => calls.push({ usage: usage as Record<string, unknown>, task });
    const reply = await router.complete('coder', [{ role: 'user', content: 'hello' }]);
    expect(typeof reply.content).toBe('string');
    expect(calls.length).toBe(1);
    expect(calls[0].task).toBe('coder');
    expect(typeof calls[0].usage).toBe('object');
  });

  it('does not fail when no onUsage is registered', async () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.provider = 'mock';
    const router = new ModelRouter(config);
    const reply = await router.complete('planner', [{ role: 'user', content: 'hello' }]);
    expect(reply.content).toBeTruthy();
  });
});
