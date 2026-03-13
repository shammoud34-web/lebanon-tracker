console.log('[Telegram] Module loaded');
const axios = require('axios');
const cheerio = require('cheerio');
const Incident = require('../models/Incident');
const { LEBANON_KEYWORDS } = require('./pipeline');

// Public Telegram channel usernames — verified via https://t.me/s/<username>
const CHANNELS = ['naharnet', 'AlHadath', 'AlMayadeen', 'alarabiya', 'MenchOsint', 'warmonitors', 'bintjbeilnews', 'MonitorX99', 'LBCI_NEWS', 'alakhbar_news', 'mayadeenchannel', 'IntelSlava'];

// Place-name keywords used for location extraction (subset of LEBANON_KEYWORDS)
const PLACE_KEYWORDS = [
  'beirut', 'tripoli', 'sidon', 'tyre', 'baalbek', 'nabatieh', 'zahle',
  'jounieh', 'chouf', 'akkar', 'marjayoun', 'hasbaya', 'rashaya', 'qana',
  'naqoura', 'qlayaat', 'hermel', 'bekaa', 'south lebanon', 'dahiyeh',
  'dahieh', 'haret hreik', 'ghobeiry', 'baabda', 'bint jbeil', 'khiyam', 'aita',
];

const LOCATION_COORDS = {
  'beirut':        { lat: 33.8938, lng: 35.5018 },
  'tripoli':       { lat: 34.4367, lng: 35.8497 },
  'sidon':         { lat: 33.5632, lng: 35.3712 },
  'tyre':          { lat: 33.2705, lng: 35.2038 },
  'baalbek':       { lat: 34.0042, lng: 36.2181 },
  'nabatieh':      { lat: 33.3779, lng: 35.4836 },
  'zahle':         { lat: 33.8500, lng: 35.9014 },
  'jounieh':       { lat: 33.9808, lng: 35.6178 },
  'chouf':         { lat: 33.6500, lng: 35.5833 },
  'akkar':         { lat: 34.5333, lng: 36.1000 },
  'marjayoun':     { lat: 33.3614, lng: 35.5922 },
  'hasbaya':       { lat: 33.3986, lng: 35.6847 },
  'rashaya':       { lat: 33.5033, lng: 35.8408 },
  'qana':          { lat: 33.2039, lng: 35.2969 },
  'naqoura':       { lat: 33.1167, lng: 35.1333 },
  'hermel':        { lat: 34.3931, lng: 36.3864 },
  'bekaa':         { lat: 33.8463, lng: 35.9014 },
  'dahiyeh':       { lat: 33.8547, lng: 35.4900 },
  'dahieh':        { lat: 33.8547, lng: 35.4900 },
  'bint jbeil':    { lat: 33.1194, lng: 35.4317 },
  'south lebanon': { lat: 33.2705, lng: 35.2038 },
  'lebanon':       { lat: 33.8547, lng: 35.8623 },
};

function extractLocation(text) {
  const lower = text.toLowerCase();
  return PLACE_KEYWORDS.find((p) => lower.includes(p)) || null;
}

function detectSeverity(text) {
  const lower = text.toLowerCase();
  if (['killed', 'dead', 'massacre', 'destroyed', 'bombed', 'airstrike', 'missile', 'explosion'].some((w) => lower.includes(w))) return 'critical';
  if (['wounded', 'injured', 'strike', 'attack', 'shelling', 'fire', 'clashes', 'troops'].some((w) => lower.includes(w))) return 'high';
  if (['displaced', 'evacuated', 'warning', 'threat', 'military'].some((w) => lower.includes(w))) return 'medium';
  return 'low';
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
  const locationName = extractLocation(text) || 'lebanon';
  const coords = LOCATION_COORDS[locationName.toLowerCase()] || LOCATION_COORDS['lebanon'];

  const incident = new Incident({
    title,
    summary: text,
    url,
    source: `@${username}`,
    severity: detectSeverity(text),
    location: { name: locationName, lat: coords.lat, lng: coords.lng },
    publishedAt: date,
  });

  try {
    await incident.save();
    console.log(`[Telegram] Saved (${severity}): "${title.slice(0, 60)}..."`);
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

  // Backfill existing Telegram incidents that have no coordinates
  try {
    const result = await Incident.updateMany(
      { source: { $regex: '^@' }, 'location.lat': null },
      { $set: { 'location.lat': 33.8547, 'location.lng': 35.8623 } }
    );
    console.log(`[Telegram] Backfilled coordinates for ${result.modifiedCount} existing incidents`);
  } catch (err) {
    console.error('[Telegram] Backfill failed:', err.message);
  }

  await poll();
  setInterval(poll, 60 * 1000);
}

module.exports = { startTelegramIngestion };
