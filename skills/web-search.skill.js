import { safeFetch } from '../lib/safe-fetch.js';

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

export default {
  name: 'web_search',
  description:
    'Search the public web (DuckDuckGo) for up-to-date information. Returns a list of results with title, snippet, and URL. Prefer this over guessing for anything time-sensitive.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The search query' },
      limit: { type: 'integer', description: 'Max results (default 5, max 10)' },
    },
    required: ['query'],
  },
  async run({ query, limit = 5 }) {
    const cap = Math.min(Math.max(1, limit | 0), 10);
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const res = await safeFetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 OpenClaw/1.0' } });
    if (!res.ok) throw new Error(`web_search failed: ${res.status}`);
    const html = await res.text();
    const results = [];
    const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
    let m;
    while ((m = re.exec(html)) && results.length < cap) {
      let link = m[1];
      try {
        const u = new URL(link, 'https://duckduckgo.com');
        const real = u.searchParams.get('uddg');
        if (real) link = decodeURIComponent(real);
      } catch { /* keep */ }
      results.push({ title: stripHtml(m[2]), url: link, snippet: stripHtml(m[3]) });
    }
    return { query, results };
  },
};
