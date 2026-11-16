const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const CACHE_DIR = path.join(DATA_DIR, 'cache');
const IMG_CACHE_DIR = path.join(CACHE_DIR, 'images');
const PUBLIC_DIR = path.join(__dirname, 'public');
const PUBLIC_DATA_DIR = path.join(PUBLIC_DIR, 'data');
const PUBLIC_IMG_DIR = path.join(PUBLIC_DIR, 'images');
const PORTFOLIO_FILE = path.join(DATA_DIR, 'portfolio.json');
const EXPANSION_MAP_FILE = path.join(DATA_DIR, 'expansion_map.json');
const DE_NAMES_FILE = path.join(DATA_DIR, 'pokemon_de_names.json');

if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
if (!fs.existsSync(IMG_CACHE_DIR)) fs.mkdirSync(IMG_CACHE_DIR, { recursive: true });
if (!fs.existsSync(PUBLIC_DATA_DIR)) fs.mkdirSync(PUBLIC_DATA_DIR, { recursive: true });
if (!fs.existsSync(PUBLIC_IMG_DIR)) fs.mkdirSync(PUBLIC_IMG_DIR, { recursive: true });

const CM_URLS = {
  priceGuide: 'https://downloads.s3.cardmarket.com/productCatalog/priceGuide/price_guide_6.json',
  singles: 'https://downloads.s3.cardmarket.com/productCatalog/productList/products_singles_6.json',
  nonsingles: 'https://downloads.s3.cardmarket.com/productCatalog/productList/products_nonsingles_6.json'
};

const expansionMap = fs.existsSync(EXPANSION_MAP_FILE)
  ? JSON.parse(fs.readFileSync(EXPANSION_MAP_FILE, 'utf8'))
  : {};

const enToDeMap = fs.existsSync(DE_NAMES_FILE)
  ? JSON.parse(fs.readFileSync(DE_NAMES_FILE, 'utf8'))
  : {};
const sortedEnTerms = Object.keys(enToDeMap).sort((a, b) => b.length - a.length);

function buildGermanDisplayName(enName, expInfo, isSealed) {
  if (!enName) return '';
  let basePart = enName;
  let bracketPart = '';
  const bIdx = enName.indexOf('[');
  if (bIdx !== -1) {
    basePart = enName.slice(0, bIdx).trim();
    bracketPart = enName.slice(bIdx).trim();
  }

  const lowerBase = basePart.toLowerCase();
  if (enToDeMap[lowerBase]) {
    const de = enToDeMap[lowerBase];
    if (de.toLowerCase() !== lowerBase) {
      return `${de} (${basePart})${bracketPart ? ' ' + bracketPart : ''}`;
    }
    return enName;
  }

  let germanMatches = [];
  for (const enKey of sortedEnTerms) {
    if (enKey.length < 3) continue;
    const idx = lowerBase.indexOf(enKey);
    if (idx !== -1) {
      const beforeOk = idx === 0 || /[^a-z0-9]/.test(lowerBase[idx - 1]);
      const afterIdx = idx + enKey.length;
      const afterOk = afterIdx === lowerBase.length || /[^a-z0-9]/.test(lowerBase[afterIdx]);
      if (beforeOk && afterOk) {
        const deName = enToDeMap[enKey];
        if (deName && deName.toLowerCase() !== enKey) {
          germanMatches.push(deName);
        }
      }
    }
  }

  let deDisplay = enName;
  if (isSealed) {
    let translatedSealed = enName;
    if (expInfo && expInfo.en && expInfo.de && expInfo.en !== expInfo.de) {
      translatedSealed = translatedSealed.replace(new RegExp(expInfo.en.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), expInfo.de);
    }
    translatedSealed = translatedSealed
      .replace(/Elite Trainer Box/gi, 'Top-Trainer-Box (TTB)')
      .replace(/Booster Box/gi, 'Display (Booster Box)');
    if (translatedSealed !== enName) deDisplay = translatedSealed;
  } else if (germanMatches.length > 0) {
    const uniqueDe = [...new Set(germanMatches)].join(' & ');
    deDisplay = `${uniqueDe} – ${enName}`;
  }

  return deDisplay;
}

