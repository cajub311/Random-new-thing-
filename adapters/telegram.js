// Optional Telegram adapter. Uses long-polling (no webhook setup needed).
// Activated by setting TELEGRAM_BOT_TOKEN in the environment.
//
// The adapter talks to the local /api/agent endpoint, so anything you can
// do in the web UI you can do from Telegram too. Per-chat conversation
// history is kept in-memory; the long-term memory module persists across
// restarts.

const BASE = 'https://api.telegram.org/bot';

export async function startTelegram({ token, endpoint, logger }) {
  if (!token) throw new Error('missing token');

  // Quick ping to verify the token.
  const me = await fetch(`${BASE}${token}/getMe`).then(r => r.json()).catch(() => null);
  if (!me?.ok) throw new Error('invalid TELEGRAM_BOT_TOKEN');
  logger.info(`telegram bot: @${me.result.username}`);

  const histories = new Map();  // chatId -> [{role, content}]
  let offset = 0;

  async function tg(method, body) {
    const res = await fetch(`${BASE}${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.json();
  }

  async function handle(update) {
    const msg = update.message;
    if (!msg || !msg.text) return;
    const chatId = msg.chat.id;
    const text = msg.text.trim();

    if (text === '/start') {
      await tg('sendMessage', { chat_id: chatId, text: 'OpenClaw here. Ask me anything — I can search the web, create files, draft emails, do math, generate images, and remember things about you.' });
      return;
    }
    if (text === '/reset') {
      histories.delete(chatId);
      await tg('sendMessage', { chat_id: chatId, text: 'Conversation reset.' });
      return;
    }

    const history = histories.get(chatId) || [];
    history.push({ role: 'user', content: text });
    await tg('sendChatAction', { chat_id: chatId, action: 'typing' });

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: history, maxSteps: 8 }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || 'agent error');
      history.push({ role: 'assistant', content: data.reply });
      histories.set(chatId, history.slice(-20));  // cap memory
      await tg('sendMessage', { chat_id: chatId, text: data.reply || '(no reply)', parse_mode: 'Markdown' });
    } catch (e) {
      logger.error('agent error', { err: e.message });
      await tg('sendMessage', { chat_id: chatId, text: `Error: ${e.message}` });
    }
  }

  (async function loop() {
    while (true) {
      try {
        const r = await fetch(`${BASE}${token}/getUpdates?timeout=30&offset=${offset}`, { signal: AbortSignal.timeout(35_000) });
        const data = await r.json();
        if (data.ok && data.result?.length) {
          for (const u of data.result) {
            offset = u.update_id + 1;
            handle(u).catch(err => logger.error('handle failed', { err: err.message }));
          }
        }
      } catch (e) {
        logger.warn('poll error, retrying', { err: e.message });
        await new Promise(r => setTimeout(r, 3000));
      }
    }
  })();
}
