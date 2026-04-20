// Extractive summarizer — picks the highest-signal sentences from a text
// blob without calling another LLM. Rough scoring: sentence length gets
// credit for being non-trivial but not verbose, and overlap with the top
// unigrams (minus stopwords) gets the heaviest weight. Not as good as an
// LLM summary, but cheap, deterministic, and good enough to feed back as
// compressed context after fetch_url returned a huge page.

const STOP = new Set([
  'the','a','an','and','or','but','if','then','of','to','in','on','at','for','with',
  'is','are','was','were','be','been','being','this','that','those','these','it','its',
  'as','by','from','not','no','so','do','does','did','have','has','had','will','would',
  'can','could','should','may','might','i','you','he','she','they','we','our','their',
]);

function sentences(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+(?=[A-Z])/)
    .map(s => s.trim())
    .filter(s => s.length > 12);
}

function tokens(text) {
  return String(text).toLowerCase().match(/[a-z0-9][a-z0-9'-]{1,}/g) || [];
}

export default {
  name: 'summarize_text',
  description:
    'Extract a concise summary (N top sentences) from a long text blob. Deterministic and fast — no LLM call. Use after fetch_url/read_file when a page is too long to feed back verbatim.',
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'The raw text to summarize.' },
      sentences: { type: 'integer', description: 'How many top sentences to return (default 5, max 20).' },
    },
    required: ['text'],
  },
  async run({ text, sentences: n = 5 }) {
    const cap = Math.min(Math.max(1, n | 0), 20);
    const sents = sentences(text);
    if (sents.length <= cap) return { summary: sents.join(' '), count: sents.length, total: sents.length };

    const freq = new Map();
    for (const t of tokens(text)) {
      if (STOP.has(t) || t.length < 3) continue;
      freq.set(t, (freq.get(t) || 0) + 1);
    }

    const scored = sents.map((s, i) => {
      const toks = tokens(s).filter(t => !STOP.has(t) && t.length >= 3);
      if (!toks.length) return { i, s, score: 0 };
      const sum = toks.reduce((acc, t) => acc + (freq.get(t) || 0), 0);
      // Favor mid-length sentences.
      const lenPenalty = Math.min(1, s.length / 40) * (s.length > 240 ? 240 / s.length : 1);
      return { i, s, score: (sum / toks.length) * lenPenalty };
    });

    const top = scored
      .sort((a, b) => b.score - a.score)
      .slice(0, cap)
      .sort((a, b) => a.i - b.i);

    return { summary: top.map(x => x.s).join(' '), count: top.length, total: sents.length };
  },
};
