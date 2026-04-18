// Many local LLMs sometimes forget to emit a plain assistant message and keep
// looping through tool calls. Exposing an explicit "final_answer" tool gives
// the brain a clean way to signal "I'm done" — the server intercepts it and
// returns the content as the final reply.

export default {
  name: 'final_answer',
  description:
    'Return the FINAL answer to the user. Call this exactly once when you have finished all necessary tool calls and are ready to respond. Do not call any other tool after this.',
  parameters: {
    type: 'object',
    properties: {
      answer: { type: 'string', description: 'The final markdown-formatted answer to show the user.' },
    },
    required: ['answer'],
  },
  async run({ answer }) {
    return { answer: String(answer || '') };
  },
};