function getEffectivePrices(priceEntry, isHolo = false, isSealed = false) {
  if (!priceEntry) {
    return { low: null, trend: null, dePrice: null, avg1: null, avg7: null, avg30: null, avg: null };
  }
  let low = isHolo ? (priceEntry['low-holo'] ?? priceEntry.low ?? null) : (priceEntry.low ?? priceEntry['low-holo'] ?? null);
  let trend = isHolo ? (priceEntry['trend-holo'] ?? priceEntry.trend ?? null) : (priceEntry.trend ?? priceEntry['trend-holo'] ?? null);
  let avg1 = isHolo ? (priceEntry['avg1-holo'] ?? priceEntry.avg1 ?? null) : (priceEntry.avg1 ?? priceEntry['avg1-holo'] ?? null);
  let avg7 = isHolo ? (priceEntry['avg7-holo'] ?? priceEntry.avg7 ?? null) : (priceEntry.avg7 ?? priceEntry['avg7-holo'] ?? null);
  let avg30 = isHolo ? (priceEntry['avg30-holo'] ?? priceEntry.avg30 ?? null) : (priceEntry.avg30 ?? priceEntry['avg30-holo'] ?? null);
  let avg = isHolo ? (priceEntry['avg-holo'] ?? priceEntry.avg ?? null) : (priceEntry.avg ?? priceEntry['avg-holo'] ?? null);

  let dePrice = trend ?? low;
  if (!isSealed && low != null && trend != null) {
    if (low >= trend * 0.78) {
      dePrice = low;
    } else {
      const candidates = [trend, avg1, avg7].filter(v => v != null && v >= trend * 0.75);
      dePrice = candidates.length > 0 ? Math.min(...candidates) : trend;
    }
  } else if (isSealed) {
    dePrice = trend ?? avg ?? low;
  }

  return {
    low,
    trend,
    dePrice: dePrice != null ? Number(Number(dePrice).toFixed(2)) : null,
    avg1,
    avg7,
    avg30,
    avg
  };
}

function getCandidateS3ImageUrls(product) {
  const id = product.idProduct;
  const cat = product.idCategory;
  const urls = [];

  if (cat === 51) {
    if (product.expansionCode) {
      urls.push(`https://product-images.s3.cardmarket.com/51/${product.expansionCode}/${id}/${id}.jpg`);
      urls.push(`https://product-images.s3.cardmarket.com/51/${product.expansionCode}/${id}/${id}.png`);
    }
    const bracketMatch = (product.name || '').match(/\|\s*([A-Za-z0-9-]+)\s*\]/);
    if (bracketMatch) {
      const codeGuess = bracketMatch[1].toUpperCase();
      urls.push(`https://product-images.s3.cardmarket.com/51/${codeGuess}/${id}/${id}.jpg`);
    }
  } else {
    urls.push(`https://product-images.s3.cardmarket.com/${cat}/${id}/${id}.png`);
    urls.push(`https://product-images.s3.cardmarket.com/${cat}/${id}/${id}.jpg`);
  }
  return urls;
}

