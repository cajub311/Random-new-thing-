export default {
  name: 'generate_image',
  description:
    'Generate an image from a text prompt using a free keyless service (Pollinations). Returns a URL pointing at the generated image.',
  parameters: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'Detailed description of the image' },
      width:  { type: 'integer', description: 'Width in pixels (default 768)' },
      height: { type: 'integer', description: 'Height in pixels (default 768)' },
      seed:   { type: 'integer', description: 'Optional random seed' },
    },
    required: ['prompt'],
  },
  async run({ prompt, width = 768, height = 768, seed }) {
    const w = Math.min(Math.max(64, width | 0), 2048);
    const h = Math.min(Math.max(64, height | 0), 2048);
    const params = new URLSearchParams({ width: String(w), height: String(h), nologo: 'true' });
    if (Number.isInteger(seed)) params.set('seed', String(seed));
    const image_url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?${params}`;
    return {
      prompt, width: w, height: h,
      seed: Number.isInteger(seed) ? seed : null,
      image_url,
      note: 'Image URL is a live service — opens directly in any browser or <img> tag.',
    };
  },
};
