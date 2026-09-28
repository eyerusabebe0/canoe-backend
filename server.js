const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const connectDatabase = require('./config/database');
const Category = require('./models/Category');
const MenuItem = require('./models/MenuItem');

const app = express();
const PORT = Number(process.env.PORT || 4000);

const DEFAULT_ADMIN_CREDENTIALS = [
  { email: 'admin@canoe.com', password: '1111' },
  { email: 'a@gmail.com', password: '1111' },
];

const dataDir = path.join(__dirname, 'data');
const dataFile = path.join(dataDir, 'store.json');
let useLocalStore = false;

const makeDefaultStore = () => ({
  categories: [],
  menu: [],
  comments: [],
  adminCredentials: DEFAULT_ADMIN_CREDENTIALS,
});

const ensureStore = () => {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  if (!fs.existsSync(dataFile)) {
    fs.writeFileSync(dataFile, JSON.stringify(makeDefaultStore(), null, 2));
  }
};

const writeStore = (nextStore) => {
  ensureStore();
  fs.writeFileSync(dataFile, JSON.stringify(nextStore, null, 2));
};

const canonicalCategoryName = (value) => {
  const next = String(value || '').trim();
  if (!next) {
    return '';
  }

  const normalized = next.replace(/\s+/g, ' ');

  if (normalized.includes(' / ')) {
    const parts = normalized.split(' / ').map((part) => part.trim()).filter(Boolean);
    return (parts.at(-1) || normalized).replace(/\s+/g, ' ');
  }

  return normalized;
};

const normalizeCategory = (value) => {
  const next = String(value || '').trim();
  if (!next) {
    return '';
  }

  return next.replace(/\s+/g, ' ');
};

const splitMenuName = (value) => {
  const raw = String(value || '').trim();
  if (!raw) {
    return { name: '', amharicName: '' };
  }

  if (raw.includes(' / ')) {
    const [amharicName, ...rest] = raw.split(' / ');
    return {
      amharicName: amharicName.trim(),
      name: rest.join(' / ').trim(),
    };
  }

  const hasEthiopic = /[\u1200-\u137F\u1380-\u139F\u2D80-\u2DDF]/.test(raw);
  const hasLatin = /[A-Za-z]/.test(raw);

  if (!hasEthiopic || !hasLatin) {
    return { name: raw, amharicName: '' };
  }

  const latinIndex = raw.search(/[A-Za-z]/);
  if (latinIndex <= 0) {
    return { name: raw, amharicName: '' };
  }

  return {
    amharicName: raw.slice(0, latinIndex).trim(),
    name: raw.slice(latinIndex).trim(),
  };
};

