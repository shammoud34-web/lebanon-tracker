const cron = require('node-cron');
const RSSParser = require('rss-parser');
const Groq = require('groq-sdk');
const axios = require('axios');
const Incident = require('../models/Incident');

const rssParser = new RSSParser({
  headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NewsBot/1.0)' },
});

const RSS_FEEDS = [
  { url: 'https://www.aljazeera.com/xml/rss/all.xml', source: 'aljazeera' },
  { url: 'https://feeds.bbci.co.uk/news/world/middle_east/rss.xml', source: 'bbc' },
  { url: 'https://www.972mag.com/feed/', source: '972mag' },
  { url: 'https://rss.nytimes.com/services/xml/rss/nyt/MiddleEast.xml', source: 'nytimes' },
];

const LEBANON_KEYWORDS = [
  'lebanon', 'lebanese', 'beirut', 'dahiyeh', 'hezbollah', 'nabatieh', 'bekaa',
  'south lebanon', 'sidon', 'tyre', 'baalbek', 'haret hreik', 'dahieh',
  'aita', 'khiyam', 'bint jbeil', 'tripoli', 'zahlé', 'zahle', 'baabda',
  'ghobeiry', 'hermel', 'jounieh', 'chouf', 'akkar', 'marjayoun',
  'hasbaya', 'rashaya', 'qana', 'naqoura', 'qlayaat',
];

const CLASSIFY_PROMPT = `You are an incident classifier for Lebanon. Given a news article, extract:
- locationName: the most specific location in Lebanon mentioned (neighbourhood, town, city, or region). If no specific place, use "Lebanon".
- severity: one of critical / high / medium / low.
  critical = confirmed deaths, mass casualties, or mass displacement.
  high = active airstrikes, explosions, armed clashes, or military operations.
  medium = evacuation orders, warnings, troop movements, infrastructure damage, or armed group activity.
  low = general conflict reports, political/military statements, or background context.
- summary: one sentence describing what happened.

Classify as a security incident if the article involves ANY of: airstrikes, shelling, explosions, military operations, armed clashes, casualties, displacement, kidnappings, arrests of militants, infrastructure damage, armed group activity, ceasefire violations, or ongoing conflict developments — even if it is a news overview rather than a single specific event.

Only return null if the article is entirely unrelated to security, conflict, or military activity in Lebanon (e.g. sports, culture, business, weather).
Respond in JSON only, no other text.`;

const HIGH_SIGNAL_WORDS = [
  'strike', 'attack', 'killed', 'wounded', 'airstrike', 'missile', 'rocket',
  'explosion', 'shelling', 'displaced', 'invasion', 'troops', 'military', 'bombing',
];

function passesKeywordFilter(title, content, url) {
  const text = `${title} ${content} ${url || ''}`.toLowerCase();
  return LEBANON_KEYWORDS.some((kw) => text.includes(kw.toLowerCase()));
}

function hasHighSignalWord(title) {
  const lower = title.toLowerCase();
  return HIGH_SIGNAL_WORDS.some((w) => lower.includes(w));
}

async function classifyArticle(title, content) {
  const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
  console.log(`[Groq] Classifying: "${title}"`);
  const response = await groq.chat.completions.create({
    model: 'llama-3.1-8b-instant',
    max_tokens: 256,
    messages: [
      {
        role: 'user',
        content: `${CLASSIFY_PROMPT}\n\nTitle: ${title}\n\nContent: ${content}`,
      },
    ],
  });

  const text = response.choices[0].message.content.trim();
  if (text === 'null') return null;

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    console.warn(`[Groq] Failed to parse response: ${text}`);
    return null;
  }

  // Normalize severity to lowercase and validate required fields
  if (parsed.severity) parsed.severity = parsed.severity.toLowerCase();
  if (!parsed.locationName || !parsed.severity || !parsed.summary) return null;

  return parsed;
}

const LEBANON_BOUNDS = { latMin: 33.0, latMax: 34.7, lngMin: 35.1, lngMax: 36.6 };

function isWithinLebanon({ lat, lng }) {
  return lat >= LEBANON_BOUNDS.latMin && lat <= LEBANON_BOUNDS.latMax
    && lng >= LEBANON_BOUNDS.lngMin && lng <= LEBANON_BOUNDS.lngMax;
}

