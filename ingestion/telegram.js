const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const Incident = require('../models/Incident');
const { LEBANON_KEYWORDS } = require('./pipeline');

const CHANNELS = ['OJLebanese', 'AlJadeedNews', 'AlHadathTV', 'NaharnetEnglish', 'LBCINews'];

// Place-name keywords used for location extraction (subset of LEBANON_KEYWORDS)
const PLACE_KEYWORDS = [
  'beirut', 'tripoli', 'sidon', 'tyre', 'baalbek', 'nabatieh', 'zahle',
  'jounieh', 'chouf', 'akkar', 'marjayoun', 'hasbaya', 'rashaya', 'qana',
  'naqoura', 'qlayaat', 'hermel', 'bekaa', 'south lebanon', 'dahiyeh',
  'dahieh', 'haret hreik', 'ghobeiry', 'baabda', 'bint jbeil', 'khiyam', 'aita',
];

function extractLocation(text) {
  const lower = text.toLowerCase();
  return PLACE_KEYWORDS.find((p) => lower.includes(p)) || null;
}

async function fetchChannel(client, username) {
  try {
    const messages = await client.getMessages(username, { limit: 10 });
    console.log(`[Telegram] Fetched ${messages.length} messages from @${username}`);
    return messages;
  } catch (err) {
    console.error(`[Telegram] Failed to fetch @${username}: ${err.message}`);
    return [];
  }
}

async function processMessage(msg, username) {
  const text = msg.text || msg.message || '';
  if (!text.trim()) return;

  const lower = text.toLowerCase();
  const passes = LEBANON_KEYWORDS.some((kw) => lower.includes(kw.toLowerCase()));
  if (!passes) return;

  const url = `https://t.me/${username}/${msg.id}`;

  const exists = await Incident.exists({ url });
  if (exists) return;

  const title = text.slice(0, 100).replace(/\n/g, ' ');
  const locationName = extractLocation(text) || 'Lebanon';

  const incident = new Incident({
    title,
    summary: text,
    url,
    source: `@${username}`,
    severity: 'medium',
    location: { name: locationName },
    publishedAt: msg.date ? new Date(msg.date * 1000) : new Date(),
  });

  try {
    await incident.save();
    console.log(`[Telegram] Saved: "${title.slice(0, 60)}..."`);
  } catch (err) {
    if (err.code === 11000) return; // duplicate
    console.error(`[Telegram] DB error saving from @${username}: ${err.message}`);
  }
}

async function poll(client) {
  for (const username of CHANNELS) {
    const messages = await fetchChannel(client, username);
    for (const msg of messages) {
      await processMessage(msg, username);
    }
  }
}

async function startTelegramIngestion() {
  const apiId = parseInt(process.env.TELEGRAM_API_ID, 10);
  const apiHash = process.env.TELEGRAM_API_HASH;
  const botToken = process.env.TELEGRAM_BOT_TOKEN;

  if (!apiId || !apiHash || !botToken) {
    console.warn('[Telegram] Missing credentials — ingestion disabled');
    return;
  }

  const session = new StringSession(process.env.TELEGRAM_SESSION || '');
  const client = new TelegramClient(session, apiId, apiHash, {
    connectionRetries: 5,
  });

  try {
    await client.start({ botAuthToken: botToken });
    console.log('[Telegram] Client connected');

    const dialogs = await client.getDialogs({});
    for (const dialog of dialogs) {
      console.log(`[Telegram] Dialog: "${dialog.title}" → @${dialog.entity.username || 'no-username'}`);
    }

    // Log session string on first connect so it can be saved to env
    const sessionStr = client.session.save();
    if (sessionStr && !process.env.TELEGRAM_SESSION) {
      console.log(`[Telegram] Save this session string to TELEGRAM_SESSION env var: ${sessionStr}`);
    }
  } catch (err) {
    console.error(`[Telegram] Failed to connect: ${err.message}`);
    return;
  }

  // Initial poll then every 60 seconds
  await poll(client);
  setInterval(() => poll(client), 60 * 1000);
}

module.exports = { startTelegramIngestion };
