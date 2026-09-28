const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const backendEnvPath = path.join(__dirname, '.env');
require('dotenv').config({
  path: fs.existsSync(backendEnvPath) ? backendEnvPath : path.join(__dirname, '..', '.env'),
});
const connectDatabase = require('./config/database');
const Category = require('./models/Category');
const MenuItem = require('./models/MenuItem');
const Comment = require('./models/Comment');
const {
  DEFAULT_CATEGORIES,
  canonicalCategoryName,
  findSeedFile,
  loadSeedMenu,
  repairCategoryKeys,
} = require('./menuSeed');

const app = express();
const PORT = Number(process.env.PORT || 4000);

const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');
dns.setServers(['8.8.8.8', '1.1.1.1']); // Uses Google & Cloudflare DNS

const DEFAULT_ADMIN_CREDENTIALS = [
  { email: 'admin@canoe.com', password: '1111' },
  { email: 'a@gmail.com', password: '1111' },
];

const dataDir = path.join(__dirname, 'data');
const dataFile = path.join(dataDir, 'store.json');
let useLocalStore = false;

/* ------------------------------------------------------------------ */
/* Local JSON fallback store (only used when MongoDB is unreachable)   */
/* ------------------------------------------------------------------ */

const makeDefaultStore = () => ({
  categories: [],
  menu: [],
  comments: [],
  adminCredentials: DEFAULT_ADMIN_CREDENTIALS,
});

const ensureStore = () => {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(dataFile)) fs.writeFileSync(dataFile, JSON.stringify(makeDefaultStore(), null, 2));
};

const writeStore = (nextStore) => {
  ensureStore();
  fs.writeFileSync(dataFile, JSON.stringify(nextStore, null, 2));
};

/* ------------------------------------------------------------------ */
/* Normalizers                                                         */
/* ------------------------------------------------------------------ */

const normalizeCategory = (value) => String(value || '').trim().replace(/\s+/g, ' ');

const splitMenuName = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return { name: '', amharicName: '' };

  if (raw.includes(' / ')) {
    const [amharicName, ...rest] = raw.split(' / ');
    return { amharicName: amharicName.trim(), name: rest.join(' / ').trim() };
  }

  const hasEthiopic = /[\u1200-\u137F\u1380-\u139F\u2D80-\u2DDF]/.test(raw);
  const hasLatin = /[A-Za-z]/.test(raw);
  if (!hasEthiopic || !hasLatin) return { name: raw, amharicName: '' };

  const latinIndex = raw.search(/[A-Za-z]/);
  if (latinIndex <= 0) return { name: raw, amharicName: '' };

  return { amharicName: raw.slice(0, latinIndex).trim(), name: raw.slice(latinIndex).trim() };
};

