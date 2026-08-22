export function normalizeCatalogTerm(value = '') {
  return String(value)
    .normalize('NFKD')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function catalogImageExtension(mimeType, bytes = new Uint8Array()) {
  const hex = [...bytes.slice(0, 12)].map(value => value.toString(16).padStart(2, '0')).join('');
  const ascii = String.fromCharCode(...bytes.slice(0, 12));
  if (mimeType === 'image/jpeg' && hex.startsWith('ffd8ff')) return 'jpg';
  if (mimeType === 'image/png' && hex.startsWith('89504e470d0a1a0a')) return 'png';
  if (mimeType === 'image/webp' && ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP') return 'webp';
  if (mimeType === 'image/gif' && (ascii.startsWith('GIF87a') || ascii.startsWith('GIF89a'))) return 'gif';
  throw new Error('Choose a valid JPG, PNG, WebP, or GIF product image.');
}

export function normalizeProductImageRegion(input) {
  if (!input || typeof input !== 'object') return null;
  let x = Number(input.x ?? input.left), y = Number(input.y ?? input.top);
  let width = Number(input.width ?? (Number(input.right) - x)), height = Number(input.height ?? (Number(input.bottom) - y));
  if (![x, y, width, height].every(Number.isFinite)) return null;
  if ([x, y, width, height].some(value => value > 1) && [x, y, width, height].every(value => value >= 0 && value <= 100)) {
    x /= 100; y /= 100; width /= 100; height /= 100;
  }
  if (x < 0 || y < 0 || width <= 0 || height <= 0 || x >= 1 || y >= 1) return null;
  width = Math.min(width, 1 - x); height = Math.min(height, 1 - y);
  if (width < 0.01 || height < 0.01 || width * height > 0.4) return null;
  const confidence = Number(input.confidence);
  return {
    x: Math.round(x * 10000) / 10000,
    y: Math.round(y * 10000) / 10000,
    width: Math.round(width * 10000) / 10000,
    height: Math.round(height * 10000) / 10000,
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : null
  };
}

export function catalogSearchTerms(item = {}) {
  const values = [item.nickname, item.name, item.sku, item.sourceDescription, ...(item.aliases || [])];
  return [...new Set(values.map(normalizeCatalogTerm).filter(Boolean))];
}

export function findCatalogItem(items = [], query = '', { type } = {}) {
  const wanted = normalizeCatalogTerm(query);
  if (!wanted) return null;
  return items.find(item => (!type || item.type === type) && catalogSearchTerms(item).includes(wanted)) || null;
}

export function searchCatalog(items = [], query = '', { type, limit = 500 } = {}) {
  const wanted = normalizeCatalogTerm(query);
  const candidates = items.filter(item => !type || item.type === type);
  if (!wanted) return candidates.slice(0, limit);
  return candidates
    .map(item => {
      const terms = catalogSearchTerms(item);
      const score = terms.includes(wanted) ? 0 : terms.some(term => term.startsWith(wanted)) ? 1 : terms.some(term => term.includes(wanted)) ? 2 : 99;
      return { item, score };
    })
    .filter(result => result.score < 99)
    .sort((a, b) => a.score - b.score || String(a.item.nickname || a.item.name).localeCompare(String(b.item.nickname || b.item.name)))
    .slice(0, limit)
    .map(result => result.item);
}

export function upsertCatalogItem(items = [], input = {}, { id, now = new Date().toISOString() } = {}) {
  const type = String(input.type || '').trim();
  const name = String(input.name || '').trim();
  const nickname = String(input.nickname || '').trim();
  const sku = String(input.sku || '').trim();
  if (!name || !['material', 'expense'].includes(type)) throw new Error('A product name and catalog type are required.');

  const existing = input.id
    ? items.find(item => item.id === input.id)
    : items.find(item => item.type === type && normalizeCatalogTerm(item.name) === normalizeCatalogTerm(name));
  if (input.id && !existing) throw new Error('That catalog item no longer exists. Refresh and try again.');

  if (nickname) {
    const normalizedNickname = normalizeCatalogTerm(nickname);
    const conflict = items.find(item => item.id !== existing?.id && item.type === type && catalogSearchTerms(item).includes(normalizedNickname));
    if (conflict) {
      const error = new Error(`The nickname “${nickname}” is already used by ${conflict.nickname || conflict.name}.`);
      error.code = 'CATALOG_NICKNAME_CONFLICT';
      throw error;
    }
  }

  const aliases = [...new Set([...(existing?.aliases || []), ...(input.aliases || []), nickname]
    .map(value => String(value || '').trim())
    .filter(value => value && normalizeCatalogTerm(value) !== normalizeCatalogTerm(name)))];
  const item = {
    ...existing,
    ...input,
    id: existing?.id || id,
    type,
    name,
    nickname,
    sku,
    aliases,
    createdAt: existing?.createdAt || now,
    updatedAt: now
  };
  const nextItems = existing ? items.map(entry => entry.id === existing.id ? item : entry) : [item, ...items];
  return { items: nextItems, item, created: !existing };
}
