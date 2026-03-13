console.log('[Telegram] Module loaded');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const Incident = require('../models/Incident');
const { LEBANON_KEYWORDS } = require('./pipeline');

const CHANNELS = [
  '1001002338106',
  '1001418480303',
  '1001006840823',
  '1001625429257',
  '1001917130438',
  '1001002129373',
  '1001246447757',
  '1002095217348',
  '1002108651705',
  '1001344300120',
];

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

async function fetchChannel(client, id) {
  try {
    const messages = await client.getMessages('-100' + id, { limit: 10 });
    console.log(`[Telegram] Fetched ${messages.length} messages from channel ${id}`);
    return messages;
  } catch (err) {
    console.error(`[Telegram] Failed to fetch channel ${id}: ${err.message}`);
    return [];
  }
}

async function processMessage(msg, id) {
  const text = msg.text || msg.message || '';
  if (!text.trim()) return;

  const lower = text.toLowerCase();
  const passes = LEBANON_KEYWORDS.some((kw) => lower.includes(kw.toLowerCase()));
  if (!passes) return;

  const url = `https://t.me/c/${id}/${msg.id}`;

  const exists = await Incident.exists({ url });
  if (exists) return;

  const title = text.slice(0, 100).replace(/\n/g, ' ');
  const locationName = extractLocation(text) || 'Lebanon';

  const incident = new Incident({
    title,
    summary: text,
    url,
    source: `tg:${id}`,
    severity: 'medium',
    location: { name: locationName },
    publishedAt: msg.date ? new Date(msg.date * 1000) : new Date(),
  });

  try {
    await incident.save();
    console.log(`[Telegram] Saved from channel ${id}: "${title.slice(0, 60)}..."`);
  } catch (err) {
    if (err.code === 11000) return; // duplicate
    console.error(`[Telegram] DB error saving from channel ${id}: ${err.message}`);
  }
}

async function poll(client) {
  for (const id of CHANNELS) {
    const messages = await fetchChannel(client, id);
    for (const msg of messages) {
      await processMessage(msg, id);
    }
  }
}

async function startTelegramIngestion() {
  try {
    const apiId = parseInt(process.env.TELEGRAM_API_ID, 10);
    const apiHash = process.env.TELEGRAM_API_HASH;

    if (!apiId || !apiHash || !process.env.TELEGRAM_SESSION) {
      console.warn('[Telegram] Missing credentials — ingestion disabled');
      return;
    }

    const session = new StringSession(process.env.TELEGRAM_SESSION);
    const client = new TelegramClient(session, apiId, apiHash, {
      connectionRetries: 5,
    });

    try {
      await client.connect();
      console.log('[Telegram] Client connected');

      if (!await client.isUserAuthorized()) {
        console.log('[Telegram] Not authorized — TELEGRAM_SESSION may be invalid');
        return;
      }

      console.log('[Telegram] User authorized');

      // Populate entity cache so numeric channel IDs can be resolved
      console.log('[Telegram] Starting dialog cache...');
      const dialogs = await client.getDialogs({});
      for (const dialog of dialogs) {
        const title = dialog.title || dialog.name || '(no title)';
        const username = dialog.entity?.username ? `@${dialog.entity.username}` : '(no username)';
        console.log(`[Telegram] Dialog: "${title}" → ${username}`);
      }
      console.log('[Telegram] Dialog cache complete, starting polling');
    } catch (err) {
      console.error(`[Telegram] Failed to connect: ${err.message}`);
      return;
    }

    // Initial poll then every 60 seconds
    await poll(client);
    setInterval(() => poll(client), 60 * 1000);
  } catch (err) {
    console.error('[Telegram] Unhandled startup error:', err);
  }
}

module.exports = { startTelegramIngestion };