const normalizeMenuItem = (item) => {
  if (!item || typeof item !== 'object') return item;

  // Keep separate amharicName/name as given; only split when one field holds both scripts.
  const explicitAmharic = String(item.amharicName ?? '').trim();
  const explicitName = String(item.name ?? '').trim();
  const splitName = explicitAmharic && explicitName
    ? { name: explicitName, amharicName: explicitAmharic }
    : splitMenuName(explicitName || explicitAmharic);

  const record = {
    ...item,
    id: item.id || `item-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    name: splitName.name || explicitName || explicitAmharic,
    amharicName: splitName.amharicName || explicitAmharic,
    category: normalizeCategory(item.category),
    price: String(item.price ?? '').trim(),
    description: String(item.description ?? '').trim(),
  };

  if (!record.name && record.amharicName) {
    record.name = record.amharicName;
    record.amharicName = '';
  }
  return record;
};

const toMenuItem = (item) => {
  const normalized = normalizeMenuItem(item);
  return {
    id: normalized.id,
    name: normalized.name,
    amharicName: normalized.amharicName,
    category: normalized.category,
    price: normalized.price,
    description: normalized.description,
  };
};

const toComment = (comment) => ({
  id: comment.id,
  name: comment.name,
  text: comment.text,
  rating: comment.rating,
});

const readStore = () => {
  ensureStore();
  const raw = fs.readFileSync(dataFile, 'utf8').trim();

  let parsed = {};
  try {
    parsed = raw ? JSON.parse(raw) : {};
  } catch (error) {
    console.warn('Invalid store.json detected. Resetting to a clean catalog.');
    const safeStore = makeDefaultStore();
    writeStore(safeStore);
    return safeStore;
  }

  const rawCategories = Array.isArray(parsed.categories) ? parsed.categories : [];
  const categories = [...new Map(
    rawCategories
      .map((category) => {
        const normalized = normalizeCategory(category);
        return normalized ? [canonicalCategoryName(normalized), normalized] : null;
      })
      .filter(Boolean)
      .filter(([key]) => key && key !== 'All dishes')
  ).values()];

  return {
    categories,
    menu: (Array.isArray(parsed.menu) ? parsed.menu : []).map((item) => normalizeMenuItem({ ...item, category: normalizeCategory(item?.category) })),
    comments: Array.isArray(parsed.comments) ? parsed.comments : [],
    adminCredentials: Array.isArray(parsed.adminCredentials) && parsed.adminCredentials.length
      ? parsed.adminCredentials
      : DEFAULT_ADMIN_CREDENTIALS,
  };
};

/* ------------------------------------------------------------------ */
/* Data access (MongoDB, or local JSON fallback)                       */
/* ------------------------------------------------------------------ */

const getMenuItems = async () => {
  if (useLocalStore) {
    return readStore().menu
      .map((item, index) => ({ ...item, order: item.order ?? index }))
      .sort((first, second) => first.order - second.order);
  }
  return MenuItem.find().sort({ order: 1, createdAt: 1 }).lean();
};

const getCategoryNames = async () => {
  if (useLocalStore) return readStore().categories;
  return (await Category.find().sort({ order: 1, createdAt: 1 }).lean()).map((category) => category.name);
};

const getComments = async () => {
  if (useLocalStore) return readStore().comments;
  return (await Comment.find().sort({ createdAt: -1 }).lean()).map(toComment);
};

const ensureCategory = async (name) => {
  const normalizedName = normalizeCategory(name);
  const key = canonicalCategoryName(normalizedName);
  if (!key) return;

  if (useLocalStore) {
    const store = readStore();
    if (!store.categories.some((category) => canonicalCategoryName(category) === key)) {
      writeStore({ ...store, categories: [...store.categories, normalizedName] });
    }
    return;
  }

  const count = await Category.countDocuments();
  await Category.updateOne({ key }, { $setOnInsert: { name: normalizedName, order: count } }, { upsert: true });
};

/* ------------------------------------------------------------------ */
/* Startup seeding: only fills EMPTY storage, never overwrites data    */
/* ------------------------------------------------------------------ */

const seedCatalogIfEmpty = async () => {
  if (useLocalStore) {
    const store = readStore();
    const categories = store.categories.length ? [...store.categories] : [...DEFAULT_CATEGORIES];
    let menu = store.menu;

    if (!menu.length) {
      const { file, items, skipped, notes, error } = loadSeedMenu();
      notes.forEach((note) => console.warn(`Seed note: ${note}`));
      if (error) console.warn(`Seed: ${error}`);
      if (items.length) {
        menu = items.map((item, order) => ({ ...item, order }));
        console.log(`Seeded ${items.length} dishes from ${file} into local store.`);
        if (skipped.length) console.warn(`Skipped ${skipped.length} invalid rows.`);
      }
    }

    menu.forEach((item) => {
      const key = canonicalCategoryName(item.category);
      if (key && !categories.some((category) => canonicalCategoryName(category) === key)) categories.push(item.category);
    });

    writeStore({ ...store, categories, menu });
    return;
  }

  await repairCategoryKeys(Category);

  if (await Category.countDocuments() === 0) {
    await Category.insertMany(DEFAULT_CATEGORIES.map((name, order) => ({
      name,
      key: canonicalCategoryName(name),
      order,
    })));
    console.log(`Seeded ${DEFAULT_CATEGORIES.length} default categories.`);
  }

  if (await MenuItem.countDocuments() === 0) {
    const { file, items, skipped, notes, error } = loadSeedMenu();
      notes.forEach((note) => console.warn(`Seed note: ${note}`));
    if (error) {
      console.warn(`Seed: ${error}`);
    } else {
      await MenuItem.insertMany(items.map((item, order) => ({ ...item, order })), { ordered: false });
      console.log(`Seeded ${items.length} dishes from ${file}.`);
      if (skipped.length) {
        console.warn(`Skipped ${skipped.length} invalid rows:`);
        skipped.slice(0, 20).forEach((line) => console.warn(`  - ${line}`));
      }
    }
  }

  for (const category of await MenuItem.distinct('category')) {
    await ensureCategory(category);
  }
};

const isValidCustomerName = (value) => {
  if (!value || !String(value).trim()) return true;
  return /^[A-Za-z\s'-]+$/.test(String(value).trim());
};

/* ------------------------------------------------------------------ */
/* Express setup                                                       */
/* ------------------------------------------------------------------ */

// Forward async errors to the error handler so requests never hang.
const route = (handler) => (request, response, next) => Promise.resolve(handler(request, response, next)).catch(next);

app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', route(async (_request, response) => {
  response.json({
    status: 'ok',
    database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    storage: useLocalStore ? 'local' : 'mongodb',
    menuItems: (await getMenuItems()).length,
    categories: (await getCategoryNames()).length,
    seedFile: findSeedFile(),
  });
}));

/* ---- Categories ---- */

app.get('/api/categories', route(async (_request, response) => {
  response.json({ categories: await getCategoryNames() });
}));

app.post('/api/categories', route(async (request, response) => {
  const name = normalizeCategory(request.body?.name);
  if (!name) return response.status(400).json({ message: 'Category name is required.' });

  const key = canonicalCategoryName(name);
  const existing = useLocalStore
    ? (await getCategoryNames()).some((category) => canonicalCategoryName(category) === key)
    : await Category.findOne({ key });
  if (existing) return response.json({ categories: await getCategoryNames(), message: 'Category already exists.' });

  await ensureCategory(name);
  return response.status(201).json({ categories: await getCategoryNames(), message: 'Category added successfully.' });
}));

app.post('/api/categories/reorder', route(async (request, response) => {
  const order = Array.isArray(request.body?.order) ? request.body.order : [];
  const normalizedOrder = order.map((item) => normalizeCategory(item)).filter(Boolean);
  if (!normalizedOrder.length) return response.status(400).json({ message: 'Category order is required.' });

  const stored = await getCategoryNames();
  const seen = new Set();
  const nextCategories = [
    ...normalizedOrder,
    ...stored.filter((category) => !normalizedOrder.some((item) => canonicalCategoryName(item) === canonicalCategoryName(category))),
  ].filter((category) => {
    const key = canonicalCategoryName(category);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (useLocalStore) {
    writeStore({ ...readStore(), categories: nextCategories });
  } else {
    await Category.bulkWrite(nextCategories.map((name, index) => ({
      updateOne: {
        filter: { key: canonicalCategoryName(name) },
        update: { $set: { name, order: index, key: canonicalCategoryName(name) } },
        upsert: true,
      },
    })));
  }

  return response.json({ categories: await getCategoryNames(), message: 'Category order updated.' });
}));

app.delete('/api/categories/:name', route(async (request, response) => {
  const normalizedCategory = canonicalCategoryName(decodeURIComponent(request.params.name));
  if (!normalizedCategory) return response.status(400).json({ message: 'Category name is required.' });

  const items = await getMenuItems();
  const itemIds = items.filter((item) => canonicalCategoryName(item.category) === normalizedCategory).map((item) => item.id);

  if (useLocalStore) {
    const store = readStore();
    writeStore({
      ...store,
      categories: store.categories.filter((category) => canonicalCategoryName(category) !== normalizedCategory),
      menu: store.menu.filter((item) => !itemIds.includes(item.id)),
    });
  } else {
    await Promise.all([
      Category.deleteOne({ key: normalizedCategory }),
      MenuItem.deleteMany({ id: { $in: itemIds } }),
    ]);
  }

  return response.json({ categories: await getCategoryNames(), menu: (await getMenuItems()).map(toMenuItem), message: 'Category deleted successfully.' });
}));

/* ---- Menu ---- */

app.get('/api/menu', route(async (_request, response) => {
  response.json({ menu: (await getMenuItems()).map(toMenuItem), categories: await getCategoryNames() });
}));

app.post('/api/menu', route(async (request, response) => {
  const { name, amharicName, category, price, description } = request.body || {};
  const cleanedName = String(name || '').trim();
  const cleanedAmharicName = String(amharicName || '').trim();
  const cleanedCategory = normalizeCategory(category || '');
  const cleanedPrice = String(price || '').trim();
  const cleanedDescription = String(description || '').trim();

  if (!cleanedCategory) return response.status(400).json({ message: 'Category is required.' });
  if ((!cleanedName && !cleanedAmharicName) || !cleanedPrice) {
    return response.status(400).json({ message: 'At least one name (English or Amharic) and price are required.' });
  }

  const item = normalizeMenuItem({
    id: `item-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    name: cleanedName,
    amharicName: cleanedAmharicName,
    category: cleanedCategory,
    price: cleanedPrice,
    description: cleanedDescription,
  });

  const order = (await getMenuItems()).length;
  if (useLocalStore) {
    const store = readStore();
    writeStore({ ...store, menu: [...store.menu, { ...item, order }] });
  } else {
    await MenuItem.create({ ...item, order });
  }
  await ensureCategory(cleanedCategory);

  return response.status(201).json({ item: toMenuItem(item), menu: (await getMenuItems()).map(toMenuItem), categories: await getCategoryNames(), message: 'Menu item added successfully.' });
}));

