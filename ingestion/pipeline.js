const cron = require('node-cron');
const RSSParser = require('rss-parser');
const Groq = require('groq-sdk');
const axios = require('axios');
const Incident = require('../models/Incident');

const rssParser = new RSSParser();

const RSS_FEEDS = [
  { url: 'https://www.aljazeera.com/xml/rss/all.xml', source: 'aljazeera' },
  { url: 'https://feeds.bbci.co.uk/news/world/middle_east/rss.xml', source: 'bbc' },
  { url: 'https://www.naharnet.com/stories/en/rss.xml', source: 'naharnet' },
  { url: 'https://feeds.reuters.com/Reuters/worldNews', source: 'reuters' },
  { url: 'https://today.lorientlejour.com/feed', source: 'lorient' },
];

const LEBANON_KEYWORDS = [
  'lebanon', 'beirut', 'dahiyeh', 'hezbollah', 'nabatieh', 'bekaa',
  'south lebanon', 'sidon', 'tyre', 'baalbek', 'haret hreik', 'dahieh',
  'aita', 'khiyam', 'bint jbeil', 'tripoli', 'zahlé', 'zahle', 'baabda',
  'ghobeiry', 'hermel', 'zahle', 'jounieh', 'chouf', 'akkar', 'marjayoun',
  'hasbaya', 'rashaya', 'qana', 'naqoura', 'qlayaat',
];

const CLASSIFY_PROMPT = `You are an incident classifier for Lebanon. Given this news article, extract:
- locationName: the most specific location mentioned in Lebanon (neighbourhood, town or city)
- severity: one of critical / high / medium / low. Critical = confirmed deaths or mass displacement. High = active strikes or explosions. Medium = evacuation orders or warnings. Low = general reports.
- summary: one sentence description of the incident
If the article is not about a security incident in Lebanon, return null.
Respond in JSON only, no other text.`;

function passesKeywordFilter(title, content) {
  const text = `${title} ${content}`.toLowerCase();
  return LEBANON_KEYWORDS.some((kw) => text.includes(kw));
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

  if (!passesKeywordFilter(title, content)) {
    console.log(`[Filter] No Lebanon keyword, skipping: "${title}"`);
    return;
  }

  console.log(`[Filter] Passed keyword filter: "${title}"`);

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
    const content = item.contentSnippet || item.content || item.summary || '';
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

module.exports = { startPipeline, runPipeline, getLastPipelineRun };
