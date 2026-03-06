const mongoose = require('mongoose');

const incidentSchema = new mongoose.Schema({
  title: { type: String, required: true },
  summary: { type: String, required: true },
  url: { type: String, required: true, unique: true },
  source: { type: String, required: true },
  severity: { type: String, enum: ['critical', 'high', 'medium', 'low'], required: true },
  location: {
    name: { type: String, required: true },
    lat: { type: Number },
    lng: { type: Number },
  },
  publishedAt: { type: Date },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('Incident', incidentSchema);
