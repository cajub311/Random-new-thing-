import { mkdir, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { basename, join, resolve } from 'path';

export default {
  name: 'create_file',
  description:
    'Create a text file in the user\'s workspace and return a download URL. Filename is sanitized; content is capped at 1MB.',
  parameters: {
    type: 'object',
    properties: {
      filename: { type: 'string', description: 'File name (no slashes), e.g. "report.md".' },
      content:  { type: 'string', description: 'Full text content to write.' },
    },
    required: ['filename', 'content'],
  },
  async run({ filename, content }, ctx) {
    const dir = ctx.workspaceDir;
    if (!existsSync(dir)) await mkdir(dir, { recursive: true });
    const safe = basename(String(filename || '')).replace(/[^\w.\-]/g, '_').slice(0, 120) || 'file.txt';
    const outPath = resolve(join(dir, safe));
    if (!outPath.startsWith(resolve(dir))) throw new Error('path escape');
    const text = String(content ?? '');
    if (Buffer.byteLength(text, 'utf8') > 1024 * 1024) throw new Error('content exceeds 1MB');
    await writeFile(outPath, text, 'utf8');
    return {
      filename: safe,
      bytes: Buffer.byteLength(text, 'utf8'),
      download_url: `/api/files/${encodeURIComponent(safe)}`,
      note: 'File created. The user can click the download URL to retrieve it.',
    };
  },
};
