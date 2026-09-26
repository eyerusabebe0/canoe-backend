const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = Number(process.env.PORT || 4000);

const ADMIN_CREDENTIALS = [
  { email: 'admin@canoe.com', password: '1111' },
  { email: 'a@gmail.com', password: '1111' },
];

const dataDir = path.join(__dirname, 'data');
const dataFile = path.join(dataDir, 'store.json');

const makeDefaultStore = () => ({
  categories: [],
  menu: [],
  comments: [],
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

const normalizeCategory = (value) => {
  const next = String(value || '').trim();
  if (!next) {
    return '';
  }

  const normalized = next.replace(/\s+/g, ' ');

  if (normalized.includes(' / ')) {
    const parts = normalized.split(' / ').map((part) => part.trim()).filter(Boolean);
    const englishCandidate = [...parts].reverse().find((part) => /[A-Za-z]/.test(part));
    return (englishCandidate || parts[parts.length - 1] || normalized).replace(/\s+/g, ' ');
  }

  const words = normalized.split(/\s+/).filter(Boolean);
  const englishWords = words.filter((part) => /[A-Za-z]/.test(part));

  if (englishWords.length) {
    return englishWords.join(' ');
  }

  return normalized;
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
  const categories = [...new Set(rawCategories
    .map((category) => normalizeCategory(category))
    .filter((category) => category && category !== 'All dishes'))];

  return {
    categories,
    menu: (Array.isArray(parsed.menu) ? parsed.menu : []).map((item) => normalizeMenuItem({ ...item, category: normalizeCategory(item?.category) })),
    comments: Array.isArray(parsed.comments) ? parsed.comments : [],
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

app.get('/api/categories', (_request, response) => {
  const store = readStore();
  response.json({ categories: store.categories });
});

app.post('/api/categories', (request, response) => {
  const name = normalizeCategory(request.body?.name);

  if (!name) {
    return response.status(400).json({ message: 'Category name is required.' });
  }

  const store = readStore();
  if (store.categories.includes(name)) {
    return response.json({ categories: store.categories, message: 'Category already exists.' });
  }

  const nextStore = {
    ...store,
    categories: [...store.categories, name],
  };
  writeStore(nextStore);

  return response.status(201).json({ categories: nextStore.categories, message: 'Category added successfully.' });
});

app.post('/api/categories/reorder', (request, response) => {
  const order = Array.isArray(request.body?.order) ? request.body.order : [];
  const normalizedOrder = order.map((item) => normalizeCategory(item)).filter(Boolean);

  if (!normalizedOrder.length) {
    return response.status(400).json({ message: 'Category order is required.' });
  }

  const store = readStore();
  const nextCategories = [...new Set([...normalizedOrder, ...store.categories.filter((category) => !normalizedOrder.includes(category))])];

  const nextStore = { ...store, categories: nextCategories };
  writeStore(nextStore);

  return response.json({ categories: nextStore.categories, message: 'Category order updated.' });
});

app.delete('/api/categories/:name', (request, response) => {
  const categoryName = decodeURIComponent(request.params.name);
  const store = readStore();
  const normalizedCategory = normalizeCategory(categoryName);

  if (!normalizedCategory) {
    return response.status(400).json({ message: 'Category name is required.' });
  }

  const remainingItems = store.menu.filter((item) => item.category !== normalizedCategory);
  const nextStore = {
    ...store,
    categories: store.categories.filter((category) => category !== normalizedCategory),
    menu: remainingItems,
  };
  writeStore(nextStore);

  return response.json({ categories: nextStore.categories, menu: nextStore.menu, message: 'Category deleted successfully.' });
});

app.get('/api/menu', (_request, response) => {
  const store = readStore();
  response.json({ menu: store.menu.map(normalizeMenuItem), categories: store.categories });
});

app.post('/api/menu', (request, response) => {
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

  const store = readStore();
  const item = normalizeMenuItem({
    id: `item-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    name: cleanedName,
    amharicName: cleanedAmharicName,
    category: cleanedCategory,
    price: cleanedPrice,
    description: cleanedDescription,
  });

  const nextCategories = [...new Set([...store.categories, cleanedCategory])];
  const nextStore = {
    ...store,
    categories: nextCategories,
    menu: [...store.menu, item],
  };

  writeStore(nextStore);
  return response.status(201).json({ item, menu: nextStore.menu, categories: nextStore.categories, message: 'Menu item added successfully.' });
});

app.put('/api/menu/:id', (request, response) => {
  const itemId = request.params.id;
  const { name, amharicName, category, price, description } = request.body || {};

  const store = readStore();
  const itemIndex = store.menu.findIndex((item) => String(item.id) === String(itemId));

  if (itemIndex === -1) {
    return response.status(404).json({ message: 'Menu item not found.' });
  }

  const updatedItem = normalizeMenuItem({
    ...store.menu[itemIndex],
    name: String(name ?? store.menu[itemIndex].name ?? '').trim(),
    amharicName: String(amharicName ?? store.menu[itemIndex].amharicName ?? '').trim(),
    category: normalizeCategory(category || store.menu[itemIndex].category),
    price: String(price ?? store.menu[itemIndex].price).trim(),
    description: String(description ?? store.menu[itemIndex].description ?? '').trim(),
  });

  if ((!updatedItem.name && !updatedItem.amharicName) || !updatedItem.price) {
    return response.status(400).json({ message: 'At least one name (English or Amharic) and price are required.' });
  }

  const nextMenu = [...store.menu];
  nextMenu[itemIndex] = updatedItem;

  const nextCategories = [...new Set([...store.categories, updatedItem.category])];
  const nextStore = { ...store, menu: nextMenu, categories: nextCategories };
  writeStore(nextStore);

  return response.json({ item: updatedItem, menu: nextStore.menu, categories: nextStore.categories, message: 'Menu item updated.' });
});

app.post('/api/menu/reorder', (request, response) => {
  const order = Array.isArray(request.body?.order) ? request.body.order : [];

  if (!order.length) {
    return response.status(400).json({ message: 'Order list is required.' });
  }

  const store = readStore();
  const itemMap = new Map(store.menu.map((item) => [String(item.id), item]));
  const nextMenu = order
    .map((id) => itemMap.get(String(id)))
    .filter(Boolean);

  if (nextMenu.length !== store.menu.length) {
    return response.status(400).json({ message: 'Menu order could not be restored.' });
  }

  const nextStore = { ...store, menu: nextMenu };
  writeStore(nextStore);
  return response.json({ menu: nextMenu, message: 'Menu order updated.' });
});

app.delete('/api/menu/:id', (request, response) => {
  const itemId = request.params.id;
  const store = readStore();
  const nextMenu = store.menu.filter((item) => String(item.id) !== String(itemId));
  const nextStore = { ...store, menu: nextMenu };
  writeStore(nextStore);

  return response.json({ menu: nextStore.menu, message: 'Menu item deleted.' });
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

  const match = ADMIN_CREDENTIALS.some((credential) => credential.email === email && credential.password === password);

  if (!match) {
    return response.status(401).json({ message: 'Incorrect email or password.' });
  }

  return response.json({ success: true, message: 'Admin login successful.' });
});

app.listen(PORT, () => {
  console.log(`Canoe backend running at http://localhost:${PORT}`);
});