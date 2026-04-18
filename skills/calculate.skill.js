// Sandboxed math evaluator. Whitelists characters, checks every identifier
// against Math members, rewrites ^ to **, pi to Math.PI, etc. Then runs the
// expression inside a new Function() with strict mode. The Function itself
// has no access to globals except Math because we don't pass anything in.

export default {
  name: 'calculate',
  description:
    'Evaluate a math expression and return the numeric result. Use for any non-trivial arithmetic. Supports +, -, *, /, %, **/^, parentheses, and Math.* functions (sqrt, sin, cos, log, pow, abs, round, min, max, …).',
  parameters: {
    type: 'object',
    properties: {
      expression: { type: 'string', description: 'e.g. "sqrt(2)*3 + 5^2"' },
    },
    required: ['expression'],
  },
  async run({ expression }) {
    const expr = String(expression || '').trim();
    if (!expr) return { error: 'empty expression' };
    if (expr.length > 200) return { error: 'expression too long' };
    if (!/^[-+*/%^().,0-9a-zA-Z_\s]+$/.test(expr)) {
      return { error: 'only numbers, operators, parentheses, and identifiers allowed' };
    }
    const ids = expr.match(/[a-zA-Z_][a-zA-Z0-9_]*/g) || [];
    const allowed = new Set(['Math', ...Object.getOwnPropertyNames(Math), 'e', 'pi']);
    for (const id of ids) if (!allowed.has(id)) return { error: `disallowed identifier: ${id}` };
    try {
      const normalized = expr
        .replace(/\^/g, '**')
        .replace(/\bpi\b/g, 'Math.PI')
        .replace(/\be\b/g, 'Math.E')
        .replace(/\b(sqrt|cbrt|sin|cos|tan|asin|acos|atan|atan2|exp|log|log2|log10|pow|abs|round|floor|ceil|trunc|sign|min|max|hypot)\(/g, 'Math.$1(');
      // eslint-disable-next-line no-new-func
      const fn = new Function(`"use strict"; return (${normalized});`);
      const value = fn();
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return { error: 'non-numeric or non-finite result' };
      }
      return { expression: expr, result: value };
    } catch (e) {
      return { error: String(e.message || e) };
    }
  },
};
