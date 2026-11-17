const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3000;
const DATA_DIR = path.join(__dirname, 'data');
const CACHE_DIR = path.join(DATA_DIR, 'cache');
const IMG_CACHE_DIR = path.join(CACHE_DIR, 'images');
const PORTFOLIO_FILE = path.join(DATA_DIR, 'portfolio.json');
const EXPANSION_MAP_FILE = path.join(DATA_DIR, 'expansion_map.json');
const DE_NAMES_FILE = path.join(DATA_DIR, 'pokemon_de_names.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
if (!fs.existsSync(IMG_CACHE_DIR)) fs.mkdirSync(IMG_CACHE_DIR, { recursive: true });

let expansionMap = {};
if (fs.existsSync(EXPANSION_MAP_FILE)) {
  try {
    expansionMap = JSON.parse(fs.readFileSync(EXPANSION_MAP_FILE, 'utf8'));
  } catch (e) {
    console.error('Fehler beim Laden der expansion_map.json:', e);
  }
}

// Load English -> German Pokémon & Trainer dictionary
let enToDeMap = {};
let sortedEnTerms = [];
if (fs.existsSync(DE_NAMES_FILE)) {
  try {
    enToDeMap = JSON.parse(fs.readFileSync(DE_NAMES_FILE, 'utf8'));
    sortedEnTerms = Object.keys(enToDeMap).sort((a, b) => b.length - a.length);
  } catch (e) {
    console.error('Fehler beim Laden der pokemon_de_names.json:', e);
  }
}

// Translate English card/sealed name into German or add German Pokémon name
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
  let germanMatches = [];

  // Check exact match first
  if (enToDeMap[lowerBase]) {
    const de = enToDeMap[lowerBase];
    if (de.toLowerCase() !== lowerBase) {
      return `${de} (${basePart})${bracketPart ? ' ' + bracketPart : ''}`;
    }
    return enName;
  }

  // Check word-boundary matches for Pokémon names inside e.g. "Greninja ex", "Mega Rayquaza ex", "Dark Charizard"
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

  // Also translate sealed product terms if applicable
  let deDisplay = enName;
  if (isSealed) {
    let translatedSealed = enName;
    if (expInfo && expInfo.en && expInfo.de && expInfo.en !== expInfo.de) {
      translatedSealed = translatedSealed.replace(new RegExp(expInfo.en.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), expInfo.de);
    }
    translatedSealed = translatedSealed
      .replace(/Elite Trainer Box/gi, 'Top-Trainer-Box (TTB)')
      .replace(/Booster Box/gi, 'Display (Booster Box)');
    if (translatedSealed !== enName) {
      deDisplay = translatedSealed;
    }
  } else if (germanMatches.length > 0) {
    const uniqueDe = [...new Set(germanMatches)].join(' & ');
    deDisplay = `${uniqueDe} – ${enName}`;
  }

  return deDisplay;
}

const CM_URLS = {
  priceGuide: 'https://downloads.s3.cardmarket.com/productCatalog/priceGuide/price_guide_6.json',
  singles: 'https://downloads.s3.cardmarket.com/productCatalog/productList/products_singles_6.json',
  nonsingles: 'https://downloads.s3.cardmarket.com/productCatalog/productList/products_nonsingles_6.json'
};

let priceMap = new Map();
let productMap = new Map();
let productList = [];
let catalogState = {
  status: 'idle',
  lastUpdated: null,
  priceGuideDate: null,
  totalSingles: 0,
  totalSealed: 0,
  error: null
};

// Always keep backup before writing so user data is never lost
function loadPortfolio() {
  if (!fs.existsSync(PORTFOLIO_FILE)) {
    const initial = { items: [] };
    fs.writeFileSync(PORTFOLIO_FILE, JSON.stringify(initial, null, 2), 'utf8');
    return initial;
  }
  try {
    return JSON.parse(fs.readFileSync(PORTFOLIO_FILE, 'utf8'));
  } catch (e) {
    return { items: [] };
  }
}

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_OWNER = 'afjb98';
const GITHUB_REPO = 'Pokemon1';
let githubSyncTimer = null;

