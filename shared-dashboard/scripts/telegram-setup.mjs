#!/usr/bin/env node
// Helps set up Telegram alerts for the shared dashboard.
//
// 1) List the chats your bot can see (post something in the channel or group first):
//      node scripts/telegram-setup.mjs <bot token>
// 2) Send a test message to one of them:
//      node scripts/telegram-setup.mjs <bot token> <chat id>
//
// The bot token comes from @BotFather. Nothing is stored; the token is only sent to Telegram.

const [token, chatId] = process.argv.slice(2);
if (!token || !/^\d+:[\w-]{20,}$/.test(token)) {
  console.error('Usage: node scripts/telegram-setup.mjs <bot token> [chat id]');
  console.error('The bot token looks like 123456789:AAH... and comes from @BotFather.');
  process.exit(1);
}
const api = (method, body) => fetch(`https://api.telegram.org/bot${token}/${method}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body || {}),
}).then(r => r.json());

const me = await api('getMe');
if (!me.ok) {
  console.error(`Telegram rejected the token: ${me.description}`);
  process.exit(1);
}
console.log(`Bot: @${me.result.username}\n`);

if (chatId) {
  const res = await api('sendMessage', {
    chat_id: chatId,
    parse_mode: 'HTML',
    text: '<b>THBT dashboard: test alert</b>\nTHBT / USDC: Uniswap: 33.21, Bank Rate: 33.01, Deviation: +0.61%\nIf you can read this, Telegram alerts are set up.',
  });
  if (res.ok) {
    console.log(`Test message sent to "${res.result.chat.title || res.result.chat.username || chatId}".`);
    console.log(`\nAdd these Worker secrets:\n  TELEGRAM_BOT_TOKEN = ${token}\n  TELEGRAM_CHAT_ID   = ${chatId}`);
  } else {
    console.error(`Telegram refused the message: ${res.description}`);
    if (/not enough rights|need administrator/i.test(res.description)) console.error('For a channel, make the bot an administrator with "Post messages" turned on.');
    if (/chat not found/i.test(res.description)) console.error('Check the chat ID, and that the bot was added to the channel or group.');
    process.exit(1);
  }
} else {
  const updates = await api('getUpdates', { allowed_updates: ['message', 'channel_post', 'my_chat_member'] });
  if (!updates.ok) {
    console.error(`Couldn't read updates: ${updates.description}`);
    process.exit(1);
  }
  const chats = new Map();
  updates.result.forEach(u => {
    const c = (u.channel_post || u.message || u.my_chat_member || {}).chat;
    if (c) chats.set(c.id, c);
  });
  if (!chats.size) {
    console.log('No chats found yet. Add the bot to your channel (as an administrator) or group,');
    console.log('post any message there, then run this again.');
  } else {
    console.log('Chats the bot can see:');
    chats.forEach(c => console.log(`  ${String(c.id).padEnd(16)} ${c.type.padEnd(11)} ${c.title || c.username || ''}`));
    console.log('\nNext: node scripts/telegram-setup.mjs <bot token> <chat id>   (sends a test message)');
  }
}
