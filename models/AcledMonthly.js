const mongoose = require('mongoose');

const MONTH_ORDER = ['January','February','March','April','May','June',
                     'July','August','September','October','November','December'];

const schema = new mongoose.Schema({
  dataType:   { type: String, enum: ['political_violence', 'civilian_targeting'], required: true },
  year:       { type: Number, required: true },
  month:      { type: String, required: true },
  monthIndex: { type: Number },   // 0-11, stored for easy sorting
  events:     { type: Number, default: 0 },
  fatalities: { type: Number, default: 0 },
});

schema.pre('save', function (next) {
  this.monthIndex = MONTH_ORDER.indexOf(this.month);
  next();
});

schema.index({ dataType: 1, year: 1, month: 1 }, { unique: true });

module.exports = mongoose.model('AcledMonthly', schema);
