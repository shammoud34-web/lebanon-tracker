const XLSX = require('xlsx');
const path = require('path');
const fs = require('fs');

const root = path.join(__dirname, '..');
const files = fs.readdirSync(root).filter(f => f.endsWith('.xlsx'));

for (const file of files) {
  console.log('\n' + '='.repeat(60));
  console.log('File:', file);

  const wb = XLSX.readFile(path.join(root, file));

  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: null });

    const headers = rows.length ? Object.keys(rows[0]) : [];
    console.log(`\n  Sheet: "${sheetName}" (${rows.length} rows)`);
    console.log('  Columns:', JSON.stringify(headers, null, 2));
    console.log('  First 3 rows:', JSON.stringify(rows.slice(0, 3), null, 2));
  }
}
