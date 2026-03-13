console.log('[Telegram] Module loaded');
const axios = require('axios');
const cheerio = require('cheerio');
const Incident = require('../models/Incident');
const { LEBANON_KEYWORDS } = require('./pipeline');

// Public Telegram channel usernames — verified via https://t.me/s/<username>
const CHANNELS = ['naharnet', 'AlHadath', 'AlMayadeen', 'alarabiya', 'MenchOsint', 'warmonitors', 'bintjbeilnews', 'MonitorX99', 'LBCI_NEWS', 'alakhbar_news', 'mayadeenchannel'];

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

async function fetchChannel(username) {
  const url = `https://t.me/s/${username}`;
  try {
    const { data } = await axios.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NewsBot/1.0)' },
      timeout: 10000,
    });
    const $ = cheerio.load(data);
    const messages = [];
    $('.tgme_widget_message_wrap').each((_, el) => {
      const text = $(el).find('.tgme_widget_message_text').text().trim();
      const href = $(el).find('.tgme_widget_message_date').attr('href') || '';
      const dateStr = $(el).find('.tgme_widget_message_date time').attr('datetime') || '';
      if (text && href) {
        messages.push({ text, url: href, date: dateStr ? new Date(dateStr) : new Date() });
      }
    });
    console.log(`[Telegram] Scraped ${messages.length} messages from @${username}`);
    return messages;
  } catch (err) {
    console.error(`[Telegram] Failed to scrape @${username}: ${err.message}`);
    return [];
  }
}

async function processMessage({ text, url, date }, username) {
  if (!text.trim()) return;

  const lower = text.toLowerCase();
  const passes = LEBANON_KEYWORDS.some((kw) => lower.includes(kw.toLowerCase()));
  if (!passes) return;

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
    publishedAt: date,
  });

  try {
    await incident.save();
    console.log(`[Telegram] Saved: "${title.slice(0, 60)}..."`);
  } catch (err) {
    if (err.code === 11000) return; // duplicate
    console.error(`[Telegram] DB error saving from @${username}: ${err.message}`);
  }
}

async function poll() {
  for (const username of CHANNELS) {
    const messages = await fetchChannel(username);
    for (const msg of messages) {
      await processMessage(msg, username);
    }
  }
}

async function startTelegramIngestion() {
  console.log('[Telegram] Starting web scrape ingestion (no auth required)');
  await poll();
  setInterval(poll, 60 * 1000);
}

module.exports = { startTelegramIngestion };
