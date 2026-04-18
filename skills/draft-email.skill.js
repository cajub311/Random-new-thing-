export default {
  name: 'draft_email',
  description:
    'Draft an email. Produces a mailto: link that opens the user\'s email client pre-filled with the draft.',
  parameters: {
    type: 'object',
    properties: {
      to:      { type: 'string', description: 'Recipient email address' },
      subject: { type: 'string', description: 'Email subject line' },
      body:    { type: 'string', description: 'Plain-text email body' },
      cc:      { type: 'string', description: 'Optional CC address(es), comma-separated' },
    },
    required: ['to', 'subject', 'body'],
  },
  async run({ to, subject, body, cc }) {
    const params = new URLSearchParams();
    params.set('subject', subject);
    params.set('body', body);
    if (cc) params.set('cc', cc);
    const mailto = `mailto:${encodeURIComponent(to)}?${params.toString().replace(/\+/g, '%20')}`;
    return {
      to, cc: cc || null, subject, body,
      mailto_link: mailto,
      note: 'Click the mailto_link to open this draft in your email client.',
    };
  },
};
