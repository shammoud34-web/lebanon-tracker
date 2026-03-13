require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const axios = require('axios');
const { startPipeline, runPipeline, getLastPipelineRun } = require('./ingestion/pipeline');
const Incident = require('./models/Incident');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

console.log('[DB] Connecting to:', process.env.MONGODB_URI?.substring(0, 40) + '...');
mongoose.connect(process.env.MONGODB_URI)
  .then(() => {
    console.log('MongoDB connected successfully');
    startPipeline();
  })
  .catch((err) => console.error('MongoDB connection error:', err));

// GET /incidents — returns incidents shaped for the frontend map
// Optional ?hours=N filters to incidents from the last N hours
app.get('/incidents', async (req, res) => {
  try {
    const query = {};
    const hours = parseInt(req.query.hours);
    if (hours > 0) {
      const since = new Date(Date.now() - hours * 60 * 60 * 1000);
      query.createdAt = { $gte: since };
    }

    const incidents = await Incident.find(query).sort({ createdAt: -1 });

    const data = incidents.map((inc) => ({
      id: inc._id.toString(),
      lat: inc.location?.lat ?? null,
      lng: inc.location?.lng ?? null,
      name: inc.location?.name ?? '',
      sev: inc.severity,
      date: inc.publishedAt
        ? new Date(inc.publishedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
        : new Date(inc.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      src: inc.source,
      desc: inc.summary,
    }));

    console.log(`[API] GET /incidents — returned ${data.length} incidents${hours > 0 ? ` (last ${hours}h)` : ''}`);
    res.json({ success: true, count: data.length, data });
  } catch (err) {
    console.error('[API] Error fetching incidents:', err.message);
    res.status(500).json({ success: false, error: 'Failed to fetch incidents' });
  }
});

// GET /incidents/stats — summary counts and metadata
app.get('/incidents/stats', async (req, res) => {
  try {
    const [total, bySeverity, mostRecent] = await Promise.all([
      Incident.countDocuments(),
      Incident.aggregate([
        { $group: { _id: '$severity', count: { $sum: 1 } } },
      ]),
      Incident.findOne().sort({ createdAt: -1 }).select('createdAt'),
    ]);

    const severityCounts = { critical: 0, high: 0, medium: 0 };
    for (const { _id, count } of bySeverity) {
      if (_id in severityCounts) severityCounts[_id] = count;
    }

    const mostAffected = await Incident.aggregate([
      { $group: { _id: '$location.name', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 1 },
    ]);

    res.json({
      success: true,
      total,
      bySeverity: severityCounts,
      mostRecentDate: mostRecent?.createdAt ?? null,
      mostAffectedLocation: mostAffected[0]?._id ?? null,
    });
  } catch (err) {
    console.error('[API] Error fetching stats:', err.message);
    res.status(500).json({ success: false, error: 'Failed to fetch stats' });
  }
});

// Flight cache
let flightCache = null;
let flightCacheTime = 0;
const FLIGHT_CACHE_TTL = 30 * 1000;

// GET /flights — live aircraft in Lebanese airspace via OpenSky Network
app.get('/flights', async (req, res) => {
  try {
    const now = Date.now();
    if (flightCache && (now - flightCacheTime) < FLIGHT_CACHE_TTL) {
      return res.json({ success: true, cached: true, data: flightCache });
    }

    const response = await axios.get(
      'https://opensky-network.org/api/states/all?lamin=33.0&lomin=35.1&lamax=34.7&lomax=36.6',
      { timeout: 10000 }
    );

    const states = response.data.states || [];

    // Each state: [icao24, callsign, origin_country, time_position, last_contact,
    //              longitude, latitude, baro_altitude, on_ground, velocity,
    //              true_track, vertical_rate, sensors, geo_altitude, squawk, spi, position_source]
    const flights = states
      .map(s => ({
        icao:      s[0],
        callsign:  s[1]?.trim() || null,
        lat:       s[6],
        lng:       s[5],
        altitude:  s[7],
        velocity:  s[9],
        heading:   s[10],
        onGround:  s[8],
        squawk:    s[14] || null,
      }))
      .filter(f => f.lat != null && f.lng != null);

    flightCache = flights;
    flightCacheTime = now;

    console.log(`[API] GET /flights — returned ${flights.length} aircraft`);
    res.json({ success: true, cached: false, data: flights });
  } catch (err) {
    console.error('[API] Error fetching flights:', err.message);
    if (flightCache) {
      return res.json({ success: true, cached: true, stale: true, data: flightCache });
    }
    res.status(500).json({ success: false, error: 'Failed to fetch flight data' });
  }
});

// GET /config — public client configuration
app.get('/config', (req, res) => {
  res.json({ mapboxToken: process.env.MAPBOX_TOKEN });
});

app.get('/', (_req, res) => {
  res.sendFile(__dirname + '/index.html');
});

// GET /health — server status and last pipeline run time
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    lastPipelineRun: getLastPipelineRun()?.toISOString() ?? null,
  });
});

app.listen(PORT, () => {
  console.log(`Lebanon Tracker API running on http://localhost:${PORT}`);
});
