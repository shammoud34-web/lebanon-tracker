const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  weekDate:     { type: Date,   required: true },
  admin1:       { type: String, required: true },
  eventType:    { type: String, required: true },
  subEventType: { type: String },
  disorderType: { type: String },
  events:       { type: Number, default: 0 },
  fatalities:   { type: Number, default: 0 },
  lat:          { type: Number },
  lng:          { type: Number },
});

// Prevent duplicate rows on re-import
schema.index({ weekDate: 1, admin1: 1, eventType: 1, subEventType: 1 }, { unique: true });

module.exports = mongoose.model('AcledEvent', schema);
