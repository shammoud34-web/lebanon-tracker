require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const mongoose = require('mongoose');
const XLSX = require('xlsx');
const path = require('path');

const AcledEvent   = require('../models/AcledEvent');
const AcledMonthly = require('../models/AcledMonthly');

const ROOT = path.join(__dirname, '..');

// Excel serial date → JS Date (UTC)
function excelDateToJS(serial) {
  return new Date((serial - 25569) * 86400 * 1000);
}

async function importGeoEvents() {
  console.log('\n[1/2] Importing geo events from Middle-East aggregated file…');
  const wb = XLSX.readFile(path.join(ROOT, 'Middle-East_aggregated_data_up_to-2026-02-28.xlsx'));
  const rows = XLSX.utils.sheet_to_json(wb.Sheets['Sheet1'], { defval: null });

  const lebanon = rows.filter(r => r.COUNTRY === 'Lebanon');
  console.log(`    Found ${lebanon.length} Lebanon rows`);

  let inserted = 0, skipped = 0;
  for (const r of lebanon) {
    try {
      await AcledEvent.updateOne(
        {
          weekDate:     excelDateToJS(r.WEEK),
          admin1:       r.ADMIN1,
          eventType:    r.EVENT_TYPE,
          subEventType: r.SUB_EVENT_TYPE || '',
        },
        {
          $setOnInsert: {
            weekDate:     excelDateToJS(r.WEEK),
            admin1:       r.ADMIN1,
            eventType:    r.EVENT_TYPE,
            subEventType: r.SUB_EVENT_TYPE || '',
            disorderType: r.DISORDER_TYPE || '',
            events:       r.EVENTS || 0,
            fatalities:   r.FATALITIES || 0,
            lat:          r.CENTROID_LATITUDE,
            lng:          r.CENTROID_LONGITUDE,
          },
        },
        { upsert: true }
      );
      inserted++;
    } catch (e) {
      if (e.code !== 11000) console.error('  Error:', e.message);
      skipped++;
    }
  }
  console.log(`    Done: ${inserted} upserted, ${skipped} skipped`);
}

async function importMonthly(file, dataType) {
  console.log(`\n[2/2] Importing monthly data: ${dataType} from ${file}…`);
  const wb = XLSX.readFile(path.join(ROOT, file));
  const rows = XLSX.utils.sheet_to_json(wb.Sheets['Data'], { defval: null });
  console.log(`    Found ${rows.length} rows`);

  let inserted = 0, skipped = 0;
  for (const r of rows) {
    try {
      const doc = new AcledMonthly({
        dataType,
        year:       Number(r.Year),
        month:      r.Month,
        events:     r.Events || 0,
        fatalities: r.Fatalities || 0,
      });
      // trigger pre-save hook for monthIndex
      await AcledMonthly.updateOne(
        { dataType, year: Number(r.Year), month: r.Month },
        {
          $setOnInsert: {
            dataType,
            year:       Number(r.Year),
            month:      r.Month,
            monthIndex: ['January','February','March','April','May','June',
                         'July','August','September','October','November','December'].indexOf(r.Month),
            events:     r.Events || 0,
            fatalities: r.Fatalities || 0,
          },
        },
        { upsert: true }
      );
      inserted++;
    } catch (e) {
      if (e.code !== 11000) console.error('  Error:', e.message);
      skipped++;
    }
  }
  console.log(`    Done: ${inserted} upserted, ${skipped} skipped`);
}

async function main() {
  console.log('[DB] Connecting…');
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('[DB] Connected');

  await importGeoEvents();
  await importMonthly(
    'lebanon_political_violence_events_and_fatalities_by_month-year_as-of-11mar2026.xlsx',
    'political_violence'
  );
  await importMonthly(
    'lebanon_civilian_targeting_events_and_fatalities_by_month-year_as-of-11mar2026.xlsx',
    'civilian_targeting'
  );

  console.log('\n✓ Import complete');
  await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
