// Skill auto-loader. Every `*.skill.js` in this directory is imported and its
// default export is expected to be: { name, description, parameters, run }.
// The `run` function receives (args, context) where context includes
// { workspaceDir, memory, logger, requestId }.

import { readdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const here = dirname(fileURLToPath(import.meta.url));

export async function loadSkills() {
  const files = readdirSync(here).filter(f => f.endsWith('.skill.js'));
  const skills = {};
  const defs = [];
  for (const f of files) {
    const mod = await import(pathToFileURL(join(here, f)).href);
    const s = mod.default;
    if (!s || typeof s.run !== 'function' || !s.name) continue;
    skills[s.name] = s;
    defs.push({
      type: 'function',
      function: {
        name: s.name,
        description: s.description,
        parameters: s.parameters || { type: 'object', properties: {} },
      },
    });
  }
  return { skills, defs };
}
