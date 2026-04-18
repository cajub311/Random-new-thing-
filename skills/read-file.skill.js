import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { basename, join, resolve } from 'path';

export default {
  name: 'read_file',
  description:
    'Read a text file the agent previously created in the workspace, for summarization or further editing.',
  parameters: {
    type: 'object',
    properties: {
      filename: { type: 'string', description: 'Name of the file in the workspace.' },
    },
    required: ['filename'],
  },
  async run({ filename }, ctx) {
    const dir = ctx.workspaceDir;
    const safe = basename(String(filename || '')).replace(/[^\w.\-]/g, '_');
    const p = resolve(join(dir, safe));
    if (!p.startsWith(resolve(dir))) throw new Error('path escape');
    if (!existsSync(p)) throw new Error('not found');
    const text = await readFile(p, 'utf8');
    const trimmed = text.length > 12000 ? text.slice(0, 12000) + '\n\n…[truncated]' : text;
    return { filename: safe, length: text.length, text: trimmed };
  },
};
