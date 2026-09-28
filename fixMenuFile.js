// Rewrites your food file as ONE clean, valid JSON array.
// Usage: node fixMenuFile.js
// A backup of the original is saved next to it as menuData.json.bak
const fs = require('fs');
const path = require('path');
const { loadSeedMenu, DATA_DIR } = require('./menuSeed');

const { file, items, skipped, notes, error } = loadSeedMenu();
if (error) {
  console.error(error);
  process.exit(1);
}

fs.mkdirSync(DATA_DIR, { recursive: true });
const target = path.join(DATA_DIR, 'menuData.json');

fs.copyFileSync(file, `${target}.bak`);
fs.writeFileSync(target, `${JSON.stringify(items, null, 2)}\n`, 'utf8');

notes.forEach((note) => console.log(`Fixed: ${note}`));
if (skipped.length) {
  console.warn(`Skipped ${skipped.length} invalid rows:`);
  skipped.forEach((line) => console.warn(`  - ${line}`));
}
console.log(`Wrote ${items.length} dishes to ${target} (backup: ${target}.bak)`);