async function geocode(locationName) {
  console.log(`[OpenCage] Geocoding: "${locationName}"`);
  const response = await axios.get('https://api.opencagedata.com/geocode/v1/json', {
    params: {
      q: `${locationName}, Lebanon`,
      key: process.env.OPENCAGE_API_KEY,
      limit: 1,
      countrycode: 'lb',
    },
  });

  const results = response.data.results;
  if (!results || results.length === 0) {
    console.warn(`[OpenCage] No results for "${locationName}"`);
    return null;
  }

  const { lat, lng } = results[0].geometry;

  if (!isWithinLebanon({ lat, lng })) {
    console.warn(`[OpenCage] Coordinates (${lat}, ${lng}) for "${locationName}" are outside Lebanon, discarding`);
    return null;
  }

  console.log(`[OpenCage] Found coordinates for "${locationName}": ${lat}, ${lng}`);
  return { lat, lng };
}

async function saveIncident({ title, summary, url, source, severity, locationName, coords, pubDate }) {
  const incident = new Incident({
    title,
    summary,
    url,
    source,
    severity,
    location: {
      name: locationName,
      lat: coords?.lat,
      lng: coords?.lng,
    },
    publishedAt: pubDate ? new Date(pubDate) : null,
  });

  try {
    await incident.save();
    console.log(`[DB] Saved incident: "${title}"`);
  } catch (err) {
    if (err.code === 11000) {
      console.log(`[DB] Duplicate key, skipping: ${url}`);
    } else {
      console.error(`[DB] Error saving incident:`, err.message);
    }
  }
}

async function processArticle({ title, url, content, pubDate, source }) {
  if (!url) return;

  const exists = await Incident.exists({ url });
  if (exists) {
    console.log(`[DB] Skipping duplicate: ${url}`);
    return;
  }

  if (!passesKeywordFilter(title, content, url)) {
    console.log(`[Filter] No Lebanon keyword, skipping: "${title}"`);
    return;
  }

  console.log(`[Filter] Passed keyword filter: "${title}"`);

  // Skip Groq for articles without high-signal conflict words to save API calls
  if (!hasHighSignalWord(title)) {
    console.log(`[Filter] No high-signal word, saving directly without Groq: "${title}"`);
    await saveIncident({
      title,
      summary: title,
      url,
      source,
      severity: 'low',
      locationName: 'Lebanon',
      coords: null,
      pubDate,
    });
    return;
  }

  let classification;
  try {
    classification = await classifyArticle(title, content);
  } catch (err) {
    console.error(`[Groq] Error classifying "${title}":`, err.message);
    return;
  }

  if (!classification) {
    console.log(`[Groq] Not a security incident, skipping: "${title}"`);
    return;
  }

  console.log(`[Groq] Classified as ${classification.severity} at ${classification.locationName}`);

  if (!['medium', 'high', 'critical'].includes(classification.severity)) {
    console.log(`[Filter] Dropping low severity incident: "${title}"`);
    return;
  }

  let coords = null;
  try {
    coords = await geocode(classification.locationName);
  } catch (err) {
    console.error(`[OpenCage] Error geocoding "${classification.locationName}":`, err.message);
  }

  await saveIncident({
    title,
    summary: classification.summary,
    url,
    source,
    severity: classification.severity,
    locationName: classification.locationName,
    coords,
    pubDate,
  });
}

async function processFeed({ url, source }) {
  console.log(`[RSS] Fetching feed: ${url}`);
  let feed;
  try {
    feed = await rssParser.parseURL(url);
  } catch (err) {
    console.error(`[RSS] Failed to fetch ${url}:`, err.message);
    return;
  }

  console.log(`[RSS] Got ${feed.items.length} articles from ${source}`);

  for (const item of feed.items) {
    const articleUrl = item.link || item.guid;
    const content = item.contentSnippet || item.content || item.summary || item.description || '';
    await processArticle({
      title: item.title,
      url: articleUrl,
      content,
      pubDate: item.pubDate,
      source,
    });
  }
}

let lastPipelineRun = null;

async function runPipeline() {
  console.log('[Pipeline] Starting ingestion run...');
  for (const feed of RSS_FEEDS) {
    await processFeed(feed);
  }
  lastPipelineRun = new Date();
  console.log('[Pipeline] Ingestion run complete.');
}

function startPipeline() {
  console.log('[Pipeline] Scheduling ingestion every 5 minutes.');
  runPipeline();
  cron.schedule('*/5 * * * *', runPipeline);
}

function getLastPipelineRun() {
  return lastPipelineRun;
}

module.exports = { startPipeline, runPipeline, getLastPipelineRun, LEBANON_KEYWORDS };
