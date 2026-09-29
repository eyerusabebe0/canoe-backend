const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const connectDatabase = require('./config/database');
const Category = require('./models/Category');
const MenuItem = require('./models/MenuItem');
const Comment = require('./models/Comment');
const AdminCredential = require('./models/AdminCredential');

const app = express();
const PORT = Number(process.env.PORT || 4000);

const DEFAULT_ADMIN_CREDENTIALS = [
  { email: 'admin@canoe.com', password: '1111' },
  { email: 'a@gmail.com', password: '1111' },
];

const dataDir = path.join(__dirname, 'data');
const dataFile = path.join(dataDir, 'store.json');

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

const migrateLegacyStore = async () => {
  const migrationState = mongoose.connection.collection('migration_state');
  const migrationId = 'legacy-json-store-import-v1';
  if (await migrationState.findOne({ _id: migrationId })) return;

  const [categoryCount, menuCount, commentCount, credentialCount] = await Promise.all([
    Category.countDocuments(),
    MenuItem.countDocuments(),
    Comment.countDocuments(),
    AdminCredential.countDocuments(),
  ]);

  if (!categoryCount && !menuCount && !commentCount && !credentialCount) {
    const store = readStore();
    const categoryNames = [...new Map([
      ...store.categories,
      ...store.menu.map((item) => item.category),
    ].filter(Boolean).map((name) => [canonicalCategoryName(name), name])).values()];

    if (categoryNames.length) {
      await Category.insertMany(categoryNames.map((name, order) => ({
        name,
        key: canonicalCategoryName(name),
        order,
      })), { ordered: false });
    }
    if (store.menu.length) {
      await MenuItem.insertMany(store.menu.map((item, order) => ({ ...item, order: item.order ?? order })), { ordered: false });
    }
    if (store.comments.length) await Comment.insertMany(store.comments, { ordered: false });
    const credentials = store.adminCredentials.length ? store.adminCredentials : DEFAULT_ADMIN_CREDENTIALS;
    if (credentials.length) await AdminCredential.insertMany(credentials, { ordered: false });
    console.log(`Imported legacy JSON store: ${store.menu.length} menu items, ${categoryNames.length} categories.`);
  }

  await migrationState.updateOne(
    { _id: migrationId },
    { $setOnInsert: { completedAt: new Date() } },
    { upsert: true },
  );
};