app.put('/api/menu/:id', route(async (request, response) => {
  const itemId = request.params.id;
  const { name, amharicName, category, price, description } = request.body || {};

  const existingItem = useLocalStore
    ? (await getMenuItems()).find((item) => String(item.id) === String(itemId))
    : await MenuItem.findOne({ id: itemId }).lean();
  if (!existingItem) return response.status(404).json({ message: 'Menu item not found.' });

  const updatedItem = normalizeMenuItem({
    ...existingItem,
    name: String(name ?? existingItem.name ?? '').trim(),
    amharicName: String(amharicName ?? existingItem.amharicName ?? '').trim(),
    category: normalizeCategory(category || existingItem.category),
    price: String(price ?? existingItem.price).trim(),
    description: String(description ?? existingItem.description ?? '').trim(),
  });

  if ((!updatedItem.name && !updatedItem.amharicName) || !updatedItem.price) {
    return response.status(400).json({ message: 'At least one name (English or Amharic) and price are required.' });
  }

  if (useLocalStore) {
    const store = readStore();
    writeStore({
      ...store,
      menu: store.menu.map((item) => (String(item.id) === String(itemId) ? { ...item, ...updatedItem } : item)),
    });
  } else {
    await MenuItem.updateOne({ id: itemId }, {
      $set: {
        name: updatedItem.name,
        amharicName: updatedItem.amharicName,
        category: updatedItem.category,
        price: updatedItem.price,
        description: updatedItem.description,
      },
    });
  }
  await ensureCategory(updatedItem.category);

  return response.json({ item: toMenuItem(updatedItem), menu: (await getMenuItems()).map(toMenuItem), categories: await getCategoryNames(), message: 'Menu item updated.' });
}));