async function ensurePortfolioImage(product) {
  if (!product || !product.idProduct) return null;
  const id = product.idProduct;

  for (const ext of ['.jpg', '.png']) {
    const pubFile = path.join(PUBLIC_IMG_DIR, `${id}${ext}`);
    if (fs.existsSync(pubFile)) return `images/${id}${ext}`;
    const cacheFile = path.join(IMG_CACHE_DIR, `${id}${ext}`);
    if (fs.existsSync(cacheFile)) {
      fs.copyFileSync(cacheFile, pubFile);
      return `images/${id}${ext}`;
    }
  }

  const urls = getCandidateS3ImageUrls(product);
  for (const s3Url of urls) {
    try {
      const res = await fetch(s3Url, {
        headers: {
          'Referer': 'https://www.cardmarket.com/',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });
      if (res.ok) {
        const ct = res.headers.get('content-type') || '';
        const ext = ct.includes('png') || s3Url.endsWith('.png') ? '.png' : '.jpg';
        const buf = Buffer.from(await res.arrayBuffer());
        fs.writeFileSync(path.join(PUBLIC_IMG_DIR, `${id}${ext}`), buf);
        return `images/${id}${ext}`;
      }
    } catch (e) {}
  }
  return null;
}

async function fetchOrReadCached(url, filename, forceDownload = false) {
  const filePath = path.join(CACHE_DIR, filename);
  if (!forceDownload && fs.existsSync(filePath)) {
    const ageHours = (Date.now() - fs.statSync(filePath).mtimeMs) / 3600000;
    if (ageHours < 12) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  }
  console.log(`Downloade ${url} ...`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} für ${url}`);
  const text = await res.text();
  fs.writeFileSync(filePath, text, 'utf8');
  return JSON.parse(text);
}

async function run() {
  const forceDownload = process.argv.includes('--force');
  const [priceGuideData, singlesData, nonsinglesData] = await Promise.all([
    fetchOrReadCached(CM_URLS.priceGuide, 'price_guide_6.json', forceDownload),
    fetchOrReadCached(CM_URLS.singles, 'products_singles_6.json', forceDownload),
    fetchOrReadCached(CM_URLS.nonsingles, 'products_nonsingles_6.json', forceDownload)
  ]);

  // Keep existing images in public/images (portfolio items are ensured via ensurePortfolioImage below)

  const priceMap = new Map();
  for (const pg of (priceGuideData.priceGuides || [])) {
    priceMap.set(Number(pg.idProduct), pg);
  }

  const sealedExpNames = {};
  for (const p of (nonsinglesData.products || [])) {
    if (p.idExpansion && !sealedExpNames[p.idExpansion]) {
      const cleanSet = (p.name || '').replace(/\s*(Booster Box|Booster|Elite Trainer Box|Theme Deck|Blister).*$/i, '').trim();
      if (cleanSet) sealedExpNames[p.idExpansion] = cleanSet;
    }
  }

  const productMap = new Map();
  const compactCatalog = [];

  for (const p of (nonsinglesData.products || [])) {
    const id = Number(p.idProduct);
    const expInfo = expansionMap[String(p.idExpansion)];
    const expName = expInfo ? (expInfo.de || expInfo.en) : (sealedExpNames[p.idExpansion] || '');
    const expCode = expInfo ? expInfo.code : '';
    const displayNameDe = buildGermanDisplayName(p.name || '', expInfo, true);
    const pg = priceMap.get(id);
    const prices = getEffectivePrices(pg, false, true);

    const item = {
      idProduct: id,
      name: p.name || '',
      displayNameDe,
      idCategory: p.idCategory,
      categoryName: p.categoryName || 'Sealed Produkt',
      expansionName: expName,
      expansionCode: expCode,
      type: 'sealed',
      prices
    };
    productMap.set(id, item);

    if (prices.dePrice != null || prices.low != null) {
      compactCatalog.push([
        id,
        p.name || '',
        displayNameDe !== p.name ? displayNameDe : '',
        's',
        p.categoryName || 'Sealed',
        expName,
        expCode,
        prices.dePrice,
        prices.low,
        prices.trend,
        prices.avg30,
        p.idCategory
      ]);
    }
  }

  for (const p of (singlesData.products || [])) {
    const id = Number(p.idProduct);
    const expInfo = expansionMap[String(p.idExpansion)];
    const expName = expInfo ? (expInfo.de || expInfo.en) : (sealedExpNames[p.idExpansion] || '');
    const expCode = expInfo ? expInfo.code : '';
    const displayNameDe = buildGermanDisplayName(p.name || '', expInfo, false);
    const pg = priceMap.get(id);
    const prices = getEffectivePrices(pg, false, false);

    const item = {
      idProduct: id,
      name: p.name || '',
      displayNameDe,
      idCategory: p.idCategory,
      categoryName: p.categoryName || 'Pokémon Single',
      expansionName: expName,
      expansionCode: expCode,
      type: 'single',
      prices
    };
    productMap.set(id, item);

    const hasValue = (prices.dePrice != null && prices.dePrice >= 1.0) || (prices.trend != null && prices.trend >= 1.0);
    if (hasValue || (expCode && prices.dePrice != null && prices.dePrice >= 0.25)) {
      compactCatalog.push([
        id,
        p.name || '',
        displayNameDe !== p.name ? displayNameDe : '',
        'c',
        'Single',
        expName,
        expCode,
        prices.dePrice,
        prices.low,
        prices.trend,
        prices.avg30,
        51
      ]);
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  if (fs.existsSync(PORTFOLIO_FILE)) {
    const portfolio = JSON.parse(fs.readFileSync(PORTFOLIO_FILE, 'utf8'));
    for (const item of (portfolio.items || [])) {
      if (!item.idProduct) continue;
      const prod = productMap.get(Number(item.idProduct));
      const pg = priceMap.get(Number(item.idProduct));
      if (prod) {
        item.displayNameDe = item.displayNameDe || prod.displayNameDe;
        item.expansionName = item.expansionName || prod.expansionName;
        item.expansionCode = prod.expansionCode || '';
        item.idCategory = prod.idCategory || (item.type === 'sealed' ? 1016 : 51);
        const relImg = await ensurePortfolioImage(prod);
        if (relImg) {
          item.staticImageUrl = relImg;
        }
      }
      if (pg) {
        const isSealed = item.type === 'sealed';
        const prices = getEffectivePrices(pg, Boolean(item.isHolo), isSealed);
        item.marketPrices = {
          low: prices.low,
          trend: prices.trend,
          dePrice: prices.dePrice,
          avg1: prices.avg1,
          avg7: prices.avg7,
          avg30: prices.avg30,
          avg: prices.avg,
          updatedAt: priceGuideData.createdAt || today
        };
        if (!Array.isArray(item.priceHistory)) item.priceHistory = [];
        const currentEffective = item.customLowPrice != null
          ? Number(item.customLowPrice)
          : (prices.dePrice ?? prices.trend ?? prices.low ?? 0);
        const currentTrend = prices.trend ?? currentEffective;
        if (currentEffective > 0) {
          const existingToday = item.priceHistory.find(h => h.date === today);
          if (existingToday) {
            existingToday.low = currentEffective;
            existingToday.trend = currentTrend;
          } else {
            item.priceHistory.push({
              date: today,
              low: currentEffective,
              trend: currentTrend,
              label: 'Heute'
            });
          }
        }
      }
    }
    fs.writeFileSync(PORTFOLIO_FILE, JSON.stringify(portfolio, null, 2), 'utf8');
    fs.writeFileSync(path.join(PUBLIC_DATA_DIR, 'portfolio.json'), JSON.stringify(portfolio, null, 2), 'utf8');
  }

  const catalogPayload = {
    updatedAt: priceGuideData.createdAt || new Date().toISOString(),
    count: compactCatalog.length,
    items: compactCatalog
  };
  fs.writeFileSync(path.join(PUBLIC_DATA_DIR, 'catalog_compact.json'), JSON.stringify(catalogPayload), 'utf8');
  console.log(`Static data built: ${compactCatalog.length} items in public/data/catalog_compact.json`);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
