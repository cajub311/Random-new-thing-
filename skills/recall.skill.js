export default {
  name: 'recall',
  description:
    'Search your long-term memory for notes relevant to a query. Use this when you suspect you might have saved relevant context before (the user\'s name, preferences, prior project details). Returns the top matches.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What are you looking up?' },
      tag:   { type: 'string', description: 'Optional tag filter.' },
      limit: { type: 'integer', description: 'Max results (default 5).' },
    },
    required: ['query'],
  },
  async run({ query, tag, limit = 5 }, ctx) {
    const matches = await ctx.memory.search({ query, tag, limit });
    return { query, matches };
  },
};
