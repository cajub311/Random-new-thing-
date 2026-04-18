export default {
  name: 'remember',
  description:
    'Save a fact or preference to long-term memory so you can recall it in future conversations. Use this whenever the user tells you something about themselves, their preferences, or provides a durable piece of context (e.g. their name, their job, their timezone, an ongoing project). Prefer short, self-contained notes.',
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'The fact to remember, as a concise sentence.' },
      tags: { type: 'array',  items: { type: 'string' }, description: 'Optional tags for retrieval (e.g. "user", "work", "pref").' },
      importance: { type: 'integer', description: '1..5, higher = more durable (default 1).' },
    },
    required: ['text'],
  },
  async run({ text, tags = [], importance = 1 }, ctx) {
    return ctx.memory.add({ text, tags, importance });
  },
};
