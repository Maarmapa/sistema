// bsale.js — Bsale API client + sales velocity classifier
// Reads sales last 30 days + current stock, classifies catalog products by status.

import fetch from 'node-fetch';
import fs from 'fs';

const BSALE_BASE = 'https://api.bsale.io/v1';
const BSALE_TOKEN = process.env.BSALE_TOKEN;
const POSTS_HISTORY_FILE = './posts-history.json';

async function bsale(path, opts = {}) {
  if (!BSALE_TOKEN) throw new Error('BSALE_TOKEN env var missing');
  const r = await fetch(BSALE_BASE + path, {
    ...opts,
    headers: { 'access_token': BSALE_TOKEN, 'Content-Type': 'application/json', ...(opts.headers || {}) },
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error(`Bsale ${r.status} on ${path.split('?')[0]}`);
  return r.json();
}

// Fetch sales documents (facturas + boletas) from last N days, paginated.
// Returns Map<variantId, unitsSold>.
export async function getSalesByVariant(days = 30) {
  const endDate = Math.floor(Date.now() / 1000);
  const startDate = endDate - days * 86400;
  const salesMap = new Map();
  let offset = 0;
  const limit = 50;
  const maxDocs = 500; // safety cap

  // Document types 1 = factura, 22 = boleta electrónica (most common sales doc IDs in Bsale CL)
  const docTypes = [1, 22];

  for (const docTypeId of docTypes) {
    let fetched = 0;
    while (fetched < maxDocs) {
      const url = `/documents.json?documenttypeid=${docTypeId}&startdate=${startDate}&enddate=${endDate}&limit=${limit}&offset=${offset}&expand=details`;
      let page;
      try {
        page = await bsale(url);
      } catch (err) {
        console.error('[bsale] sales fetch err:', err.message);
        break;
      }
      const items = page?.items || [];
      if (!items.length) break;
      for (const doc of items) {
        const details = doc.details?.items || doc.details || [];
        for (const line of details) {
          const vid = line.variant?.id || line.variantId;
          const qty = Number(line.quantity || 0);
          if (vid && qty > 0) {
            salesMap.set(vid, (salesMap.get(vid) || 0) + qty);
          }
        }
      }
      fetched += items.length;
      if (items.length < limit) break;
      offset += limit;
      await new Promise(r => setTimeout(r, 200)); // gentle rate limiting
    }
    offset = 0;
  }
  return salesMap;
}

// Load catalog.json (already has product_id, variants[], stock per variant).
export function loadCatalog() {
  try {
    return JSON.parse(fs.readFileSync('./catalog.json', 'utf8'));
  } catch (err) {
    console.error('[bsale] catalog load err:', err.message);
    return [];
  }
}

// Detect brand from product name. Boykot's main brands.
const BRAND_PATTERNS = [
  { re: /\bcopic\b/i, brand: 'Copic' },
  { re: /\bangelus\b/i, brand: 'Angelus' },
  { re: /\bholbein\b/i, brand: 'Holbein' },
  { re: /\bmolotow\b/i, brand: 'Molotow' },
  { re: /\bspeedball\b/i, brand: 'Speedball' },
  { re: /\bwinsor\b/i, brand: 'Winsor & Newton' },
  { re: /\bfabriano\b/i, brand: 'Fabriano' },
  { re: /\bmoleskine\b/i, brand: 'Moleskine' },
  { re: /\bsakura\b/i, brand: 'Sakura' },
  { re: /\bderwent\b/i, brand: 'Derwent' },
  { re: /\bposca\b/i, brand: 'Posca' },
];

function detectBrand(product) {
  const haystack = [
    product.name || '',
    product.description || '',
    ...(product.variants || []).map(v => v.description || ''),
  ].join(' ');
  for (const { re, brand } of BRAND_PATTERNS) {
    if (re.test(haystack)) return brand;
  }
  return product.variants?.[0]?.description?.split(' ')[0] || 'Boykot';
}

// Classify catalog products into HOT/COLD/STAR using sales velocity + stock.
// HOT: above-avg sales velocity AND stock available
// COLD: zero or near-zero sales in 30d AND stock > 5 (sitting inventory)
// STAR: top 5 by total units sold in 30d
export function classifyProducts(catalog, salesMap) {
  // Aggregate sales per product (sum across variants).
  const productSales = catalog.map(p => {
    const totalSold = (p.variants || []).reduce((acc, v) => acc + (salesMap.get(v.variant_id) || 0), 0);
    const totalStock = (p.variants || []).reduce((acc, v) => acc + Number(v.stock || 0), 0);
    const hasStock = totalStock > 0;
    return {
      ...p,
      brand: detectBrand(p),
      totalSold,
      totalStock,
      hasStock,
      velocity: totalSold / 30, // units/day
    };
  }).filter(p => p.name && p.name.trim() && p.hasStock);

  if (!productSales.length) return { hot: [], cold: [], star: [] };

  // Compute median velocity for hot threshold (median of products that have ANY sales).
  const withSales = productSales.filter(p => p.totalSold > 0);
  const velocities = withSales.map(p => p.velocity).sort((a, b) => a - b);
  const median = velocities[Math.floor(velocities.length / 2)] || 0;

  const hot = withSales
    .filter(p => p.velocity > median * 1.5)
    .sort((a, b) => b.velocity - a.velocity)
    .slice(0, 20);

  const cold = productSales
    .filter(p => p.totalSold === 0 && p.totalStock >= 5)
    .sort((a, b) => b.totalStock - a.totalStock)
    .slice(0, 30);

  const star = withSales
    .sort((a, b) => b.totalSold - a.totalSold)
    .slice(0, 10);

  return { hot, cold, star };
}

// Pick one product per status, avoiding brand collision + recent post history.
export function selectDailyPicks(classified, history) {
  const recentIds = new Set(history.slice(-42).map(h => h.product_id));
  const usedBrands = new Set();

  function pickAvoidingDupes(pool) {
    for (const p of pool) {
      if (recentIds.has(p.product_id)) continue;
      if (usedBrands.has(p.brand)) continue;
      usedBrands.add(p.brand);
      return p;
    }
    // Fallback: ignore brand collision if no candidates left
    for (const p of pool) {
      if (!recentIds.has(p.product_id)) return p;
    }
    return pool[0] || null;
  }

  return {
    hot: pickAvoidingDupes(classified.hot),
    cold: pickAvoidingDupes(classified.cold),
    star: pickAvoidingDupes(classified.star),
  };
}

// Load and save post history (last 50 entries).
export function loadHistory() {
  try {
    return JSON.parse(fs.readFileSync(POSTS_HISTORY_FILE, 'utf8'));
  } catch {
    return [];
  }
}

export function saveHistory(entries) {
  try {
    const trimmed = entries.slice(-100);
    fs.writeFileSync(POSTS_HISTORY_FILE, JSON.stringify(trimmed, null, 2));
  } catch (err) {
    console.error('[bsale] history save err:', err.message);
  }
}

export function recordPost(history, product, status) {
  history.push({
    ts: new Date().toISOString(),
    product_id: product.product_id,
    name: product.name?.trim(),
    brand: product.brand,
    status,
    units_sold_30d: product.totalSold,
    stock: product.totalStock,
  });
  saveHistory(history);
  return history;
}

// Stock-based fallback classifier when Bsale sales API fails.
// Uses catalog.json stock distribution as a proxy:
// - HOT: stock 1-3 (selling fast, running low)
// - COLD: stock > 10 (heavy inventory, slow movement)
// - STAR: stock 4-8 (steady mid-range)
export function classifyByStockHeuristic(catalog) {
  const products = catalog
    .filter(p => p.name && p.name.trim())
    .map(p => ({
      ...p,
      brand: detectBrand(p),
      totalStock: (p.variants || []).reduce((acc, v) => acc + Number(v.stock || 0), 0),
      totalSold: 0,
      velocity: 0,
    }))
    .filter(p => p.totalStock > 0);

  const hot = products.filter(p => p.totalStock >= 1 && p.totalStock <= 3).sort(() => Math.random() - 0.5).slice(0, 20);
  const cold = products.filter(p => p.totalStock > 10).sort((a, b) => b.totalStock - a.totalStock).slice(0, 30);
  const star = products.filter(p => p.totalStock >= 4 && p.totalStock <= 8).sort(() => Math.random() - 0.5).slice(0, 10);

  return { hot, cold, star };
}