const getCategories = async () => (await Category.find().sort({ order: 1, createdAt: 1 }).lean()).map((category) => category.name);
const getMenu = async () => (await MenuItem.find().sort({ order: 1, createdAt: 1 }).lean()).map(normalizeMenuItem);
const ensureCategory = async (name) => {
  const normalized = normalizeCategory(name);
  if (!normalized) return null;
  const key = canonicalCategoryName(normalized);
  const existing = await Category.findOne({ key });
  if (existing) return existing;
  const lastCategory = await Category.findOne().sort({ order: -1 }).lean();
  return Category.findOneAndUpdate(
    { key },
    { $setOnInsert: { name: normalized, key, order: (lastCategory?.order ?? -1) + 1 } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
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

app.get('/api/health', (_request, response) => {
  response.json({ status: 'ok', message: 'Canoe backend is running.' });
});

app.get('/api/categories', async (_request, response) => {
  response.json({ categories: await getCategories() });
});

app.post('/api/categories', async (request, response) => {
  const name = normalizeCategory(request.body?.name);

  if (!name) {
    return response.status(400).json({ message: 'Category name is required.' });
  }

  const key = canonicalCategoryName(name);
  const existing = await Category.findOne({ key });
  if (existing) {
    return response.json({ categories: await getCategories(), message: 'Category already exists.' });
  }

  await ensureCategory(name);

  return response.status(201).json({ categories: await getCategories(), message: 'Category added successfully.' });
});

app.post('/api/categories/reorder', async (request, response) => {
  const order = Array.isArray(request.body?.order) ? request.body.order : [];
  const normalizedOrder = order.map((item) => normalizeCategory(item)).filter(Boolean);

  if (!normalizedOrder.length) {
    return response.status(400).json({ message: 'Category order is required.' });
  }

  const store = await Category.find().sort({ order: 1, createdAt: 1 }).lean();
  const seen = new Set();
  const ordered = [...normalizedOrder, ...store.map((category) => category.name)]
    .map((name) => store.find((category) => canonicalCategoryName(category.name) === canonicalCategoryName(name)))
    .filter((category) => {
      if (!category || seen.has(category.key)) return false;
      seen.add(category.key);
      return true;
    });
  if (ordered.length) {
    await Category.bulkWrite(ordered.map((category, order) => ({
      updateOne: { filter: { _id: category._id }, update: { $set: { order } } },
    })));
  }

  return response.json({ categories: await getCategories(), message: 'Category order updated.' });
});

app.delete('/api/categories/:name', async (request, response) => {
  const categoryName = request.params.name;
  const normalizedCategory = canonicalCategoryName(categoryName);

  if (!normalizedCategory) {
    return response.status(400).json({ message: 'Category name is required.' });
  }

  const itemIds = (await MenuItem.find().select('id category').lean())
    .filter((item) => canonicalCategoryName(item.category) === normalizedCategory)
    .map((item) => item.id);
  await Promise.all([
    Category.deleteOne({ key: normalizedCategory }),
    MenuItem.deleteMany({ id: { $in: itemIds } }),
  ]);

  return response.json({ categories: await getCategories(), menu: await getMenu(), message: 'Category deleted successfully.' });
});

app.get('/api/menu', async (_request, response) => {
  response.json({ menu: await getMenu(), categories: await getCategories() });
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

  await ensureCategory(cleanedCategory);
  const lastItem = await MenuItem.findOne().sort({ order: -1 }).lean();
  const item = normalizeMenuItem({
    id: `item-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    name: cleanedName,
    amharicName: cleanedAmharicName,
    category: cleanedCategory,
    price: cleanedPrice,
    description: cleanedDescription,
    order: (lastItem?.order ?? -1) + 1,
  });
  await MenuItem.create(item);
  return response.status(201).json({ item, menu: await getMenu(), categories: await getCategories(), message: 'Menu item added successfully.' });
});

app.put('/api/menu/:id', async (request, response) => {
  const itemId = request.params.id;
  const { name, amharicName, category, price, description } = request.body || {};

  const currentItem = await MenuItem.findOne({ id: itemId }).lean();
  if (!currentItem) return response.status(404).json({ message: 'Menu item not found.' });

  const updatedItem = normalizeMenuItem({
    ...currentItem,
    name: String(name ?? currentItem.name ?? '').trim(),
    amharicName: String(amharicName ?? currentItem.amharicName ?? '').trim(),
    category: normalizeCategory(category || currentItem.category),
    price: String(price ?? currentItem.price).trim(),
    description: String(description ?? currentItem.description ?? '').trim(),
  });

  if ((!updatedItem.name && !updatedItem.amharicName) || !updatedItem.price) {
    return response.status(400).json({ message: 'At least one name (English or Amharic) and price are required.' });
  }

  await ensureCategory(updatedItem.category);
  await MenuItem.updateOne({ id: itemId }, {
    $set: {
      name: updatedItem.name,
      amharicName: updatedItem.amharicName,
      category: updatedItem.category,
      price: updatedItem.price,
      description: updatedItem.description,
      order: updatedItem.order,
    },
  });
  return response.json({ item: updatedItem, menu: await getMenu(), categories: await getCategories(), message: 'Menu item updated.' });
});

app.post('/api/menu/reorder', async (request, response) => {
  const order = Array.isArray(request.body?.order) ? request.body.order : [];

  if (!order.length) {
    return response.status(400).json({ message: 'Order list is required.' });
  }

  const menuCount = await MenuItem.countDocuments();
  const uniqueOrder = [...new Set(order.map(String))];
  const matchedCount = await MenuItem.countDocuments({ id: { $in: uniqueOrder } });
  if (uniqueOrder.length !== menuCount || matchedCount !== menuCount) {
    return response.status(400).json({ message: 'Menu order could not be restored.' });
  }

  await MenuItem.bulkWrite(uniqueOrder.map((id, orderIndex) => ({
    updateOne: { filter: { id }, update: { $set: { order: orderIndex } } },
  })));
  return response.json({ menu: await getMenu(), message: 'Menu order updated.' });
});

app.delete('/api/menu/:id', async (request, response) => {
  const itemId = request.params.id;
  await MenuItem.deleteOne({ id: itemId });
  return response.json({ menu: await getMenu(), message: 'Menu item deleted.' });
});

app.get('/api/comments', async (_request, response) => {
  const comments = await Comment.find().sort({ createdAt: -1 }).lean();
  response.json({ comments });
});

app.post('/api/comments', async (request, response) => {
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

  const comment = {
    id: `comment-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    name: name || 'Anonymous guest',
    text,
    rating: Number.isInteger(rating) ? rating : 0,
  };

  await Comment.create(comment);
  const comments = await Comment.find().sort({ createdAt: -1 }).lean();

  return response.status(201).json({
    comment,
    message: 'Sent successfully. Thank you dear customer.',
    comments,
  });
});

app.delete('/api/comments/:id', async (request, response) => {
  const commentId = request.params.id;
  await Comment.deleteOne({ id: commentId });
  return response.json({ comments: await Comment.find().sort({ createdAt: -1 }).lean(), message: 'Comment deleted.' });
});

app.post('/api/admin/login', async (request, response) => {
  const email = String(request.body?.email || '').trim();
  const password = String(request.body?.password || '');
  const match = await AdminCredential.exists({ email, password });

  if (!match) {
    return response.status(401).json({ message: 'Incorrect email or password.' });
  }

  return response.json({ success: true, message: 'Admin login successful.' });
});

app.post('/api/admin/change-credentials', async (request, response) => {
  const currentEmail = String(request.body?.currentEmail || '').trim();
  const currentPassword = String(request.body?.currentPassword || '');
  const newEmail = String(request.body?.newEmail || '').trim();
  const newPassword = String(request.body?.newPassword || '');
  const currentCredential = await AdminCredential.findOne({ email: currentEmail, password: currentPassword });
  if (!currentCredential) {
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

  const emailInUse = await AdminCredential.exists({ email: newEmail, _id: { $ne: currentCredential._id } });
  if (emailInUse) {
    return response.status(409).json({ message: 'That email is already in use.' });
  }

  currentCredential.email = newEmail;
  currentCredential.password = newPassword;
  await currentCredential.save();

  return response.json({ success: true, message: 'Admin credentials updated successfully.' });
});

const startServer = async () => {
  await connectDatabase();
  await migrateLegacyStore();
  if (!(await AdminCredential.countDocuments())) {
    await AdminCredential.insertMany(DEFAULT_ADMIN_CREDENTIALS, { ordered: false });
  }
  app.listen(PORT, () => {
    console.log(`Canoe backend running at http://localhost:${PORT}`);
  });
};

startServer().catch((error) => {
  console.error('Canoe backend failed to start:', error.message);
  process.exit(1);
});