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

const CONDITION_FACTORS = {
  M: 1.10,
  NM: 1.00,
  EX: 0.80,
  GD: 0.62,
  LP: 0.48,
  PL: 0.35,
  PO: 0.22
};

function applyConditionPrice(basePrice, condition = 'NM', isSealed = false) {
  if (basePrice == null) return null;
  const factor = isSealed
    ? (CONDITION_FACTORS[condition] != null && CONDITION_FACTORS[condition] < 1 ? CONDITION_FACTORS[condition] : 1)
    : (CONDITION_FACTORS[condition] ?? 1);
  return Number((Number(basePrice) * factor).toFixed(2));
}

function hasHoloFields(priceEntry) {
  if (!priceEntry) return false;
  return (
    (priceEntry['low-holo'] != null && Number(priceEntry['low-holo']) > 0) ||
    (priceEntry['trend-holo'] != null && Number(priceEntry['trend-holo']) > 0) ||
    (priceEntry['avg1-holo'] != null && Number(priceEntry['avg1-holo']) > 0) ||
    (priceEntry['avg7-holo'] != null && Number(priceEntry['avg7-holo']) > 0) ||
    (priceEntry['avg30-holo'] != null && Number(priceEntry['avg30-holo']) > 0)
  );
}

function posNum(v) {
  return (v != null && Number(v) > 0) ? Number(v) : null;
}

