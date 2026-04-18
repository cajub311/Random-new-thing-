export default {
  name: 'current_time',
  description:
    'Return the current UTC date and time. Use whenever the user asks about "now", "today", or any time-sensitive information.',
  parameters: { type: 'object', properties: {} },
  async run() {
    const now = new Date();
    return {
      iso: now.toISOString(),
      utc: now.toUTCString(),
      unix: Math.floor(now.getTime() / 1000),
      tz_offset_minutes: -now.getTimezoneOffset(),
    };
  },
};