app.post('/api/menu/reorder', route(async (request, response) => {
  const order = Array.isArray(request.body?.order) ? request.body.order : [];
  if (!order.length) return response.status(400).json({ message: 'Order list is required.' });

  const items = await getMenuItems();
  const itemMap = new Map(items.map((item) => [String(item.id), item]));
  const nextMenu = order.map((id) => itemMap.get(String(id))).filter(Boolean);
  if (nextMenu.length !== items.length) return response.status(400).json({ message: 'Menu order could not be restored.' });

  if (useLocalStore) {
    writeStore({ ...readStore(), menu: nextMenu.map((item, index) => ({ ...item, order: index })) });
  } else {
    await MenuItem.bulkWrite(nextMenu.map((item, index) => ({
      updateOne: { filter: { id: item.id }, update: { $set: { order: index } } },
    })));
  }
  return response.json({ menu: nextMenu.map(toMenuItem), message: 'Menu order updated.' });
}));

app.delete('/api/menu/:id', route(async (request, response) => {
  const itemId = request.params.id;
  if (useLocalStore) {
    const store = readStore();
    writeStore({ ...store, menu: store.menu.filter((item) => String(item.id) !== String(itemId)) });
  } else {
    await MenuItem.deleteOne({ id: itemId });
  }
  return response.json({ menu: (await getMenuItems()).map(toMenuItem), message: 'Menu item deleted.' });
}));

/* ---- Comments (stored in MongoDB so they survive redeploys) ---- */

app.get('/api/comments', route(async (_request, response) => {
  response.json({ comments: await getComments() });
}));