function getEffectivePrices(priceEntry, isHolo = false, isSealed = false) {
  if (!priceEntry) {
    return { low: null, trend: null, dePrice: null, avg1: null, avg7: null, avg30: null, avg: null, hasHoloPrices: false };
  }
  const hasHolo = hasHoloFields(priceEntry);
  const useHolo = Boolean(isHolo) && hasHolo;

  let low = useHolo ? posNum(priceEntry['low-holo']) : (posNum(priceEntry.low) ?? posNum(priceEntry['low-holo']));
  let trend = useHolo ? posNum(priceEntry['trend-holo']) : (posNum(priceEntry.trend) ?? posNum(priceEntry['trend-holo']));
  let avg1 = useHolo ? posNum(priceEntry['avg1-holo']) : (posNum(priceEntry.avg1) ?? posNum(priceEntry['avg1-holo']));
  let avg7 = useHolo ? posNum(priceEntry['avg7-holo']) : (posNum(priceEntry.avg7) ?? posNum(priceEntry['avg7-holo']));
  let avg30 = useHolo ? posNum(priceEntry['avg30-holo']) : (posNum(priceEntry.avg30) ?? posNum(priceEntry['avg30-holo']));
  let avg = useHolo ? posNum(priceEntry['avg-holo']) : (posNum(priceEntry.avg) ?? posNum(priceEntry['avg-holo']));

  let dePrice = trend ?? avg7 ?? avg1 ?? avg30 ?? low;
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
    avg,
    hasHoloPrices: hasHolo
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
        p.idCategory,
        expInfo?.tcgdexId || ''
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

    const hasHolo = hasHoloFields(pg);
    const holoPrices = hasHolo ? getEffectivePrices(pg, true, false) : null;
    const holoDe = holoPrices?.dePrice ?? holoPrices?.trend ?? holoPrices?.low;
    const stdHasVal = (prices.dePrice != null && prices.dePrice >= 1.0) || (prices.trend != null && prices.trend >= 1.0);
    const holoHasVal = (holoDe != null && holoDe >= 1.0);
    if (stdHasVal || holoHasVal || (expCode && (prices.dePrice != null || prices.low != null || holoDe != null))) {
      const row = [
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
        51,
        expInfo?.tcgdexId || ''
      ];
      if (holoPrices) {
        row.push([holoPrices.dePrice, holoPrices.low, holoPrices.trend, holoPrices.avg30]);
      }
      compactCatalog.push(row);
    }
  }

  // Sort compactCatalog so items with official western set codes (expCode) and higher prices come FIRST in mobile search!
  compactCatalog.sort((a, b) => {
    const hasCodeA = a[6] ? 1 : 0;
    const hasCodeB = b[6] ? 1 : 0;
    if (hasCodeA !== hasCodeB) return hasCodeB - hasCodeA;
    return (b[7] || 0) - (a[7] || 0);
  });

  const today = new Date().toISOString().slice(0, 10);
  if (fs.existsSync(PORTFOLIO_FILE)) {
    const portfolio = JSON.parse(fs.readFileSync(PORTFOLIO_FILE, 'utf8'));
    for (const item of (portfolio.items || [])) {
      if (!item.idProduct || item.type === 'expense') continue;
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
          hasHoloPrices: prices.hasHoloPrices,
          updatedAt: priceGuideData.createdAt || today
        };
        if (!Array.isArray(item.priceHistory)) item.priceHistory = [];
        const condAdjusted = applyConditionPrice(prices.dePrice ?? prices.trend ?? prices.low, item.condition || 'NM', isSealed);
        const currentEffective = item.customLowPrice != null
          ? Number(item.customLowPrice)
          : (condAdjusted ?? 0);
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

  // Build sets_index.json for the Set-Checkliste / Master-Set view
  const DE_SET_ALIASES = {
    me06: 'Delta-Herrschaft (Delta Reign)'
  };
  const setsIndex = Object.entries(expansionMap)
    .filter(([, info]) => info && info.tcgdexId && !/^tk-/i.test(info.tcgdexId))
    .map(([idExp, info]) => ({
      idExpansion: Number(idExp),
      code: info.code || '',
      tcgdexId: info.tcgdexId,
      en: info.en || '',
      de: DE_SET_ALIASES[info.tcgdexId] || info.de || info.en || ''
    }))
    .sort((a, b) => b.idExpansion - a.idExpansion);
  fs.writeFileSync(path.join(PUBLIC_DATA_DIR, 'sets_index.json'), JSON.stringify(setsIndex), 'utf8');
  console.log(`Sets index built: ${setsIndex.length} collections in public/data/sets_index.json`);

  // Ensure real Cardmarket images for all friends' items in Supabase
  try {
    const sbRes = await fetch('https://gpvttfbvbwgseztpsibb.supabase.co/rest/v1/portfolios?select=items', {
      headers: {
        'apikey': 'sb_publishable_GOIbDeTsXqcvz2tWiTv7nA_3fehgJf5',
        'Authorization': 'Bearer sb_publishable_GOIbDeTsXqcvz2tWiTv7nA_3fehgJf5'
      }
    });
    if (sbRes.ok) {
      const rows = await sbRes.json();
      const friendIds = new Set();
      for (const r of (rows || [])) {
        for (const it of (r.items || [])) {
          if (it.idProduct) friendIds.add(Number(it.idProduct));
        }
      }
      for (const id of friendIds) {
        const prod = productMap.get(id);
        if (prod) await ensurePortfolioImage(prod);
      }
      console.log(`Ensured images for ${friendIds.size} friend items from Supabase.`);
    }
  } catch (e) {}

  // In GitHub Actions Pages build (--with-sealed-images), also pre-cache all ETBs (1016) & Displays (53) into public/images/
  if (process.argv.includes('--with-sealed-images')) {
    const sealedTargets = [];
    for (const prod of productMap.values()) {
      if (prod.idCategory === 1016 || prod.idCategory === 53) {
        sealedTargets.push(prod);
      }
    }
    console.log(`Pre-caching ${sealedTargets.length} ETB & Display images for GitHub Pages...`);
    for (let i = 0; i < sealedTargets.length; i += 25) {
      await Promise.all(sealedTargets.slice(i, i + 25).map(p => ensurePortfolioImage(p).catch(() => null)));
    }
    console.log('Done pre-caching ETB & Display images.');
  }
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
