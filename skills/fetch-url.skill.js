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
  name: 'fetch_url',
  description:
    'Fetch a public web page or JSON document over http/https and return its contents. HTML is converted to plain text. Refuses private/loopback addresses to prevent SSRF.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The URL to fetch (http or https)' },
    },
    required: ['url'],
  },
  async run({ url }) {
    const res = await safeFetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 OpenClaw/1.0' },
    });
    if (!res.ok) throw new Error(`fetch_url: HTTP ${res.status}`);
    const ctype = res.headers.get('content-type') || '';
    const raw = await res.text();
    const text = ctype.includes('html') ? stripHtml(raw) : raw;
    const trimmed = text.length > 8000 ? text.slice(0, 8000) + '\n\n…[truncated]' : text;
    return { url, content_type: ctype, length: text.length, text: trimmed };
  },
};