app.post('/api/comments', route(async (request, response) => {
  const payload = request.body || {};
  const name = String(payload.name || '').trim();
  const text = String(payload.text || '').trim();
  const rating = Number(payload.rating || 0);

  if (!text || text.length < 3) return response.status(400).json({ message: 'Comment text is required.' });
  if (name && !isValidCustomerName(name)) {
    return response.status(400).json({ message: 'Name can only contain letters, spaces, apostrophes, and hyphens.' });
  }
  if (!Number.isFinite(rating) || rating < 0 || rating > 5) {
    return response.status(400).json({ message: 'Rating must be between 0 and 5.' });
  }

  const comment = {
    id: `comment-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    name: name || 'Anonymous guest',
    text,
    rating: Number.isInteger(rating) ? rating : 0,
  };

  if (useLocalStore) {
    const store = readStore();
    writeStore({ ...store, comments: [comment, ...store.comments] });
  } else {
    await Comment.create(comment);
  }

  return response.status(201).json({
    comment,
    message: 'Sent successfully. Thank you dear customer.',
    comments: await getComments(),
  });
}));

app.delete('/api/comments/:id', route(async (request, response) => {
  const commentId = request.params.id;
  if (useLocalStore) {
    const store = readStore();
    writeStore({ ...store, comments: store.comments.filter((comment) => String(comment.id) !== String(commentId)) });
  } else {
    await Comment.deleteOne({ id: commentId });
  }
  return response.json({ comments: await getComments(), message: 'Comment deleted.' });
}));

/* ---- Admin ---- */

app.post('/api/admin/login', (request, response) => {
  const email = String(request.body?.email || '').trim();
  const password = String(request.body?.password || '');
  const store = readStore();

  const match = store.adminCredentials.some((credential) => credential.email === email && credential.password === password);
  if (!match) return response.status(401).json({ message: 'Incorrect email or password.' });

  return response.json({ success: true, message: 'Admin login successful.' });
});

app.post('/api/admin/change-credentials', (request, response) => {
  const currentEmail = String(request.body?.currentEmail || '').trim();
  const currentPassword = String(request.body?.currentPassword || '');
  const newEmail = String(request.body?.newEmail || '').trim();
  const newPassword = String(request.body?.newPassword || '');
  const store = readStore();
  const credentialIndex = store.adminCredentials.findIndex((credential) => credential.email === currentEmail && credential.password === currentPassword);

  if (credentialIndex < 0) return response.status(401).json({ message: 'Current email or password is incorrect.' });
  if (!newEmail || !newPassword) return response.status(400).json({ message: 'New email and password are required.' });
  if (!/^\S+@\S+\.\S+$/.test(newEmail)) return response.status(400).json({ message: 'Enter a valid email address.' });
  if (newPassword.length < 4) return response.status(400).json({ message: 'Password must be at least 4 characters.' });

  const emailInUse = store.adminCredentials.some((credential, index) => index !== credentialIndex && credential.email === newEmail);
  if (emailInUse) return response.status(409).json({ message: 'That email is already in use.' });

  const adminCredentials = store.adminCredentials.map((credential, index) => (
    index === credentialIndex ? { email: newEmail, password: newPassword } : credential
  ));
  writeStore({ ...store, adminCredentials });

  return response.json({ success: true, message: 'Admin credentials updated successfully.' });
});

// Central error handler: always answer with JSON.
// eslint-disable-next-line no-unused-vars
app.use((error, _request, response, _next) => {
  console.error('Request failed:', error);
  response.status(500).json({ message: 'Something went wrong on the server.' });
});

/* ------------------------------------------------------------------ */
/* Start                                                               */
/* ------------------------------------------------------------------ */

const startServer = async () => {
  try {
    await connectDatabase();
  } catch (error) {
    useLocalStore = true;
    console.warn(`MongoDB unavailable; using ${path.relative(__dirname, dataFile)} for local data: ${error.message}`);
  }

  try {
    await seedCatalogIfEmpty();
  } catch (error) {
    console.error('Catalog seeding failed:', error);
  }

  app.listen(PORT, async () => {
    const dishes = (await getMenuItems()).length;
    console.log(`Backend is running on port ${PORT} (http://localhost:${PORT}) using ${useLocalStore ? 'local JSON storage' : 'MongoDB'} with ${dishes} dishes.`);
  });
};

startServer().catch((error) => {
  console.error('Backend startup failed:', error.message);
  process.exit(1);
});