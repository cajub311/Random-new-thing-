// Pulls simple structured signals out of a blob of text without paying for
// another LLM round trip: emails, URLs, phone numbers, ISO dates, numeric
// amounts, and lines that look like key:value pairs. Meant for quick
// extraction after fetch_url / read_file before the model writes its
// answer — a good complement to a generic "summarize" pass.

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const URL_RE = /https?:\/\/[^\s<>"')]+/g;
// Require parens, spaces, or a leading "+" — prevents matching bare date-like
// digit runs such as 2026-05-15.
const PHONE_RE = /(?:\+\d[\d\s().-]{6,}\d|\(\d{2,4}\)[\d\s().-]{4,}\d|\b\d{3}[-. ]\d{3,4}[-. ]\d{3,4}\b)/g;
const DATE_RE = /\b(?:\d{4}-\d{2}-\d{2}|\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})\b/g;
const MONEY_RE = /\$\s?\d[\d,]*(?:\.\d+)?|\d[\d,]*(?:\.\d+)?\s?(?:USD|EUR|GBP|JPY|CAD|AUD)\b/g;
const KV_RE = /^\s*([A-Za-z][\w\s-]{1,40})\s*:\s*(.{1,160})\s*$/;

function uniq(arr) { return [...new Set(arr.map(s => s.trim()).filter(Boolean))]; }
function cleanUrl(u) { return u.replace(/[.,;:!?]+$/, ''); }

export default {
  name: 'extract_structured',
  description:
    'Pull structured signals (emails, URLs, phone numbers, dates, monetary amounts, key:value pairs) out of a blob of text. Useful right after fetch_url / read_file to pick out the fields you actually need before answering.',
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Raw text to scan.' },
      fields: {
        type: 'array',
        items: { type: 'string', enum: ['emails', 'urls', 'phones', 'dates', 'money', 'kv'] },
        description: 'Which signal types to return. Default: all.',
      },
    },
    required: ['text'],
  },
  async run({ text, fields }) {
    const src = String(text || '');
    const want = new Set(fields?.length ? fields : ['emails', 'urls', 'phones', 'dates', 'money', 'kv']);
    const out = {};
    if (want.has('emails')) out.emails = uniq(src.match(EMAIL_RE) || []).slice(0, 50);
    if (want.has('urls'))   out.urls   = uniq((src.match(URL_RE) || []).map(cleanUrl)).slice(0, 50);
    if (want.has('phones')) out.phones = uniq(src.match(PHONE_RE) || []).slice(0, 50);
    if (want.has('dates'))  out.dates  = uniq(src.match(DATE_RE)  || []).slice(0, 50);
    if (want.has('money'))  out.money  = uniq(src.match(MONEY_RE) || []).slice(0, 50);
    if (want.has('kv')) {
      const kv = {};
      for (const line of src.split(/\r?\n/)) {
        const m = line.match(KV_RE);
        if (m && !kv[m[1].trim()]) kv[m[1].trim()] = m[2].trim();
        if (Object.keys(kv).length >= 40) break;
      }
      out.kv = kv;
    }
    return { length: src.length, ...out };
  },
};
