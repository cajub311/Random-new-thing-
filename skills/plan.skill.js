// Gives smaller models an explicit place to think before they act.
// The plan is echoed back unchanged so the model can reference it in the
// following tool calls. No side effects, no network, no cost beyond the
// model's own output tokens.

export default {
  name: 'plan',
  description:
    'Write down a short, numbered plan BEFORE taking any other action on a multi-step task. Use this to break the request into 2-5 concrete steps. Calling plan is optional for trivial requests; use it whenever the task needs more than one tool call.',
  parameters: {
    type: 'object',
    properties: {
      goal: { type: 'string', description: 'The user request in one sentence.' },
      steps: {
        type: 'array',
        items: { type: 'string' },
        description: 'Ordered list of concrete next actions, each referencing the tool you expect to use.',
      },
    },
    required: ['goal', 'steps'],
  },
  async run({ goal, steps }) {
    const clean = (Array.isArray(steps) ? steps : []).map(s => String(s || '').trim()).filter(Boolean).slice(0, 8);
    return {
      accepted: true,
      goal: String(goal || '').trim(),
      steps: clean,
      note: 'Plan recorded. Now execute step 1.',
    };
  },
};