async function ghApi(endpoint, options = {}) {
  const res = await fetch(`https://api.github.com${endpoint}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'PokeVault-AutoSync',
      ...(options.headers || {})
    }
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch (e) {}
  return { ok: res.ok, status: res.status, data, text };
}

async function ensureLocalPortfolioImageBuffer(idProduct) {
  if (!idProduct) return null;
  const product = productMap.get(Number(idProduct));
  if (!product) return null;

  const pubImgDir = path.join(__dirname, 'public', 'images');
  if (!fs.existsSync(pubImgDir)) fs.mkdirSync(pubImgDir, { recursive: true });

  for (const ext of ['.jpg', '.png']) {
    const p1 = path.join(pubImgDir, `${idProduct}${ext}`);
    if (fs.existsSync(p1)) return { ext, buffer: fs.readFileSync(p1), relPath: `public/images/${idProduct}${ext}`, staticUrl: `images/${idProduct}${ext}` };
    const p2 = path.join(IMG_CACHE_DIR, `${idProduct}${ext}`);
    if (fs.existsSync(p2)) {
      fs.copyFileSync(p2, p1);
      return { ext, buffer: fs.readFileSync(p2), relPath: `public/images/${idProduct}${ext}`, staticUrl: `images/${idProduct}${ext}` };
    }
  }

  for (const s3Url of getCandidateS3ImageUrls(product)) {
    try {
      const r = await fetch(s3Url, {
        headers: { 'Referer': 'https://www.cardmarket.com/', 'User-Agent': 'Mozilla/5.0' }
      });
      if (r.ok) {
        const ct = r.headers.get('content-type') || '';
        const ext = ct.includes('png') || s3Url.endsWith('.png') ? '.png' : '.jpg';
        const buf = Buffer.from(await r.arrayBuffer());
        fs.writeFileSync(path.join(IMG_CACHE_DIR, `${idProduct}${ext}`), buf);
        fs.writeFileSync(path.join(pubImgDir, `${idProduct}${ext}`), buf);
        return { ext, buffer: buf, relPath: `public/images/${idProduct}${ext}`, staticUrl: `images/${idProduct}${ext}` };
      }
    } catch (e) {}
  }
  return null;
}

async function syncPortfolioToGitHubNow() {
  try {
    const portfolio = loadPortfolio();
    const extraImageFiles = [];

    for (const item of (portfolio.items || [])) {
      if (item.idProduct) {
        const imgObj = await ensureLocalPortfolioImageBuffer(item.idProduct);
        if (imgObj) {
          item.staticImageUrl = imgObj.staticUrl;
          extraImageFiles.push(imgObj);
        }
      }
    }

    const jsonStr = JSON.stringify(portfolio, null, 2);
    fs.writeFileSync(PORTFOLIO_FILE, jsonStr, 'utf8');
    const pubDataDir = path.join(__dirname, 'public', 'data');
    if (!fs.existsSync(pubDataDir)) fs.mkdirSync(pubDataDir, { recursive: true });
    fs.writeFileSync(path.join(pubDataDir, 'portfolio.json'), jsonStr, 'utf8');

    const refRes = await ghApi(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/ref/heads/main`);
    if (!refRes.ok) return;
    const latestCommitSha = refRes.data.object.sha;
    const commitRes = await ghApi(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/commits/${latestCommitSha}`);
    const baseTreeSha = commitRes.data.tree.sha;

    const treeItems = [];
    // Upload portfolio.json blob
    const portBlob = await ghApi(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/blobs`, {
      method: 'POST',
      body: JSON.stringify({ content: Buffer.from(jsonStr, 'utf8').toString('base64'), encoding: 'base64' })
    });
    if (portBlob.ok) {
      treeItems.push({ path: 'data/portfolio.json', mode: '100644', type: 'blob', sha: portBlob.data.sha });
      treeItems.push({ path: 'public/data/portfolio.json', mode: '100644', type: 'blob', sha: portBlob.data.sha });
    }

    // Also include images of portfolio items
    for (const img of extraImageFiles) {
      const bRes = await ghApi(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/blobs`, {
        method: 'POST',
        body: JSON.stringify({ content: img.buffer.toString('base64'), encoding: 'base64' })
      });
      if (bRes.ok) {
        treeItems.push({ path: img.relPath, mode: '100644', type: 'blob', sha: bRes.data.sha });
      }
    }

    const newTree = await ghApi(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/trees`, {
      method: 'POST',
      body: JSON.stringify({ base_tree: baseTreeSha, tree: treeItems })
    });
    if (!newTree.ok) return;

    const newCommit = await ghApi(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/commits`, {
      method: 'POST',
      body: JSON.stringify({
        message: 'Auto-Sync Portfolio vom PC auf iPhone',
        tree: newTree.data.sha,
        parents: [latestCommitSha]
      })
    });
    if (!newCommit.ok) return;

    await ghApi(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/refs/heads/main`, {
      method: 'PATCH',
      body: JSON.stringify({ sha: newCommit.data.sha, force: true })
    });
    console.log('✓ Portfolio & Bilder automatisch mit GitHub / iPhone synchronisiert!');
  } catch (err) {
    console.error('Auto-Sync Fehler:', err.message);
  }
}

