// Usage:
//   node seed.js           add dishes that are missing (never touches existing ones)
//   node seed.js --force   also overwrite existing dishes with values from menuData.json
const fs = require('fs');
const path = require('path');
const backendEnvPath = path.join(__dirname, '.env');
require('dotenv').config({
  path: fs.existsSync(backendEnvPath) ? backendEnvPath : path.join(__dirname, '..', '.env'),
});
const mongoose = require('mongoose');
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');
dns.setServers(['8.8.8.8', '1.1.1.1']);
const connectDatabase = require('./config/database');
const Category = require('./models/Category');
const MenuItem = require('./models/MenuItem');
const {
  DEFAULT_CATEGORIES,
  canonicalCategoryName,
  loadSeedMenu,
  repairCategoryKeys,
  hashId,
} = require('./menuSeed');

const force = process.argv.includes('--force');
const contentKeyOf = (item) => `${item.category}|${item.name}|${item.amharicName || ''}`.toLowerCase();

const ensureCategories = async (names) => {
  const existingCount = await Category.countDocuments();
  const ops = names.map((name, index) => ({
    updateOne: {
      filter: { key: canonicalCategoryName(name) },
      update: { $setOnInsert: { name, order: existingCount + index } },
      upsert: true,
    },
  }));
  if (ops.length) await Category.bulkWrite(ops);
};

const run = async () => {
  await connectDatabase();
  console.log('Connected to MongoDB.');

  await repairCategoryKeys(Category);

  const { file, items, skipped, notes, error } = loadSeedMenu();
  if (error) throw new Error(error);
  console.log(`Reading ${items.length} dishes from ${file}`);
  notes.forEach((note) => console.warn(`Note: ${note}`));
  if (skipped.length) {
    console.warn(`Skipped ${skipped.length} invalid rows:`);
    skipped.slice(0, 20).forEach((line) => console.warn(`  - ${line}`));
  }

  if (await Category.countDocuments() === 0) await ensureCategories(DEFAULT_CATEGORIES);
  await ensureCategories([...new Set(items.map((item) => item.category))]);

  // Match by dish content (not id) so a dish already in the database is never duplicated.
  const existing = await MenuItem.find({}, 'id category name amharicName').lean();
  const existingByKey = new Map(existing.map((doc) => [contentKeyOf(doc), doc]));
  const usedIds = new Set(existing.map((doc) => doc.id));
  const start = existing.length;

  const toInsert = [];
  const toUpdate = [];

  items.forEach((item) => {
    const match = existingByKey.get(contentKeyOf(item));
    if (match) {
      if (force) toUpdate.push({ id: match.id, item });
      return;
    }
    let id = item.id;
    if (usedIds.has(id)) id = hashId(contentKeyOf(item));
    usedIds.add(id);
    toInsert.push({ ...item, id });
  });

  if (toInsert.length) {
    await MenuItem.insertMany(toInsert.map((item, index) => ({ ...item, order: start + index })), { ordered: false });
  }
  if (toUpdate.length) {
    await MenuItem.bulkWrite(toUpdate.map(({ id, item }) => ({
      updateOne: {
        filter: { id },
        update: { $set: { name: item.name, amharicName: item.amharicName, category: item.category, price: item.price, description: item.description } },
      },
    })));
  }

  console.log(`Added ${toInsert.length} new dishes. ${force ? `Updated ${toUpdate.length} existing.` : `${items.length - toInsert.length} already existed and were left untouched.`}`);
  console.log(`Total dishes in database: ${await MenuItem.countDocuments()}`);
};

run()
  .then(() => mongoose.disconnect())
  .catch(async (error) => {
    console.error('Seeding failed:', error.message);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  });