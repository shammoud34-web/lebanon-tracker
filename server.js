require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const { startPipeline, runPipeline, getLastPipelineRun } = require('./ingestion/pipeline');
const Incident = require('./models/Incident');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

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

// GET /config — public client configuration
app.get('/config', (req, res) => {
  res.json({ mapboxToken: process.env.MAPBOX_TOKEN });
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