function scheduleGitHubSync() {
  clearTimeout(githubSyncTimer);
  githubSyncTimer = setTimeout(syncPortfolioToGitHubNow, 1500);
}

function savePortfolio(data, triggerCloudSync = false) {
  if (fs.existsSync(PORTFOLIO_FILE)) {
    try {
      fs.copyFileSync(PORTFOLIO_FILE, path.join(DATA_DIR, 'portfolio.backup.json'));
    } catch (e) {}
  }
  const jsonStr = JSON.stringify(data, null, 2);
  fs.writeFileSync(PORTFOLIO_FILE, jsonStr, 'utf8');
  const pubDataDir = path.join(__dirname, 'public', 'data');
  if (!fs.existsSync(pubDataDir)) fs.mkdirSync(pubDataDir, { recursive: true });
  fs.writeFileSync(path.join(pubDataDir, 'portfolio.json'), jsonStr, 'utf8');
  if (triggerCloudSync) {
    scheduleGitHubSync();
  }
}

function isCacheFresh(filePath) {
  if (!fs.existsSync(filePath)) return false;
  const stats = fs.statSync(filePath);
  const ageHours = (Date.now() - stats.mtimeMs) / (1000 * 60 * 60);
  return ageHours < 12;
}

async function fetchJsonWithCache(url, filename, forceRefresh = false) {
  const filePath = path.join(CACHE_DIR, filename);
  if (!forceRefresh && isCacheFresh(filePath)) {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} beim Laden von ${url}`);
  const text = await res.text();
  fs.writeFileSync(filePath, text, 'utf8');
  return JSON.parse(text);
}

// Build Cardmarket URL pre-filtered to German language (language=3)
function buildCardmarketUrl(product) {
  return `https://www.cardmarket.com/de/Pokemon/Products/Search?searchString=${encodeURIComponent(product.name)}&language=3`;
}

function buildProductImageUrl(product) {
  if (!product || !product.idProduct) return '';
  return `/api/cm-image/${product.idProduct}`;
}