const normalizeMenuItem = (item) => {
  if (!item || typeof item !== 'object') {
    return item;
  }

  const splitName = splitMenuName(String(item.name ?? item.amharicName ?? ''));
  const record = {
    ...item,
    id: item.id || `item-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    name: splitName.name || String(item.name ?? '').trim() || String(item.amharicName ?? '').trim(),
    amharicName: splitName.amharicName || String(item.amharicName ?? '').trim(),
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

const getMenuItems = async () => {
  if (useLocalStore) {
    return readStore().menu
      .map((item, index) => ({ ...item, order: item.order ?? index }))
      .sort((first, second) => first.order - second.order);
  }

  return MenuItem.find().sort({ order: 1, createdAt: 1 }).lean();
};

const getCategoryNames = async () => {
  if (useLocalStore) {
    return readStore().categories;
  }

  return (await Category.find().sort({ order: 1, createdAt: 1 }).lean())
    .map((category) => category.name);
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

  const existing = await Category.findOne({ key });
  if (!existing) {
    const count = await Category.countDocuments();
    await Category.create({ name: normalizedName, key, order: count });
  }
};

const initializeCatalog = async () => {
  const legacyStore = readStore();

  if (await Category.countDocuments() === 0 && legacyStore.categories.length) {
    await Category.insertMany(legacyStore.categories.map((name, order) => ({
      name,
      key: canonicalCategoryName(name),
      order,
    })));
  }

  if (await MenuItem.countDocuments() === 0 && legacyStore.menu.length) {
    await MenuItem.insertMany(legacyStore.menu.map((item, order) => ({
      ...normalizeMenuItem(item),
      order,
    })));
  }
};

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

const isValidCustomerName = (value) => {
  if (!value || !String(value).trim()) return true;
  return /^[A-Za-z\s'-]+$/.test(String(value).trim());
};

app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', async (_request, response) => {
  const isConnected = mongoose.connection.readyState === 1;
  return response.json({
    status: 'ok',
    database: isConnected ? 'connected' : 'disconnected',
    storage: useLocalStore ? 'local' : 'mongodb',
  });
});

app.post('/api/categories', async (request, response) => {
  const name = normalizeCategory(request.body?.name);

  if (!name) {
    return response.status(400).json({ message: 'Category name is required.' });
  }

  const key = canonicalCategoryName(name);
  const existing = useLocalStore
    ? (await getCategoryNames()).some((category) => canonicalCategoryName(category) === key)
    : await Category.findOne({ key });
  if (existing) {
    return response.json({ categories: await getCategoryNames(), message: 'Category already exists.' });
  }

  await ensureCategory(name);

  return response.status(201).json({ categories: await getCategoryNames(), message: 'Category added successfully.' });
});

app.post('/api/categories/reorder', async (request, response) => {
  const order = Array.isArray(request.body?.order) ? request.body.order : [];
  const normalizedOrder = order.map((item) => normalizeCategory(item)).filter(Boolean);

  if (!normalizedOrder.length) {
    return response.status(400).json({ message: 'Category order is required.' });
  }

  const storedCategoryNames = await getCategoryNames();
  const seen = new Set();
  const nextCategories = [...normalizedOrder, ...storedCategoryNames.filter((category) => !normalizedOrder.some((item) => canonicalCategoryName(item) === canonicalCategoryName(category)))]
    .filter((category) => {
      const key = canonicalCategoryName(category);
      if (!key || seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });

  if (useLocalStore) {
    const store = readStore();
    writeStore({ ...store, categories: nextCategories });
  } else {
    await Category.bulkWrite(nextCategories.map((name, order) => ({
      updateOne: {
        filter: { key: canonicalCategoryName(name) },
        update: { $set: { name, order, key: canonicalCategoryName(name) } },
        upsert: true,
      },
    })));
  }

  return response.json({ categories: await getCategoryNames(), message: 'Category order updated.' });
});

app.delete('/api/categories/:name', async (request, response) => {
  const categoryName = decodeURIComponent(request.params.name);
  const normalizedCategory = canonicalCategoryName(categoryName);

  if (!normalizedCategory) {
    return response.status(400).json({ message: 'Category name is required.' });
  }

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
});

app.get('/api/menu', async (_request, response) => {
  response.json({ menu: (await getMenuItems()).map(toMenuItem), categories: await getCategoryNames() });
});

app.post('/api/menu', async (request, response) => {
  const { name, amharicName, category, price, description } = request.body || {};
  const cleanedName = String(name || '').trim();
  const cleanedAmharicName = String(amharicName || '').trim();
  const cleanedCategory = normalizeCategory(category || '');
  const cleanedPrice = String(price || '').trim();
  const cleanedDescription = String(description || '').trim();

  if (!cleanedCategory) {
    return response.status(400).json({ message: 'Category is required.' });
  }

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

  const existingItems = await getMenuItems();
  const order = existingItems.length;
  if (useLocalStore) {
    const store = readStore();
    writeStore({ ...store, menu: [...store.menu, { ...item, order }] });
  } else {
    await MenuItem.create({ ...item, order });
  }
  await ensureCategory(cleanedCategory);
  return response.status(201).json({ item: toMenuItem(item), menu: (await getMenuItems()).map(toMenuItem), categories: await getCategoryNames(), message: 'Menu item added successfully.' });
});

app.put('/api/menu/:id', async (request, response) => {
  const itemId = request.params.id;
  const { name, amharicName, category, price, description } = request.body || {};

  const existingItem = useLocalStore
    ? (await getMenuItems()).find((item) => String(item.id) === String(itemId))
    : await MenuItem.findOne({ id: itemId }).lean();
  if (!existingItem) {
    return response.status(404).json({ message: 'Menu item not found.' });
  }

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
      menu: store.menu.map((item) => String(item.id) === String(itemId) ? { ...item, ...updatedItem } : item),
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
});

app.post('/api/menu/reorder', async (request, response) => {
  const order = Array.isArray(request.body?.order) ? request.body.order : [];

  if (!order.length) {
    return response.status(400).json({ message: 'Order list is required.' });
  }

  const items = await getMenuItems();
  const itemMap = new Map(items.map((item) => [String(item.id), item]));
  const nextMenu = order.map((id) => itemMap.get(String(id))).filter(Boolean);

  if (nextMenu.length !== items.length) {
    return response.status(400).json({ message: 'Menu order could not be restored.' });
  }

  if (useLocalStore) {
    const store = readStore();
    writeStore({ ...store, menu: nextMenu.map((item, orderIndex) => ({ ...item, order: orderIndex })) });
  } else {
    await MenuItem.bulkWrite(nextMenu.map((item, orderIndex) => ({
      updateOne: { filter: { id: item.id }, update: { $set: { order: orderIndex } } },
    })));
  }
  return response.json({ menu: nextMenu.map(toMenuItem), message: 'Menu order updated.' });
});

app.delete('/api/menu/:id', async (request, response) => {
  const itemId = request.params.id;
  if (useLocalStore) {
    const store = readStore();
    writeStore({ ...store, menu: store.menu.filter((item) => String(item.id) !== String(itemId)) });
  } else {
    await MenuItem.deleteOne({ id: itemId });
  }

  return response.json({ menu: (await getMenuItems()).map(toMenuItem), message: 'Menu item deleted.' });
});

app.get('/api/comments', (_request, response) => {
  const store = readStore();
  response.json({ comments: store.comments });
});

app.post('/api/comments', (request, response) => {
  const payload = request.body || {};
  const name = String(payload.name || '').trim();
  const text = String(payload.text || '').trim();
  const rating = Number(payload.rating || 0);

  if (!text || text.length < 3) {
    return response.status(400).json({ message: 'Comment text is required.' });
  }

  if (name && !isValidCustomerName(name)) {
    return response.status(400).json({ message: 'Name can only contain letters, spaces, apostrophes, and hyphens.' });
  }

  if (!Number.isFinite(rating) || rating < 0 || rating > 5) {
    return response.status(400).json({ message: 'Rating must be between 0 and 5.' });
  }

  const store = readStore();
  const comment = {
    id: `comment-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    name: name || 'Anonymous guest',
    text,
    rating: Number.isInteger(rating) ? rating : 0,
  };

  const nextStore = {
    ...store,
    comments: [comment, ...store.comments],
  };
  writeStore(nextStore);

  return response.status(201).json({
    comment,
    message: 'Sent successfully. Thank you dear customer.',
    comments: nextStore.comments,
  });
});

