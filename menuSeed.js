// Shared helpers for loading the food list (menuData.json) and keeping
// category records clean. Used by both server.js and seed.js.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_CATEGORIES = [
  'ቁርስ / Breakfast',
  'የጾም ምግቦች / Fasting Foods',
  'የፍስክ ምግቦች / Non-Fasting Foods',
  'በርገር / Burger',
  'ኑድል / Noodles',
  'ፒዛ / Pizza',
  'ስናክ / Snack',
  'ዓሳ / Fish',
  'ጭማቂ / Juice',
  'ሰላጣ / Salad',
  'ሾርባ / Soup',
  'ለስላሳ መጠጦች / Soft Drinks',
  'ተጨማሪ / Extras',
  'ቀዝቃዛ መጠጦች / Cold Drinks',
  'ትኩስ መጠጦች / Hot Drinks',
  'ክሬም ኬክ / Cream Cake',
  'ካኑ ስፔሻል ኬክ / Canoe Special Cake',
  'ካኑ ስፔሻል ቶርታ ኬክ / Canoe Special Torta Cake',
  'ቶርታ ኬክ / Torta Cake',
  'ኩኪስ / Cookies',
];

const clean = (value) => String(value ?? '').trim().replace(/\s+/g, ' ');

// "ቁርስ / Breakfast" -> "Breakfast"
const canonicalCategoryName = (value) => {
  const normalized = clean(value);
  if (!normalized) return '';
  if (normalized.includes(' / ')) {
    const parts = normalized.split(' / ').map((part) => part.trim()).filter(Boolean);
    return parts.at(-1) || normalized;
  }
  return normalized;
};

// If a dish says just "Breakfast", map it to the full bilingual category name.
// "Fasting Food", "fasting foods" and "Fasting-Foods" all compare equal.
const looseKey = (value) => canonicalCategoryName(value).toLowerCase().replace(/[^a-z0-9]/g, '').replace(/s$/, '');

const resolveCategory = (value) => {
  const cleaned = clean(value);
  if (!cleaned) return '';
  const key = looseKey(cleaned);
  const match = key ? DEFAULT_CATEGORIES.find((name) => looseKey(name) === key) : null;
  return match || cleaned;
};

const BACKEND_ROOT = __dirname;
const DATA_DIR = path.join(BACKEND_ROOT, 'data');

// Looks for the food file in the usual places, and also tolerates a few
// common mistakes (different name, hidden ".txt" extension, wrong folder).
const findSeedFile = () => {
  const exact = [
    path.join(DATA_DIR, 'menuData.json'),
    path.join(DATA_DIR, 'menudata.json'),
    path.join(DATA_DIR, 'menu.json'),
    path.join(BACKEND_ROOT, 'menuData.json'),
    path.join(BACKEND_ROOT, 'menu.json'),
    path.join(BACKEND_ROOT, '..', 'menuData.json'),
    path.join(BACKEND_ROOT, '..', 'data', 'menuData.json'),
  ];
  for (const candidate of exact) {
    if (fs.existsSync(candidate)) return candidate;
  }

  const folders = [DATA_DIR, BACKEND_ROOT, path.join(BACKEND_ROOT, '..')];
  for (const folder of folders) {
    if (!fs.existsSync(folder)) continue;
    const match = fs.readdirSync(folder).find((file) => (
      /\.json(\.txt)?$/i.test(file)
      && /menu|food|dish/i.test(file)
      && !/^(store|package|package-lock|tsconfig)/i.test(file)
    ));
    if (match) return path.join(folder, match);
  }
  return null;
};

// Finds every top-level [...] block, ignoring brackets inside strings.
const extractTopLevelArrays = (text) => {
  const chunks = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === '[') {
      if (depth === 0) start = index;
      depth += 1;
    } else if (char === ']') {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        chunks.push(text.slice(start, index + 1));
        start = -1;
      }
      if (depth < 0) depth = 0;
    }
  }
  return chunks;
};

// Strict JSON first. If that fails (e.g. several arrays pasted one after
// another, stray commas), fall back to merging every top-level array.
const parseMenuText = (rawText) => {
  const text = rawText.replace(/^\uFEFF/, ''); // strip Windows BOM
  try {
    return { data: JSON.parse(text), arrayCount: 1 };
  } catch (firstError) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (const char of text) {
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === '[') depth += 1;
      else if (char === ']') depth -= 1;
      if (depth < 0) break;
    }
    if (depth > 0) {
      try {
        return { data: JSON.parse(`${text}${']'.repeat(depth)}`), arrayCount: 1, repaired: true };
      } catch {
        // Continue with the existing recovery for multiple top-level arrays.
      }
    }

    const chunks = extractTopLevelArrays(text);
    if (!chunks.length) throw firstError;

    const merged = [];
    chunks.forEach((chunk) => {
      let parsedChunk;
      try {
        parsedChunk = JSON.parse(chunk);
      } catch {
        parsedChunk = JSON.parse(chunk.replace(/,(\s*[\]}])/g, '$1')); // trailing commas
      }
      merged.push(...parsedChunk);
    });
    return { data: merged, arrayCount: chunks.length, repaired: true };
  }
};

