const fs = require('fs');
const path = require('path');

const dataFile = path.join(__dirname, 'data', 'store.json');
const payload = {
  categories: [],
  menu: [],
  comments: [],
};

fs.writeFileSync(dataFile, JSON.stringify(payload, null, 2));
console.log('Reset store.json to an empty menu catalog with no hardcoded categories, foods, or comments.');