function getCandidateS3ImageUrls(product) {
  const id = product.idProduct;
  const cat = product.idCategory;
  const urls = [];

  if (cat === 51) {
    const expInfo = expansionMap[String(product.idExpansion)];
    if (expInfo && expInfo.code) {
      urls.push(`https://product-images.s3.cardmarket.com/51/${expInfo.code}/${id}/${id}.jpg`);
      urls.push(`https://product-images.s3.cardmarket.com/51/${expInfo.code}/${id}/${id}.png`);
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

// Calculate effective prices including smart German price estimation (dePrice)
// Note: Cardmarket's bulk JSON `low` is EU-wide across all languages (including cheap IT/ES/PT/JP listings).
// For Sealed products (especially ETBs/Displays) & German cards, `trend` (or `avg7`/`avg`) reflects realistic German market prices much closer than an Italian outlier `low`.
function getEffectivePrices(priceEntry, isHolo = false, isSealed = false) {
  if (!priceEntry) {
    return {
      low: null,
      trend: null,
      dePrice: null,
      avg1: null,
      avg7: null,
      avg30: null,
      avg: null,
      hasHoloPrices: false
    };
  }

  const hasHoloPrices = hasHoloFields(priceEntry);
  const useHolo = Boolean(isHolo) && hasHoloPrices;

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
    hasHoloPrices
  };
}

// Update portfolio items with latest daily snapshot while preserving all existing user items
function syncPortfolioPrices() {
  const portfolio = loadPortfolio();
  const today = new Date().toISOString().slice(0, 10);
  let changed = false;

  for (const item of portfolio.items) {
    if (!item.idProduct || item.type === 'expense') continue;
    const prod = productMap.get(Number(item.idProduct));
    if (prod) {
      if (!item.imageUrl) {
        item.imageUrl = buildProductImageUrl(prod);
        changed = true;
      }
      if (!item.displayNameDe && prod.displayNameDe) {
        item.displayNameDe = prod.displayNameDe;
        changed = true;
      }
      if (!item.expansionName && prod.expansionName) {
        item.expansionName = prod.expansionName;
        changed = true;
      }
    }

    const priceEntry = priceMap.get(Number(item.idProduct));
    if (!priceEntry) continue;

    const isSealed = item.type === 'sealed';
    const prices = getEffectivePrices(priceEntry, Boolean(item.isHolo), isSealed);
    item.marketPrices = {
      low: prices.low,
      trend: prices.trend,
      dePrice: prices.dePrice,
      avg1: prices.avg1,
      avg7: prices.avg7,
      avg30: prices.avg30,
      avg: prices.avg,
      hasHoloPrices: prices.hasHoloPrices,
      raw: priceEntry,
      updatedAt: catalogState.priceGuideDate || today
    };

    if (!Array.isArray(item.priceHistory)) {
      item.priceHistory = [];
    }

    // Effective current price: custom override > condition-adjusted DE price
    const baseDe = prices.dePrice ?? prices.trend ?? prices.low ?? 0;
    const condAdjusted = applyConditionPrice(baseDe, item.condition || 'NM', isSealed);
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
    changed = true;
  }

  if (changed) {
    savePortfolio(portfolio);
  }
}

async function loadCardmarketCatalog(forceRefresh = false) {
  if (catalogState.status === 'loading') return;
  catalogState.status = 'loading';
  catalogState.error = null;

  try {
    console.log('Lade Cardmarket Katalog & Preisguide...');
    const [priceGuideData, singlesData, nonsinglesData] = await Promise.all([
      fetchJsonWithCache(CM_URLS.priceGuide, 'price_guide_6.json', forceRefresh),
      fetchJsonWithCache(CM_URLS.singles, 'products_singles_6.json', forceRefresh),
      fetchJsonWithCache(CM_URLS.nonsingles, 'products_nonsingles_6.json', forceRefresh)
    ]);

    const newPriceMap = new Map();
    for (const pg of (priceGuideData.priceGuides || [])) {
      newPriceMap.set(Number(pg.idProduct), pg);
    }

    const newProductMap = new Map();
    const newProductList = [];

    let singlesCount = 0;
    let sealedCount = 0;

    const sealedExpNames = {};
    for (const p of (nonsinglesData.products || [])) {
      if (p.idExpansion && !sealedExpNames[p.idExpansion]) {
        const cleanSet = (p.name || '')
          .replace(/\s*(Booster Box|Booster|Elite Trainer Box|Theme Deck|Blister).*$/i, '')
          .trim();
        if (cleanSet) sealedExpNames[p.idExpansion] = cleanSet;
      }
    }

    for (const p of (singlesData.products || [])) {
      const id = Number(p.idProduct);
      const expInfo = expansionMap[String(p.idExpansion)];
      const expName = expInfo ? (expInfo.de || expInfo.en) : (sealedExpNames[p.idExpansion] || '');
      const expCode = expInfo ? expInfo.code : '';
      const displayNameDe = buildGermanDisplayName(p.name || '', expInfo, false);

      const searchTerms = `${p.name || ''} ${displayNameDe} ${expName} ${expCode} ${expInfo?.en || ''}`.toLowerCase();

      const item = {
        idProduct: id,
        name: p.name || '',
        displayNameDe,
        searchName: searchTerms,
        idCategory: p.idCategory,
        categoryName: p.categoryName || 'Pokémon Single',
        expansionName: expName,
        expansionCode: expCode,
        tcgdexId: expInfo?.tcgdexId || '',
        type: 'single',
        idExpansion: p.idExpansion,
        idMetacard: p.idMetacard,
        hasDirectImage: Boolean(expCode)
      };
      newProductMap.set(id, item);
      newProductList.push(item);
      singlesCount++;
    }

    for (const p of (nonsinglesData.products || [])) {
      const id = Number(p.idProduct);
      const expInfo = expansionMap[String(p.idExpansion)];
      const expName = expInfo ? (expInfo.de || expInfo.en) : (sealedExpNames[p.idExpansion] || '');
      const expCode = expInfo ? expInfo.code : '';
      const displayNameDe = buildGermanDisplayName(p.name || '', expInfo, true);

      let extraSearch = `${displayNameDe} ${expName} ${expCode} ${expInfo?.en || ''}`;
      const lowerName = (p.name || '').toLowerCase();
      if (lowerName.includes('elite trainer box') || p.idCategory === 1016) {
        extraSearch += ' ttb etb top trainer box top-trainer-box elite trainer box';
      }
      if (lowerName.includes('booster box') || p.idCategory === 53) {
        extraSearch += ' display booster box';
      }

      const item = {
        idProduct: id,
        name: p.name || '',
        displayNameDe,
        searchName: `${lowerName} ${extraSearch.toLowerCase()}`,
        idCategory: p.idCategory,
        categoryName: p.categoryName || 'Sealed Produkt',
        expansionName: expName,
        expansionCode: expCode,
        tcgdexId: expInfo?.tcgdexId || '',
        type: 'sealed',
        idExpansion: p.idExpansion,
        idMetacard: p.idMetacard,
        hasDirectImage: true
      };
      newProductMap.set(id, item);
      newProductList.push(item);
      sealedCount++;
    }

    priceMap = newPriceMap;
    productMap = newProductMap;
    productList = newProductList;

    catalogState = {
      status: 'ready',
      lastUpdated: new Date().toISOString(),
      priceGuideDate: priceGuideData.createdAt || new Date().toISOString(),
      totalSingles: singlesCount,
      totalSealed: sealedCount,
      error: null
    };

    console.log(`Cardmarket Katalog bereit: ${singlesCount} Einzelkarten, ${sealedCount} Sealed-Produkte, ${priceMap.size} Preise.`);
    syncPortfolioPrices();
  } catch (err) {
    console.error('Fehler beim Laden des Cardmarket-Katalogs:', err);
    catalogState.status = 'error';
    catalogState.error = err.message;
  }
}

function searchCatalog(query, typeFilter = 'all', limit = 60) {
  const q = (query || '').trim().toLowerCase();
  if (!q) return [];

  const tokens = q.split(/\s+/).filter(Boolean);
  const isNumericId = /^\d+$/.test(q);
  const results = [];

  if (isNumericId && productMap.has(Number(q))) {
    const exact = productMap.get(Number(q));
    const pg = priceMap.get(exact.idProduct);
    const isSealed = exact.type === 'sealed';
    results.push({
      ...exact,
      imageUrl: buildProductImageUrl(exact),
      prices: getEffectivePrices(pg, false, isSealed),
      holoPrices: getEffectivePrices(pg, true, isSealed),
      hasHolo: Boolean(pg && (pg['low-holo'] != null || pg['trend-holo'] != null)),
      cardmarketUrl: buildCardmarketUrl(exact)
    });
  }

  for (let i = 0; i < productList.length; i++) {
    const p = productList[i];
    if (typeFilter === 'single' && p.type !== 'single') continue;
    if (typeFilter === 'sealed' && p.type !== 'sealed') continue;
    if (isNumericId && p.idProduct === Number(q)) continue;

    let match = true;
    for (let t = 0; t < tokens.length; t++) {
      if (!p.searchName.includes(tokens[t]) && String(p.idProduct) !== tokens[t]) {
        match = false;
        break;
      }
    }
    if (!match) continue;

    const pg = priceMap.get(p.idProduct);
    const isSealed = p.type === 'sealed';
    let score = 0;
    const rawLower = (p.name || '').toLowerCase();
    const deLower = (p.displayNameDe || '').toLowerCase();

    if (rawLower === q || deLower === q) score += 120;
    else if (rawLower.startsWith(q) || deLower.startsWith(q)) score += 60;
    if (p.hasDirectImage) score += 80; // Strongly prefer western/German sets that have S3 images over Chinese/Indonesian variants
    if (pg && (pg.low != null || pg.trend != null)) score += 25;

    results.push({
      ...p,
      score,
      imageUrl: buildProductImageUrl(p),
      prices: getEffectivePrices(pg, false, isSealed),
      holoPrices: getEffectivePrices(pg, true, isSealed),
      hasHolo: Boolean(pg && (pg['low-holo'] != null || pg['trend-holo'] != null)),
      cardmarketUrl: buildCardmarketUrl(p)
    });

    if (results.length >= 700) break;
  }

  results.sort((a, b) => (b.score || 0) - (a.score || 0));
  return results.slice(0, limit);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(data));
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host}`);
  const pathname = urlObj.pathname;

  try {
    if (pathname.startsWith('/api/cm-image/') && req.method === 'GET') {
      const idStr = pathname.split('/').pop().replace(/[^0-9]/g, '');
      const idProduct = Number(idStr);
      const product = productMap.get(idProduct);

      if (!product) {
        res.writeHead(404);
        return res.end('Not found');
      }

      const cachedJpg = path.join(IMG_CACHE_DIR, `${idProduct}.jpg`);
      const cachedPng = path.join(IMG_CACHE_DIR, `${idProduct}.png`);

      if (fs.existsSync(cachedJpg)) {
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=604800' });
        return fs.createReadStream(cachedJpg).pipe(res);
      }
      if (fs.existsSync(cachedPng)) {
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=604800' });
        return fs.createReadStream(cachedPng).pipe(res);
      }

      const candidateUrls = getCandidateS3ImageUrls(product);
      for (const s3Url of candidateUrls) {
        try {
          const imgRes = await fetch(s3Url, {
            headers: {
              'Referer': 'https://www.cardmarket.com/',
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
          });
          if (imgRes.ok) {
            const contentType = imgRes.headers.get('content-type') || (s3Url.endsWith('.png') ? 'image/png' : 'image/jpeg');
            const ext = contentType.includes('png') ? '.png' : '.jpg';
            const arrayBuf = await imgRes.arrayBuffer();
            const buffer = Buffer.from(arrayBuf);
            fs.writeFileSync(path.join(IMG_CACHE_DIR, `${idProduct}${ext}`), buffer);

            res.writeHead(200, {
              'Content-Type': contentType,
              'Cache-Control': 'public, max-age=604800'
            });
            return res.end(buffer);
          }
        } catch (e) {}
      }

      const isSealed = product.type === 'sealed';
      const label = (product.expansionCode || (isSealed ? 'BOX' : 'KARTE')).slice(0, 6);
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="168" viewBox="0 0 120 168">
        <rect width="120" height="168" rx="8" fill="#18181b" stroke="#27272a" stroke-width="2"/>
        <text x="60" y="88" text-anchor="middle" fill="#71717a" font-family="sans-serif" font-weight="600" font-size="13">${label}</text>
      </svg>`;
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=3600' });
      return res.end(svg);
    }

    if (pathname === '/api/status' && req.method === 'GET') {
      return sendJson(res, 200, catalogState);
    }

    if (pathname === '/api/refresh-catalog' && req.method === 'POST') {
      loadCardmarketCatalog(true);
      return sendJson(res, 200, { message: 'Aktualisierung gestartet', state: catalogState });
    }

    if (pathname === '/api/search' && req.method === 'GET') {
      const q = urlObj.searchParams.get('q') || '';
      const type = urlObj.searchParams.get('type') || 'all';
      if (catalogState.status !== 'ready') {
        return sendJson(res, 200, { results: [], status: catalogState.status });
      }
      const results = searchCatalog(q, type, 60);
      return sendJson(res, 200, { results, status: catalogState.status });
    }

    if (pathname === '/api/portfolio' && req.method === 'GET') {
      const portfolio = loadPortfolio();
      return sendJson(res, 200, portfolio);
    }

    if (pathname === '/api/portfolio' && req.method === 'POST') {
      const body = await parseBody(req);
      const portfolio = loadPortfolio();

      const idProduct = body.idProduct ? Number(body.idProduct) : null;
      const productInfo = idProduct ? productMap.get(idProduct) : null;
      const priceEntry = idProduct ? priceMap.get(idProduct) : null;
      const variant = body.variant || (body.isHolo ? 'holo' : 'normal');
      const isHolo = variant !== 'normal';
      const isFirstEdition = Boolean(body.isFirstEdition);
      const condition = body.condition || 'NM';
      const isSealed = (body.type || (productInfo ? productInfo.type : 'single')) === 'sealed';
      const prices = getEffectivePrices(priceEntry, isHolo, isSealed);

      const today = new Date().toISOString().slice(0, 10);
      const buyPrice = (body.buyPrice === null || body.buyPrice === undefined || body.buyPrice === '')
        ? null
        : Number(body.buyPrice);
      const quantity = Math.max(1, Number(body.quantity) || 1);
      const buyDate = body.buyDate || today;
      const customLowPrice = body.customLowPrice !== '' && body.customLowPrice != null ? Number(body.customLowPrice) : null;

      const priceHistory = [];
      const now = new Date();
      const d30 = new Date(now.getTime() - 30 * 86400000).toISOString().slice(0, 10);
      const d14 = new Date(now.getTime() - 14 * 86400000).toISOString().slice(0, 10);
      const d7 = new Date(now.getTime() - 7 * 86400000).toISOString().slice(0, 10);
      const d1 = new Date(now.getTime() - 1 * 86400000).toISOString().slice(0, 10);

      const condAdjusted = applyConditionPrice(prices.dePrice ?? prices.trend ?? prices.low, condition, isSealed);
      const effectiveLow = customLowPrice ?? condAdjusted ?? buyPrice ?? 0;
      const p30 = applyConditionPrice(prices.avg30 ?? prices.trend, condition, isSealed) ?? effectiveLow;
      const p7 = applyConditionPrice(prices.avg7 ?? prices.trend, condition, isSealed) ?? effectiveLow;
      const p1 = applyConditionPrice(prices.avg1, condition, isSealed) ?? effectiveLow;
      const p14 = Number(((p30 + p7) / 2).toFixed(2));

      if (p30 > 0) priceHistory.push({ date: d30, low: Number(p30.toFixed(2)), trend: prices.trend ?? p30, label: '30T Ø' });
      if (p14 > 0) priceHistory.push({ date: d14, low: p14, trend: prices.trend ?? p14, label: '14T Ø' });
      if (p7 > 0) priceHistory.push({ date: d7, low: Number(p7.toFixed(2)), trend: prices.trend ?? p7, label: '7T Ø' });
      if (p1 > 0 && d1 !== today) priceHistory.push({ date: d1, low: Number(p1.toFixed(2)), trend: prices.trend ?? p1, label: 'Gestern' });
      if (effectiveLow > 0) {
        priceHistory.push({
          date: today,
          low: Number(effectiveLow.toFixed(2)),
          trend: Number((prices.trend ?? effectiveLow).toFixed(2)),
          label: 'Heute'
        });
      }

      const autoImageUrl = productInfo ? buildProductImageUrl(productInfo) : '';

      const newItem = {
        id: 'item_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
        idProduct: idProduct,
        name: body.name || (productInfo ? (productInfo.displayNameDe || productInfo.name) : 'Unbekanntes Produkt'),
        displayNameDe: productInfo ? productInfo.displayNameDe : '',
        type: body.type || (productInfo ? productInfo.type : 'single'),
        categoryName: body.categoryName || (productInfo ? productInfo.categoryName : 'Pokémon Single'),
        expansionName: productInfo ? productInfo.expansionName : '',
        expansionCode: productInfo ? productInfo.expansionCode : '',
        tcgdexId: productInfo ? (productInfo.tcgdexId || '') : '',
        variant: variant,
        isHolo: isHolo,
        isFirstEdition: isFirstEdition,
        condition: condition,
        language: body.language || 'DE',
        quantity: quantity,
        buyPrice: buyPrice,
        buyDate: buyDate,
        customLowPrice: customLowPrice,
        packsCount: body.packsCount ? Math.max(1, Number(body.packsCount)) : null,
        expensePreset: body.expensePreset || '',
        imageUrl: body.imageUrl || autoImageUrl,
        cardmarketUrl: body.cardmarketUrl || (productInfo ? buildCardmarketUrl(productInfo) : ''),
        notes: body.notes || '',
        marketPrices: body.type === 'expense'
          ? { low: 0, trend: 0, dePrice: 0, avg30: 0, updatedAt: today }
          : {
              low: prices.low,
              trend: prices.trend,
              dePrice: prices.dePrice,
              avg1: prices.avg1,
              avg7: prices.avg7,
              avg30: prices.avg30,
              avg: prices.avg,
              hasHoloPrices: prices.hasHoloPrices,
              updatedAt: catalogState.priceGuideDate || today
            },
        priceHistory: body.type === 'expense' ? [] : priceHistory,
        createdAt: new Date().toISOString()
      };

      portfolio.items.unshift(newItem);
      savePortfolio(portfolio, true);
      return sendJson(res, 201, newItem);
    }

    if (pathname.startsWith('/api/portfolio/') && req.method === 'PUT') {
      const id = pathname.split('/').pop();
      const body = await parseBody(req);
      const portfolio = loadPortfolio();
      const idx = portfolio.items.findIndex(i => i.id === id);
      if (idx === -1) return sendJson(res, 404, { error: 'Eintrag nicht gefunden' });

      const item = portfolio.items[idx];
      if (body.name !== undefined) item.name = body.name;
      if (body.buyDate !== undefined) item.buyDate = body.buyDate;
      if (body.packsCount !== undefined) item.packsCount = body.packsCount ? Math.max(1, Number(body.packsCount)) : null;
      if (body.expensePreset !== undefined) item.expensePreset = body.expensePreset;
      if (body.buyPrice !== undefined) {
        item.buyPrice = (body.buyPrice === null || body.buyPrice === '') ? null : Number(body.buyPrice);
      }
      if (body.quantity !== undefined) item.quantity = Math.max(1, Number(body.quantity));
      if (body.condition !== undefined) item.condition = body.condition;
      if (body.language !== undefined) item.language = body.language;
      if (body.variant !== undefined) {
        item.variant = body.variant;
        item.isHolo = body.variant !== 'normal';
      } else if (body.isHolo !== undefined) {
        item.isHolo = Boolean(body.isHolo);
        item.variant = item.isHolo ? (item.variant && item.variant !== 'normal' ? item.variant : 'holo') : 'normal';
      }
      if (body.isFirstEdition !== undefined) item.isFirstEdition = Boolean(body.isFirstEdition);
      if (body.imageUrl !== undefined) item.imageUrl = body.imageUrl;
      if (body.cardmarketUrl !== undefined) item.cardmarketUrl = body.cardmarketUrl;
      if (body.notes !== undefined) item.notes = body.notes;
      if (body.customLowPrice !== undefined) {
        item.customLowPrice = body.customLowPrice === '' || body.customLowPrice === null ? null : Number(body.customLowPrice);
      }

      if (item.idProduct && priceMap.has(Number(item.idProduct))) {
        const pg = priceMap.get(Number(item.idProduct));
        const prices = getEffectivePrices(pg, Boolean(item.isHolo), item.type === 'sealed');
        item.marketPrices = {
          ...item.marketPrices,
          low: prices.low,
          trend: prices.trend,
          dePrice: prices.dePrice,
          avg1: prices.avg1,
          avg7: prices.avg7,
          avg30: prices.avg30,
          avg: prices.avg,
          hasHoloPrices: prices.hasHoloPrices
        };
      }

      if (body.newSnapshotPrice != null && body.newSnapshotPrice !== '') {
        const snapPrice = Number(body.newSnapshotPrice);
        const snapDate = body.newSnapshotDate || new Date().toISOString().slice(0, 10);
        if (!Array.isArray(item.priceHistory)) item.priceHistory = [];
        const existing = item.priceHistory.find(h => h.date === snapDate);
        if (existing) {
          existing.low = snapPrice;
        } else {
          item.priceHistory.push({
            date: snapDate,
            low: snapPrice,
            trend: item.marketPrices?.trend ?? snapPrice,
            label: 'DE Preis'
          });
          item.priceHistory.sort((a, b) => a.date.localeCompare(b.date));
        }
        item.customLowPrice = snapPrice;
      }

      savePortfolio(portfolio, true);
      return sendJson(res, 200, item);
    }

    if (pathname.startsWith('/api/portfolio/') && req.method === 'DELETE') {
      const id = pathname.split('/').pop();
      const portfolio = loadPortfolio();
      portfolio.items = portfolio.items.filter(i => i.id !== id);
      savePortfolio(portfolio, true);
      return sendJson(res, 200, { deleted: id });
    }

    let filePath = path.join(__dirname, 'public', pathname === '/' ? 'index.html' : pathname);
    if (!filePath.startsWith(path.join(__dirname, 'public'))) {
      res.writeHead(403);
      return res.end('Forbidden');
    }

    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
      fs.createReadStream(filePath).pipe(res);
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  } catch (err) {
    console.error(err);
    sendJson(res, 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`Pokémon Cardmarket Tracker läuft auf http://localhost:${PORT}`);
  loadCardmarketCatalog(false);
});