const hashId = (contentKey) => `seed-${crypto.createHash('md5').update(contentKey).digest('hex').slice(0, 12)}`;

// Returns { file, items, skipped, notes, error }
const loadSeedMenu = () => {
  const file = findSeedFile();
  if (!file) {
    return {
      file: null,
      items: [],
      skipped: [],
      notes: [],
      error: `No food file found. Put it at ${path.join(DATA_DIR, 'menuData.json')}`,
    };
  }

  let parsed;
  let arrayCount = 1;
  try {
    ({ data: parsed, arrayCount } = parseMenuText(fs.readFileSync(file, 'utf8')));
  } catch (error) {
    return { file, items: [], skipped: [], notes: [], error: `Invalid JSON in ${file}: ${error.message}` };
  }

  const sourceList = Array.isArray(parsed)
    ? parsed
    : (Array.isArray(parsed?.menu) ? parsed.menu : (Array.isArray(parsed?.items) ? parsed.items : []));
  const list = sourceList.flat(Infinity);

  const seenIds = new Set();
  const seenContent = new Set();
  const items = [];
  const skipped = [];
  const notes = [];
  let duplicateCount = 0;
  let renamedIds = 0;

  if (arrayCount > 1) {
    notes.push(`The file contained ${arrayCount} separate JSON arrays; they were merged. Run "node fixMenuFile.js" to rewrite it as one clean array.`);
  }

  list.forEach((raw, index) => {
    if (!raw || typeof raw !== 'object') {
      skipped.push(`#${index + 1}: not an object`);
      return;
    }

    let name = clean(raw.name);
    let amharicName = clean(raw.amharicName);

    // Allow "Amharic / English" written in a single "name" field.
    if (!amharicName && name.includes(' / ')) {
      const [first, ...rest] = name.split(' / ');
      amharicName = first.trim();
      name = rest.join(' / ').trim();
    }
    if (!name && amharicName) {
      name = amharicName;
      amharicName = '';
    }

    const category = resolveCategory(raw.category);
    const price = clean(raw.price);

    if (!name || !category || !price) {
      skipped.push(`#${index + 1} "${name || amharicName || '?'}": needs a name, category and price`);
      return;
    }

    // The same dish (same category + names) listed twice is a true duplicate.
    const contentKey = `${category}|${name}|${amharicName}`.toLowerCase();
    if (seenContent.has(contentKey)) {
      duplicateCount += 1;
      return;
    }
    seenContent.add(contentKey);

    // Keep the file's id when it is unique, otherwise generate a stable one
    // (different dishes often reuse "item-1", "item-2", ...).
    let id = clean(raw.id);
    if (!id || seenIds.has(id)) {
      if (id) renamedIds += 1;
      id = hashId(contentKey);
    }
    seenIds.add(id);

    items.push({ id, name, amharicName, category, price, description: clean(raw.description) });
  });

  if (duplicateCount) notes.push(`${duplicateCount} exact duplicate dishes were ignored.`);
  if (renamedIds) notes.push(`${renamedIds} dishes reused an id that another dish already had, so they got new unique ids.`);

  return { file, items, skipped, notes, error: null };
};

// Older seeds stored category keys as dashes. This makes every category key
// equal to its English name and removes duplicates.
const repairCategoryKeys = async (Category) => {
  const docs = await Category.find().sort({ order: 1, createdAt: 1 });
  const seen = new Set();
  const toUpdate = [];

  for (const doc of docs) {
    const key = canonicalCategoryName(doc.name);
    if (!key || seen.has(key)) {
      await Category.deleteOne({ _id: doc._id });
      continue;
    }
    seen.add(key);
    if (doc.key !== key) toUpdate.push({ doc, key });
  }

  for (const { doc, key } of toUpdate) {
    await Category.updateOne({ _id: doc._id }, { $set: { key } });
  }
};

module.exports = {
  DEFAULT_CATEGORIES,
  DATA_DIR,
  canonicalCategoryName,
  resolveCategory,
  findSeedFile,
  loadSeedMenu,
  hashId,
  repairCategoryKeys,
};