app.delete('/api/comments/:id', (request, response) => {
  const commentId = request.params.id;
  const store = readStore();
  const nextStore = {
    ...store,
    comments: store.comments.filter((comment) => String(comment.id) !== String(commentId)),
  };
  writeStore(nextStore);

  return response.json({ comments: nextStore.comments, message: 'Comment deleted.' });
});

app.post('/api/admin/login', (request, response) => {
  const email = String(request.body?.email || '').trim();
  const password = String(request.body?.password || '');
  const store = readStore();

  const match = store.adminCredentials.some((credential) => credential.email === email && credential.password === password);

  if (!match) {
    return response.status(401).json({ message: 'Incorrect email or password.' });
  }

  return response.json({ success: true, message: 'Admin login successful.' });
});

app.post('/api/admin/change-credentials', (request, response) => {
  const currentEmail = String(request.body?.currentEmail || '').trim();
  const currentPassword = String(request.body?.currentPassword || '');
  const newEmail = String(request.body?.newEmail || '').trim();
  const newPassword = String(request.body?.newPassword || '');
  const store = readStore();
  const credentialIndex = store.adminCredentials.findIndex((credential) => credential.email === currentEmail && credential.password === currentPassword);

  if (credentialIndex < 0) {
    return response.status(401).json({ message: 'Current email or password is incorrect.' });
  }

  if (!newEmail || !newPassword) {
    return response.status(400).json({ message: 'New email and password are required.' });
  }

  if (!/^\S+@\S+\.\S+$/.test(newEmail)) {
    return response.status(400).json({ message: 'Enter a valid email address.' });
  }

  if (newPassword.length < 4) {
    return response.status(400).json({ message: 'Password must be at least 4 characters.' });
  }

  const emailInUse = store.adminCredentials.some((credential, index) => index !== credentialIndex && credential.email === newEmail);
  if (emailInUse) {
    return response.status(409).json({ message: 'That email is already in use.' });
  }

  const adminCredentials = store.adminCredentials.map((credential, index) => (
    index === credentialIndex ? { email: newEmail, password: newPassword } : credential
  ));
  writeStore({ ...store, adminCredentials });

  return response.json({ success: true, message: 'Admin credentials updated successfully.' });
});

const startServer = async () => {
  try {
    await connectDatabase();
    await initializeCatalog();
  } catch (error) {
    useLocalStore = true;
    console.warn(`MongoDB unavailable; using ${path.relative(__dirname, dataFile)} for local data: ${error.message}`);
  }

  app.listen(PORT, () => {
    console.log(`Backend is running on port ${PORT} (http://localhost:${PORT}) using ${useLocalStore ? 'local JSON storage' : 'MongoDB'}.`);
  });
};

startServer().catch((error) => {
  console.error('Backend startup failed:', error.message);
  process.exit(1);
});