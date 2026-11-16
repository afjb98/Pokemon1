let portfolioItems = [];
let activeFilter = 'all';
let viewMode = 'sets'; // 'sets' (Pro Set Galerie wie im Screenshot) | 'table'
let collapsedSets = new Set();
let searchQuery = '';
let sortMode = 'profitDesc';
let selectedChartItemId = null;
let catalogSearchType = 'all';
let priceChartInstance = null;
let searchDebounceTimer = null;

// Hybrid Mode State: works with local Node.js backend OR pure static GitHub Pages / iPhone PWA
let isStaticMode = false;
let staticCatalogItems = null; // loaded lazily from ./data/catalog_compact.json when in static mode
const LOCAL_STORAGE_KEY = 'pokevault_portfolio_v1';
const PERSONAL_PORTFOLIO_KEY = 'pokevault_personal_portfolio_v1';
const PERSONAL_ID_KEY = 'pokevault_personal_profile_id';
const PROFILE_MODE_KEY = 'pokevault_profile_mode';
const PROFILE_NAME_KEY = 'pokevault_profile_name';
const ADMIN_FLAG_KEY = 'pokevault_is_admin';
const ADMIN_SESSION_KEY = 'pokevault_admin_session_v1';
const IMG_FALLBACK_CACHE_KEY = 'pokevault_img_cache_v1';

// Supabase Cloud Config (for Friends' Portfolios -> protected via Supabase Auth + RLS)
const SUPABASE_BASE_URL = 'https://gpvttfbvbwgseztpsibb.supabase.co';
const SUPABASE_REST_URL = `${SUPABASE_BASE_URL}/rest/v1`;
const SUPABASE_AUTH_URL = `${SUPABASE_BASE_URL}/auth/v1`;
const SUPABASE_KEY = 'sb_publishable_GOIbDeTsXqcvz2tWiTv7nA_3fehgJf5';

let profileMode = 'owner'; // 'owner' | 'personal'
let profileName = '';
let personalProfileId = '';
let isAdminMode = false;
let viewingFriend = null; // null or { id, owner_name, updated_at, items }

// In-memory + localStorage caches for TCGdex fallback images on mobile
let tcgdexImgCache = {};
try {
  tcgdexImgCache = JSON.parse(localStorage.getItem(IMG_FALLBACK_CACHE_KEY) || '{}');
} catch (e) { tcgdexImgCache = {}; }
const tcgdexSetPromises = new Map();
const tcgdexInflightCard = new Map();

function saveImgFallbackCache() {
  try {
    const keys = Object.keys(tcgdexImgCache);
    if (keys.length > 500) {
      for (const k of keys.slice(0, 100)) delete tcgdexImgCache[k];
    }
    localStorage.setItem(IMG_FALLBACK_CACHE_KEY, JSON.stringify(tcgdexImgCache));
  } catch (e) {}
}

function showToast(msg, duration = 3200) {
  const el = document.getElementById('toastBanner');
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => el.classList.add('hidden'), duration);
}

function getFriendShareUrl() {
  if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
    return 'https://afjb98.github.io/Pokemon1/?friend=1';
  }
  return `${window.location.origin}${window.location.pathname}?friend=1`;
}

function getOrCreatePersonalId() {
  let pid = localStorage.getItem(PERSONAL_ID_KEY);
  if (!pid) {
    pid = 'f_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    localStorage.setItem(PERSONAL_ID_KEY, pid);
  }
  return pid;
}

let supabaseSyncTimer = null;
function scheduleSupabaseSync() {
  if (profileMode !== 'personal' || !profileName || viewingFriend) return;
  clearTimeout(supabaseSyncTimer);
  supabaseSyncTimer = setTimeout(syncPersonalPortfolioToSupabase, 600);
}

async function syncPersonalPortfolioToSupabase() {
  if (profileMode !== 'personal' || !profileName || viewingFriend) return;
  try {
    const pid = personalProfileId || getOrCreatePersonalId();
    // Strip any huge transient fields before uploading
    const cleanItems = portfolioItems.map(it => {
      const copy = { ...it };
      if (copy.marketPrices && copy.marketPrices.raw) {
        copy.marketPrices = { ...copy.marketPrices };
        delete copy.marketPrices.raw;
      }
      return copy;
    });
    await fetch(`${SUPABASE_REST_URL}/rpc/save_friend_portfolio`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        p_id: pid,
        p_name: profileName,
        p_items: cleanItems
      })
    });
  } catch (e) {
    console.warn('Cloud sync hint:', e);
  }
}

// Supabase Admin Authentication Helpers
function getAdminSession() {
  try {
    const raw = localStorage.getItem(ADMIN_SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

function saveAdminSession(session) {
  try {
    localStorage.setItem(ADMIN_SESSION_KEY, JSON.stringify(session));
  } catch (e) {}
}

function clearAdminSession() {
  try {
    localStorage.removeItem(ADMIN_SESSION_KEY);
  } catch (e) {}
}

async function getValidAdminAccessToken() {
  const sess = getAdminSession();
  if (!sess || !sess.access_token) return null;

  // Still valid for at least 60 seconds
  if (sess.expires_at && Date.now() < sess.expires_at - 60000) {
    return sess.access_token;
  }

  if (!sess.refresh_token) {
    clearAdminSession();
    return null;
  }

  try {
    const res = await fetch(`${SUPABASE_AUTH_URL}/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ refresh_token: sess.refresh_token })
    });
    if (!res.ok) {
      clearAdminSession();
      return null;
    }
    const data = await res.json();
    const updated = {
      access_token: data.access_token,
      refresh_token: data.refresh_token || sess.refresh_token,
      expires_at: Date.now() + (Number(data.expires_in) || 3600) * 1000,
      email: data.user?.email || sess.email
    };
    saveAdminSession(updated);
    return updated.access_token;
  } catch (e) {
    return null;
  }
}

async function adminSignIn(email, password) {
  const res = await fetch(`${SUPABASE_AUTH_URL}/token?grant_type=password`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ email, password })
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error(data.error_description || data.msg || 'E-Mail oder Passwort falsch.');
  }
  const session = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + (Number(data.expires_in) || 3600) * 1000,
    email: data.user?.email || email
  };
  saveAdminSession(session);
  return session;
}

function initProfileState() {
  const params = new URLSearchParams(window.location.search);
  const storedMode = localStorage.getItem(PROFILE_MODE_KEY);
  const storedName = localStorage.getItem(PROFILE_NAME_KEY) || '';
  personalProfileId = getOrCreatePersonalId();

  // Admin unlock: automatic on PC (localhost) OR via ?admin=1 on your iPhone
  const isLocalHost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
  if (params.get('admin') === '1') {
    localStorage.setItem(ADMIN_FLAG_KEY, '1');
    isAdminMode = true;
  } else {
    isAdminMode = isLocalHost || localStorage.getItem(ADMIN_FLAG_KEY) === '1';
  }

  if (params.get('friend') === '1' || params.get('new') === '1') {
    profileMode = 'personal';
    profileName = storedName;
    localStorage.setItem(PROFILE_MODE_KEY, 'personal');
  } else if (params.get('owner') === '1') {
    profileMode = 'owner';
    profileName = storedName;
    localStorage.setItem(PROFILE_MODE_KEY, 'owner');
  } else {
    profileMode = storedMode === 'personal' ? 'personal' : 'owner';
    profileName = storedName;
  }

  updateProfileHeader();

  if (profileMode === 'personal' && !profileName) {
    setTimeout(() => openProfileModal(true), 120);
  }
}

function updateProfileHeader() {
  const titleEl = document.getElementById('appBrandTitle');
  const markEl = document.getElementById('brandMark');
  const badgeEl = document.getElementById('profileBadgeBtn');
  const switchBtn = document.getElementById('btnOpenProfileModal');
  const subtitleEl = document.getElementById('appBrandSubtitle');
  const friendsBtn = document.getElementById('btnOpenFriendsModal');
  const shareBtn = document.getElementById('btnShareFriendLink');
  const addBtn = document.getElementById('btnOpenAddModal');
  const viewBanner = document.getElementById('viewingFriendBanner');

  // Show "Freunde" button ONLY for you (PC or unlocked iPhone ?admin=1)
  if (friendsBtn) {
    if (isAdminMode) friendsBtn.classList.remove('hidden');
    else friendsBtn.classList.add('hidden');
  }

  // Hide "Freunde-Link" & "Geteilte Sammlung" from friends when they are in personal mode (unless you are Admin)
  if (shareBtn) {
    if (!isAdminMode && profileMode === 'personal') shareBtn.classList.add('hidden');
    else shareBtn.classList.remove('hidden');
  }

  if (viewingFriend) {
    const fName = viewingFriend.owner_name || 'Freund';
    titleEl.textContent = `Portfolio von ${fName}`;
    document.title = `Portfolio von ${fName} – Ansicht`;
    markEl.textContent = fName.slice(0, 2).toUpperCase();
    badgeEl.textContent = 'Freunde-Ansicht';
    subtitleEl.textContent = 'Live-Stand aus der Cloud (nur Leseansicht)';
    if (addBtn) addBtn.classList.add('hidden');
    if (viewBanner) {
      viewBanner.classList.remove('hidden');
      document.getElementById('viewingFriendLabel').textContent = `Du siehst gerade: Portfolio von ${fName}`;
      const upd = viewingFriend.updated_at ? new Date(viewingFriend.updated_at).toLocaleString('de-DE') : '';
      document.getElementById('viewingFriendSub').textContent = upd ? `Zuletzt aktualisiert: ${upd} • Schreibgeschützt` : 'Schreibgeschützte Live-Ansicht';
    }
    return;
  }

  if (viewBanner) viewBanner.classList.add('hidden');
  if (addBtn) addBtn.classList.remove('hidden');

  if (profileMode === 'personal' && profileName) {
    titleEl.textContent = `Portfolio von ${profileName}`;
    document.title = `Portfolio von ${profileName} – Cardmarket DE`;
    markEl.textContent = profileName.slice(0, 2).toUpperCase();
    badgeEl.textContent = `Profil: ${profileName} ✎`;
    switchBtn.textContent = 'Name ändern';
    subtitleEl.textContent = 'Persönliche Sammlung mit täglichen deutschen Cardmarket-Preisen';
  } else {
    titleEl.textContent = 'Pokémon Portfolio';
    document.title = 'Sammlung & Portfolio – Cardmarket DE';
    markEl.textContent = 'CM';
    badgeEl.textContent = 'DE Marktpreise';
    switchBtn.textContent = 'Eigenes Portfolio';
    subtitleEl.textContent = 'Bestand, Einkaufspreise & Wertentwicklung auf Basis deutscher Cardmarket-Preise';
  }
}

function fmtEuro(val) {
  if (val === null || val === undefined || Number.isNaN(Number(val))) return '—';
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(Number(val));
}

function fmtSignedEuro(val) {
  const num = Number(val) || 0;
  const formatted = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(Math.abs(num));
  return num >= 0 ? `+${formatted}` : `-${formatted}`;
}

function fmtSignedPct(val) {
  const num = Number(val) || 0;
  const formatted = Math.abs(num).toFixed(2).replace('.', ',');
  return num >= 0 ? `+${formatted} %` : `-${formatted} %`;
}

function getUnitDePrice(item) {
  if (item.customLowPrice !== null && item.customLowPrice !== undefined && item.customLowPrice !== '') {
    return Number(item.customLowPrice);
  }
  if (item.marketPrices?.dePrice != null) {
    return Number(item.marketPrices.dePrice);
  }
  if (item.type === 'sealed' && item.marketPrices?.trend != null) {
    return Number(item.marketPrices.trend);
  }
  if (item.marketPrices?.low != null) {
    return Number(item.marketPrices.low);
  }
  return Number(item.buyPrice) || 0;
}

function getUnitRawEuLow(item) {
  if (item.marketPrices?.low != null) {
    return Number(item.marketPrices.low);
  }
  return getUnitDePrice(item);
}

// Resolve image URL for both local server mode and GitHub Pages static mode
function resolveItemImageUrl(item) {
  if (!isStaticMode) {
    // On PC server: always prefer real Cardmarket image proxy when idProduct is present
    if (item.idProduct) return `/api/cm-image/${item.idProduct}`;
    return item.imageUrl || '';
  }
  if (item.staticImageUrl) return `./${item.staticImageUrl}`;
  if (item.idProduct) {
    // Always try real Cardmarket cached image (.jpg -> .png via handleCardImageError) before any fallback
    return `./images/${item.idProduct}.jpg`;
  }
  if (item.imageUrl && !String(item.imageUrl).includes('tcgdex.net')) return item.imageUrl;
  return item.fallbackImageUrl || '';
}

function getActiveStorageKey() {
  return profileMode === 'personal' ? PERSONAL_PORTFOLIO_KEY : LOCAL_STORAGE_KEY;
}

function saveLocalPortfolio() {
  if (viewingFriend) return; // Never overwrite local storage when inspecting a friend
  try {
    localStorage.setItem(
      getActiveStorageKey(),
      JSON.stringify({ items: portfolioItems, ownerName: profileName, savedAt: new Date().toISOString() })
    );
  } catch (e) {}
  if (profileMode === 'personal' && profileName) {
    scheduleSupabaseSync();
  }
}

function cleanEnglishCardNameForApi(rawName) {
  let n = String(rawName || '').replace(/\[.*?\]/g, '').trim();
  // If formatted like "Glurak – Charizard ex" or "Glurak (Charizard)"
  if (n.includes(' – ')) n = n.split(' – ').slice(1).join(' – ').trim();
  const parenMatch = n.match(/^[^(]+\(([^)]+)\)$/);
  if (parenMatch) n = parenMatch[1].trim();
  return n.trim();
}

async function fetchTcgdexSet(tcgdexId) {
  if (!tcgdexId) return null;
  if (tcgdexSetPromises.has(tcgdexId)) return tcgdexSetPromises.get(tcgdexId);
  const p = fetch(`https://api.tcgdex.net/v2/en/sets/${encodeURIComponent(tcgdexId)}`)
    .then(r => (r.ok ? r.json() : null))
    .catch(() => null);
  tcgdexSetPromises.set(tcgdexId, p);
  return p;
}

async function resolveTcgdexImage(idProduct, rawName, type, tcgdexId) {
  const key = String(idProduct || rawName || '');
  if (tcgdexImgCache[key]) return tcgdexImgCache[key];
  if (tcgdexInflightCard.has(key)) return tcgdexInflightCard.get(key);

  const task = (async () => {
    try {
      const cleanName = cleanEnglishCardNameForApi(rawName);
      if (type === 'sealed') {
        if (tcgdexId) {
          const setObj = await fetchTcgdexSet(tcgdexId);
          if (setObj?.logo) {
            const url = `${setObj.logo}.webp`;
            tcgdexImgCache[key] = url;
            saveImgFallbackCache();
            return url;
          }
        }
        return null;
      }

      // Single card: first try exact set lookup via tcgdexId
      if (tcgdexId && cleanName) {
        const setObj = await fetchTcgdexSet(tcgdexId);
        if (setObj && Array.isArray(setObj.cards)) {
          const lower = cleanName.toLowerCase();
          const norm = lower.replace(/[^a-z0-9]/g, '');
          let match = setObj.cards.find(c => c.image && c.name && c.name.toLowerCase() === lower);
          if (!match) {
            match = setObj.cards.find(c => c.image && c.name && c.name.toLowerCase().replace(/[^a-z0-9]/g, '') === norm);
          }
          if (!match) {
            match = setObj.cards.find(c => c.image && c.name && (c.name.toLowerCase().includes(lower) || lower.includes(c.name.toLowerCase())));
          }
          if (match?.image) {
            const url = `${match.image}/low.webp`;
            tcgdexImgCache[key] = url;
            saveImgFallbackCache();
            return url;
          }
        }
      }

      // Fallback: global TCGdex card search by name (prefer physical TCG cards over tcgp)
      if (cleanName && cleanName.length >= 2) {
        const res = await fetch(`https://api.tcgdex.net/v2/en/cards?name=${encodeURIComponent(cleanName)}`);
        if (res.ok) {
          const list = await res.json();
          if (Array.isArray(list)) {
            const withImg = list.filter(c => c.image);
            const physical = withImg.filter(c => !String(c.image).includes('/tcgp/'));
            const chosen = physical[0] || withImg[0];
            if (chosen?.image) {
              const url = `${chosen.image}/low.webp`;
              tcgdexImgCache[key] = url;
              saveImgFallbackCache();
              return url;
            }
          }
        }
      }
    } catch (e) {}
    return null;
  })();

  tcgdexInflightCard.set(key, task);
  const resUrl = await task;
  tcgdexInflightCard.delete(key);
  return resUrl;
}

window.handleCardImageError = async function(imgEl) {
  if (!imgEl) return;

  const idProduct = imgEl.dataset.id;
  const rawName = imgEl.dataset.name;
  const type = imgEl.dataset.type || 'single';
  const tcgdexId = imgEl.dataset.tcgdex || '';
  const badge = imgEl.dataset.badge || (type === 'sealed' ? 'BOX' : 'TCG');
  const step = imgEl.dataset.tryStep || '';

  // Step 1 on static mode: if .jpg failed, try .png in ./images/
  if (isStaticMode && idProduct && step === '' && imgEl.getAttribute('src')?.endsWith('.jpg')) {
    imgEl.dataset.tryStep = 'png';
    imgEl.src = `./images/${idProduct}.png`;
    return;
  }

  // Step 2: if already tried TCGdex fallback, show badge
  if (step === 'tcgdex' || step === 'done') {
    if (imgEl.parentElement) imgEl.parentElement.textContent = badge;
    return;
  }

  imgEl.dataset.tryStep = 'tcgdex';

  // On PC localhost, local server handles Cardmarket S3 directly (no TCGdex set-logo override needed)
  if (!isStaticMode && !tcgdexId) {
    if (imgEl.parentElement) imgEl.parentElement.textContent = badge;
    return;
  }

  const url = await resolveTcgdexImage(idProduct, rawName, type, tcgdexId);
  if (url) {
    imgEl.src = url;
  } else {
    imgEl.dataset.tryStep = 'done';
    if (imgEl.parentElement) imgEl.parentElement.textContent = badge;
  }
};

// Check Backend Status or Switch to Static GitHub Pages Mode
async function pollCatalogStatus() {
  const badge = document.getElementById('catalogStatusBadge');
  const text = document.getElementById('catalogStatusText');

  try {
    const res = await fetch('/api/status');
    if (!res.ok) throw new Error('Static mode');
    const state = await res.json();
    isStaticMode = false;

    badge.className = 'status-pill ' + state.status;
    if (state.status === 'ready') {
      const total = (state.totalSingles || 0) + (state.totalSealed || 0);
      text.textContent = `${total.toLocaleString('de-DE')} Produkte aktiv`;
    } else if (state.status === 'loading') {
      text.textContent = 'Synchronisiere Katalog...';
      setTimeout(pollCatalogStatus, 2000);
    } else if (state.status === 'error') {
      text.textContent = 'Katalog-Fehler';
    }
  } catch (e) {
    // Running on GitHub Pages / Static iPhone PWA
    isStaticMode = true;
    badge.className = 'status-pill ready';
    text.textContent = profileMode === 'personal' ? 'Persönlicher Modus' : 'Cloud / iPhone Modus aktiv';
  }
}

let staticCatalogLoadingPromise = null;

// Load Static Catalog on demand when on GitHub Pages
async function ensureStaticCatalogLoaded() {
  if (staticCatalogItems) return staticCatalogItems;
  if (staticCatalogLoadingPromise) return staticCatalogLoadingPromise;
  staticCatalogLoadingPromise = (async () => {
    const res = await fetch(`./data/catalog_compact.json`);
    const data = await res.json();
    staticCatalogItems = data.items || [];
    return staticCatalogItems;
  })();
  return staticCatalogLoadingPromise;
}

// Enrich any list of items with latest daily Cardmarket prices from catalog_compact.json
async function enrichItemsWithCatalog(items) {
  if (!Array.isArray(items) || items.length === 0) return false;
  try {
    const list = await ensureStaticCatalogLoaded();
    const byId = new Map();
    for (const row of list) {
      byId.set(Number(row[0]), row);
    }
    const today = new Date().toISOString().slice(0, 10);
    let updated = false;
    for (const item of items) {
      if (!item.idProduct) continue;
      const row = byId.get(Number(item.idProduct));
      if (!row) continue;
      const [, , , , , , , dePrice, low, trend, avg30, , tcgdexId] = row;
      if (tcgdexId && !item.tcgdexId) item.tcgdexId = tcgdexId;
      item.marketPrices = {
        ...(item.marketPrices || {}),
        dePrice: dePrice ?? item.marketPrices?.dePrice ?? null,
        low: low ?? item.marketPrices?.low ?? null,
        trend: trend ?? item.marketPrices?.trend ?? null,
        avg30: avg30 ?? item.marketPrices?.avg30 ?? null,
        updatedAt: today
      };
      const eff = item.customLowPrice != null
        ? Number(item.customLowPrice)
        : (dePrice ?? trend ?? low ?? 0);
      if (eff > 0) {
        if (!Array.isArray(item.priceHistory)) item.priceHistory = [];
        const ex = item.priceHistory.find(h => h.date === today);
        if (ex) {
          ex.low = eff;
          ex.trend = trend ?? eff;
        } else {
          item.priceHistory.push({ date: today, low: eff, trend: trend ?? eff, label: 'Heute' });
        }
      }
      updated = true;
    }
    return updated;
  } catch (e) {
    return false;
  }
}

async function refreshPersonalItemsFromCatalog() {
  if (portfolioItems.length === 0) return;
  const updated = await enrichItemsWithCatalog(portfolioItems);
  if (updated) {
    saveLocalPortfolio();
    renderAll();
  }
}

// Load Portfolio (supports Owner Mode, Personal/Friends Mode, and Read-Only Viewing Friend Mode)
async function fetchPortfolio() {
  if (viewingFriend) {
    portfolioItems = Array.isArray(viewingFriend.items) ? viewingFriend.items : [];
    renderAll();
    const updated = await enrichItemsWithCatalog(portfolioItems);
    if (updated) renderAll();
    return;
  }

  if (profileMode === 'personal') {
    let personalData = null;
    try {
      const raw = localStorage.getItem(PERSONAL_PORTFOLIO_KEY);
      if (raw) personalData = JSON.parse(raw);
    } catch (e) {}
    portfolioItems = Array.isArray(personalData?.items) ? personalData.items : [];
    renderAll();
    refreshPersonalItemsFromCatalog();
    return;
  }

  try {
    const res = await fetch('/api/portfolio');
    if (!res.ok) throw new Error('Static fallback');
    const data = await res.json();
    portfolioItems = data.items || [];
    saveLocalPortfolio();
    renderAll();
    return;
  } catch (e) {
    isStaticMode = true;
  }

  // Static Mode (GitHub Pages / iPhone): Fetch latest daily-updated `./data/portfolio.json` from repo
  let remoteItems = [];
  try {
    const res = await fetch(`./data/portfolio.json?t=${Date.now()}`);
    if (res.ok) {
      const data = await res.json();
      remoteItems = data.items || [];
    }
  } catch (e) {}

  let localData = null;
  try {
    const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (raw) localData = JSON.parse(raw);
  } catch (e) {}

  if (localData && Array.isArray(localData.items) && localData.items.length > 0 && remoteItems.length === 0) {
    portfolioItems = localData.items;
  } else if (remoteItems.length > 0) {
    // Always include all items synced from PC (remoteItems) + any mobile-only items created on iPhone
    const remoteIds = new Set(remoteItems.map(i => i.id));
    const mobileOnlyItems = (localData?.items || []).filter(i => !remoteIds.has(i.id) && String(i.id).startsWith('mobile_'));
    portfolioItems = [...mobileOnlyItems, ...remoteItems];
    saveLocalPortfolio();
  } else {
    portfolioItems = [];
  }

  renderAll();
}

function renderAll() {
  renderKpis();
  renderTable();
  renderChart();
}

function renderKpis() {
  let totalValueDe = 0;
  let totalValueEuLow = 0;
  let totalInvested = 0;
  let totalQty = 0;

  let singlesQty = 0;
  let sealedQty = 0;
  let singlesVal = 0;
  let sealedVal = 0;

  for (const item of portfolioItems) {
    const qty = Number(item.quantity) || 1;
    const unitDe = getUnitDePrice(item);
    const unitEuLow = getUnitRawEuLow(item);
    const unitBuy = Number(item.buyPrice) || 0;

    const itemVal = unitDe * qty;
    totalValueDe += itemVal;
    totalValueEuLow += unitEuLow * qty;
    totalInvested += unitBuy * qty;
    totalQty += qty;

    if (item.type === 'sealed') {
      sealedQty += qty;
      sealedVal += itemVal;
    } else {
      singlesQty += qty;
      singlesVal += itemVal;
    }
  }

  const totalProfit = totalValueDe - totalInvested;
  const profitPct = totalInvested > 0 ? (totalProfit / totalInvested) * 100 : 0;

  document.getElementById('kpiTotalValue').textContent = fmtEuro(totalValueDe);
  document.getElementById('kpiTrendValue').textContent = `EU-Tiefstpreis (inkl. IT/ES): ${fmtEuro(totalValueEuLow)}`;
  document.getElementById('kpiTotalInvested').textContent = fmtEuro(totalInvested);
  document.getElementById('kpiItemCount').textContent = `${portfolioItems.length} Positionen (${totalQty} Stück)`;

  const profitEl = document.getElementById('kpiTotalProfit');
  const profitPctEl = document.getElementById('kpiTotalProfitPct');

  profitEl.textContent = fmtSignedEuro(totalProfit);
  profitPctEl.textContent = `${fmtSignedPct(profitPct)} Rendite zum Einkaufspreis`;
  profitEl.style.color = totalProfit >= 0 ? 'var(--green)' : 'var(--red)';

  document.getElementById('kpiSplitValue').textContent = `${singlesQty} Karten / ${sealedQty} Sealed`;
  document.getElementById('kpiSplitSub').textContent = `Karten: ${fmtEuro(singlesVal)} • Sealed: ${fmtEuro(sealedVal)}`;

  document.getElementById('countAll').textContent = portfolioItems.length;
  document.getElementById('countSingles').textContent = portfolioItems.filter(i => i.type !== 'sealed').length;
  document.getElementById('countSealed').textContent = portfolioItems.filter(i => i.type === 'sealed').length;
}

function renderTable() {
  const tbody = document.getElementById('portfolioTbody');
  const emptyState = document.getElementById('emptyState');
  const tableWrap = document.getElementById('portfolioTableWrap');
  const setGalleryWrap = document.getElementById('setGalleryWrap');

  if (portfolioItems.length === 0) {
    emptyState.classList.remove('hidden');
    tableWrap.classList.add('hidden');
    if (setGalleryWrap) setGalleryWrap.classList.add('hidden');
    const emptyBtn = document.getElementById('btnEmptyAdd');
    if (emptyBtn) {
      if (viewingFriend) emptyBtn.classList.add('hidden');
      else emptyBtn.classList.remove('hidden');
    }
    return;
  }
  emptyState.classList.add('hidden');

  if (viewMode === 'sets') {
    tableWrap.classList.add('hidden');
    if (setGalleryWrap) setGalleryWrap.classList.remove('hidden');
  } else {
    tableWrap.classList.remove('hidden');
    if (setGalleryWrap) setGalleryWrap.classList.add('hidden');
  }

  let filtered = portfolioItems.filter(item => {
    if (activeFilter === 'single' && item.type === 'sealed') return false;
    if (activeFilter === 'sealed' && item.type !== 'sealed') return false;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      return (
        (item.name || '').toLowerCase().includes(q) ||
        (item.displayNameDe || '').toLowerCase().includes(q) ||
        String(item.idProduct || '').includes(q) ||
        (item.expansionName || '').toLowerCase().includes(q) ||
        (item.expansionCode || '').toLowerCase().includes(q) ||
        (item.categoryName || '').toLowerCase().includes(q)
      );
    }
    return true;
  });

  const sortItemsFn = (a, b) => {
    const qtyA = Number(a.quantity) || 1;
    const qtyB = Number(b.quantity) || 1;
    const valA = getUnitDePrice(a) * qtyA;
    const valB = getUnitDePrice(b) * qtyB;
    const buyA = (Number(a.buyPrice) || 0) * qtyA;
    const buyB = (Number(b.buyPrice) || 0) * qtyB;
    const profA = valA - buyA;
    const profB = valB - buyB;
    const pctA = buyA > 0 ? (profA / buyA) * 100 : 0;
    const pctB = buyB > 0 ? (profB / buyB) * 100 : 0;

    switch (sortMode) {
      case 'profitDesc': return profB - profA;
      case 'profitPctDesc': return pctB - pctA;
      case 'valueDesc': return valB - valA;
      case 'buyDesc': return buyB - buyA;
      case 'nameAsc': return (a.displayNameDe || a.name || '').localeCompare(b.displayNameDe || b.name || '');
      case 'newest':
      default:
        return (b.createdAt || '').localeCompare(a.createdAt || '');
    }
  };

  filtered.sort(sortItemsFn);

  // Render Grouped by Set Gallery (like user's screenshot)
  if (setGalleryWrap) {
    renderSetGallery(filtered, setGalleryWrap);
  }

  tbody.innerHTML = '';

  for (const item of filtered) {
    const qty = Number(item.quantity) || 1;
    const unitBuy = Number(item.buyPrice) || 0;
    const unitDe = getUnitDePrice(item);
    const euLow = item.marketPrices?.low;
    const avg30 = item.marketPrices?.avg30 ?? item.marketPrices?.avg;

    const totalBuy = unitBuy * qty;
    const totalVal = unitDe * qty;
    const profit = totalVal - totalBuy;
    const profitPct = totalBuy > 0 ? (profit / totalBuy) * 100 : 0;

    const tr = document.createElement('tr');
    if (selectedChartItemId === item.id) {
      tr.classList.add('selected-row');
    }

    const profitClass = profit > 0.001 ? 'pos' : profit < -0.001 ? 'neg' : 'neutral';
    const effectiveImg = resolveItemImageUrl(item);
    const badgeTxt = item.expansionCode || (item.type === 'sealed' ? 'BOX' : 'TCG');
    const thumbContent = effectiveImg
      ? `<img src="${escapeHtml(effectiveImg)}" alt="" data-id="${escapeHtml(item.idProduct || '')}" data-name="${escapeHtml(item.name)}" data-type="${escapeHtml(item.type)}" data-tcgdex="${escapeHtml(item.tcgdexId || '')}" data-badge="${escapeHtml(badgeTxt)}" onerror="handleCardImageError(this)" />`
      : escapeHtml(badgeTxt);

    const displayTitle = item.displayNameDe || item.name;
    const priceSourceLabel = item.customLowPrice != null
      ? 'Eigener DE-Preis'
      : (item.type === 'sealed' ? 'CM DE-Richtwert' : 'CM DE-Kurs');

    const cmUrl = item.cardmarketUrl
      ? (item.cardmarketUrl.includes('language=') ? item.cardmarketUrl : `${item.cardmarketUrl}&language=3`)
      : '';

    tr.innerHTML = `
      <td>
        <div class="product-cell">
          <div class="product-thumb">${thumbContent}</div>
          <div>
            <div class="product-title">${escapeHtml(displayTitle)}</div>
            <div class="product-id">
              ${item.expansionName ? `${escapeHtml(item.expansionName)} • ` : ''}
              ${item.idProduct ? `#${item.idProduct}` : 'Manuell'}
            </div>
          </div>
        </div>
      </td>
      <td>
        <span class="badge ${item.type === 'sealed' ? 'badge-sealed' : 'badge-single'}">
          ${item.type === 'sealed' ? 'Sealed' : 'Karte'}
        </span>
        ${item.isHolo ? '<span class="badge">Holo</span>' : ''}
        <span class="badge badge-meta">${escapeHtml(item.condition || 'NM')} • ${escapeHtml(item.language || 'DE')}</span>
      </td>
      <td class="num">${qty}x</td>
      <td class="num">
        <div>${fmtEuro(unitBuy)}</div>
        ${qty > 1 ? `<div class="product-id">Gesamt: ${fmtEuro(totalBuy)}</div>` : ''}
      </td>
      <td class="num">
        <div style="font-weight: 600;">${fmtEuro(unitDe)}</div>
        <div class="product-id">${priceSourceLabel}</div>
      </td>
      <td class="num">
        <div class="product-id">EU-Ab: ${fmtEuro(euLow)}</div>
        <div class="product-id">Ø: ${fmtEuro(avg30)}</div>
      </td>
      <td class="num" style="font-weight: 600;">
        ${fmtEuro(totalVal)}
      </td>
      <td class="num">
        <div class="profit-pill ${profitClass}">
          <span>${fmtSignedEuro(profit)}</span>
          <span class="profit-pct">${fmtSignedPct(profitPct)}</span>
        </div>
      </td>
      <td>
        <div class="row-actions" onclick="event.stopPropagation();">
          ${viewingFriend ? '' : `<button class="action-btn" title="DE-Preis direkt anpassen" onclick="openSnapshotModal('${item.id}')">DE €</button>`}
          ${cmUrl ? `<a class="action-btn" href="${escapeHtml(cmUrl)}" target="_blank" rel="noopener" title="Auf Cardmarket (Deutsch) öffnen">CM ↗</a>` : ''}
          ${viewingFriend ? '' : `<button class="action-btn" title="Bearbeiten" onclick="openEditModal('${item.id}')">Bearbeiten</button>`}
          ${viewingFriend ? '' : `<button class="action-btn delete" title="Aus Portfolio löschen" onclick="deleteItem('${item.id}')">Löschen</button>`}
        </div>
      </td>
    `;

    tr.addEventListener('click', () => {
      selectItemForChart(item.id);
    });

    tbody.appendChild(tr);
  }
}

function selectItemForChart(itemId) {
  selectedChartItemId = selectedChartItemId === itemId ? null : itemId;
  renderTable();
  renderChart();
}

function toggleSetCollapse(setKey) {
  if (collapsedSets.has(setKey)) {
    collapsedSets.delete(setKey);
  } else {
    collapsedSets.add(setKey);
  }
  renderTable();
}

function renderSetGallery(items, container) {
  container.innerHTML = '';
  if (items.length === 0) {
    container.innerHTML = `<div class="search-hint">Keine passenden Einträge gefunden.</div>`;
    return;
  }

  // Group items by expansionName
  const groupsMap = new Map();
  for (const item of items) {
    const setName = item.expansionName || (item.type === 'sealed' ? 'Sealed & Boxen' : 'Weitere Einzelkarten');
    const setCode = item.expansionCode || (item.type === 'sealed' ? 'BOX' : 'SET');
    if (!groupsMap.has(setName)) {
      groupsMap.set(setName, {
        name: setName,
        code: setCode,
        items: [],
        totalVal: 0,
        totalBuy: 0,
        totalQty: 0
      });
    }
    const g = groupsMap.get(setName);
    if (!g.code || g.code === 'SET' || g.code === 'BOX') {
      if (item.expansionCode) g.code = item.expansionCode;
    }
    const qty = Number(item.quantity) || 1;
    const uDe = getUnitDePrice(item);
    const uBuy = Number(item.buyPrice) || 0;
    g.items.push(item);
    g.totalVal += uDe * qty;
    g.totalBuy += uBuy * qty;
    g.totalQty += qty;
  }

  // Sort sets by total value descending
  const groups = Array.from(groupsMap.values()).sort((a, b) => b.totalVal - a.totalVal);

  for (const g of groups) {
    const setProfit = g.totalVal - g.totalBuy;
    const profitColor = setProfit >= 0 ? 'var(--green)' : 'var(--red)';
    const isCollapsed = collapsedSets.has(g.name);

    const groupEl = document.createElement('div');
    groupEl.className = `set-group${isCollapsed ? ' collapsed' : ''}`;

    const headerEl = document.createElement('div');
    headerEl.className = 'set-group-header';
    headerEl.innerHTML = `
      <div class="set-group-left">
        <span class="set-code-badge">${escapeHtml(g.code.slice(0, 4))}</span>
        <div>
          <span class="set-group-title">${escapeHtml(g.name)}</span>
          <span class="set-group-count">(${g.totalQty}x)</span>
        </div>
      </div>
      <div class="set-group-right">
        <span>${fmtEuro(g.totalVal)}</span>
        <span style="color:${profitColor}; font-weight:600;">${fmtSignedEuro(setProfit)}</span>
        <span class="set-group-chevron">⌄</span>
      </div>
    `;
    headerEl.addEventListener('click', () => toggleSetCollapse(g.name));

    const gridEl = document.createElement('div');
    gridEl.className = 'set-cards-grid';

    for (const item of g.items) {
      const qty = Number(item.quantity) || 1;
      const uDe = getUnitDePrice(item);
      const uBuy = Number(item.buyPrice) || 0;
      const totVal = uDe * qty;
      const totBuy = uBuy * qty;
      const prof = totVal - totBuy;
      const profClass = prof > 0.001 ? 'pos' : prof < -0.001 ? 'neg' : 'neutral';

      const effectiveImg = resolveItemImageUrl(item);
      const displayTitle = (item.displayNameDe || item.name).replace(/\[.*?\]/g, '').trim();
      const cardBadgeTxt = item.expansionCode || (item.type === 'sealed' ? 'BOX' : 'TCG');

      const cardEl = document.createElement('div');
      cardEl.className = `gallery-card${selectedChartItemId === item.id ? ' selected-card' : ''}`;

      cardEl.innerHTML = `
        <div class="gallery-card-visual">
          ${qty > 1 ? `<span class="gallery-qty-badge">${qty}x</span>` : ''}
          ${effectiveImg ? `<img src="${escapeHtml(effectiveImg)}" loading="lazy" alt="" data-id="${escapeHtml(item.idProduct || '')}" data-name="${escapeHtml(item.name)}" data-type="${escapeHtml(item.type)}" data-tcgdex="${escapeHtml(item.tcgdexId || '')}" data-badge="${escapeHtml(cardBadgeTxt)}" onerror="handleCardImageError(this)" />` : `<span>${escapeHtml(cardBadgeTxt)}</span>`}
          <span class="gallery-price-pill">${fmtEuro(uDe)}</span>
        </div>
        <div class="gallery-card-footer">
          <div class="gallery-card-title" title="${escapeHtml(item.displayNameDe || item.name)}">${escapeHtml(displayTitle)}</div>
          <div class="gallery-card-profit-row">
            <span class="gallery-buy-txt">EK: ${fmtEuro(uBuy)}</span>
            <span class="gallery-profit-txt ${profClass}">${fmtSignedEuro(prof)}</span>
          </div>
          ${viewingFriend ? '' : `<div class="gallery-card-actions" onclick="event.stopPropagation();">
            <button class="action-btn" onclick="openSnapshotModal('${item.id}')">DE €</button>
            <button class="action-btn" onclick="openEditModal('${item.id}')">Edit</button>
            <button class="action-btn delete" onclick="deleteItem('${item.id}')">✕</button>
          </div>`}
        </div>
      `;

      cardEl.addEventListener('click', () => {
        selectItemForChart(item.id);
        document.querySelector('.chart-section')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });

      gridEl.appendChild(cardEl);
    }

    groupEl.appendChild(headerEl);
    groupEl.appendChild(gridEl);
    container.appendChild(groupEl);
  }
}

function renderChart() {
  const ctx = document.getElementById('priceChart').getContext('2d');
  const titleEl = document.getElementById('chartTitle');
  const subtitleEl = document.getElementById('chartSubtitle');
  const resetBtn = document.getElementById('btnResetChartFilter');

  let itemsToPlot = portfolioItems;
  if (selectedChartItemId) {
    const found = portfolioItems.find(i => i.id === selectedChartItemId);
    if (found) {
      itemsToPlot = [found];
      titleEl.textContent = `${found.displayNameDe || found.name} (${found.quantity}x)`;
      subtitleEl.textContent = `Aktueller DE-Marktpreis: ${fmtEuro(getUnitDePrice(found))} • Einkaufspreis: ${fmtEuro(found.buyPrice)}`;
      resetBtn.classList.remove('hidden');
    } else {
      selectedChartItemId = null;
      resetBtn.classList.add('hidden');
    }
  } else {
    titleEl.textContent = 'Wertentwicklung vs. Einkaufspreis (Gesamt-Portfolio)';
    subtitleEl.textContent = 'Klicke unten in der Liste auf eine Position, um den Einzelverlauf anzuzeigen';
    resetBtn.classList.add('hidden');
  }

  const dateSet = new Set();
  const today = new Date().toISOString().slice(0, 10);
  dateSet.add(today);

  for (const item of itemsToPlot) {
    for (const pt of (item.priceHistory || [])) {
      if (pt.date) dateSet.add(pt.date);
    }
  }

  const sortedDates = Array.from(dateSet).sort();
  const valSeries = [];
  const buySeries = [];

  for (const d of sortedDates) {
    let sumVal = 0;
    let sumBuy = 0;

    for (const item of itemsToPlot) {
      const qty = Number(item.quantity) || 1;
      const buyUnit = Number(item.buyPrice) || 0;
      sumBuy += buyUnit * qty;

      const hist = item.priceHistory || [];
      let chosenPt = null;
      for (const h of hist) {
        if (h.date <= d) chosenPt = h;
      }
      if (!chosenPt && hist.length > 0) chosenPt = hist[0];

      let unitVal;
      if (d === today) {
        unitVal = getUnitDePrice(item);
      } else if (chosenPt) {
        unitVal = (item.type === 'sealed' && item.customLowPrice == null && chosenPt.trend)
          ? Number(chosenPt.trend)
          : Number(chosenPt.low);
      } else {
        unitVal = getUnitDePrice(item);
      }

      sumVal += unitVal * qty;
    }

    valSeries.push(Number(sumVal.toFixed(2)));
    buySeries.push(Number(sumBuy.toFixed(2)));
  }

  const labels = sortedDates.map(d => {
    const parts = d.split('-');
    return parts.length === 3 ? `${parts[2]}.${parts[1]}.${parts[0].slice(2)}` : d;
  });

  if (priceChartInstance) {
    priceChartInstance.destroy();
  }

  const gradientVal = ctx.createLinearGradient(0, 0, 0, 260);
  gradientVal.addColorStop(0, 'rgba(59, 130, 246, 0.22)');
  gradientVal.addColorStop(1, 'rgba(59, 130, 246, 0.0)');

  priceChartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'DE Marktpreis',
          data: valSeries,
          borderColor: '#3b82f6',
          backgroundColor: gradientVal,
          borderWidth: 2,
          pointBackgroundColor: '#3b82f6',
          pointRadius: 3,
          pointHoverRadius: 5,
          tension: 0.25,
          fill: true
        },
        {
          label: 'Einkaufspreis',
          data: buySeries,
          borderColor: '#71717a',
          borderWidth: 1.5,
          borderDash: [5, 5],
          pointRadius: 0,
          tension: 0,
          fill: false
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: 'index',
        intersect: false
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#121215',
          borderColor: '#27272a',
          borderWidth: 1,
          padding: 10,
          titleColor: '#f4f4f5',
          bodyColor: '#d4d4d8',
          callbacks: {
            label: function(context) {
              return `${context.dataset.label}: ${fmtEuro(context.parsed.y)}`;
            },
            afterBody: function(tooltipItems) {
              const idx = tooltipItems[0].dataIndex;
              const v = valSeries[idx] || 0;
              const b = buySeries[idx] || 0;
              const diff = v - b;
              const pct = b > 0 ? (diff / b) * 100 : 0;
              return `\nErgebnis: ${fmtSignedEuro(diff)} (${fmtSignedPct(pct)})`;
            }
          }
        }
      },
      scales: {
        x: {
          grid: { color: 'rgba(255, 255, 255, 0.04)' },
          ticks: { color: '#71717a', font: { size: 11 } }
        },
        y: {
          grid: { color: 'rgba(255, 255, 255, 0.04)' },
          ticks: {
            color: '#71717a',
            font: { size: 11 },
            callback: function(value) { return value + ' €'; }
          }
        }
      }
    }
  });
}

// Search in Static Compact Catalog (when running on GitHub Pages / iPhone)
async function searchStaticCatalogClient(q, typeFilter) {
  const list = await ensureStaticCatalogLoaded();
  const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
  const results = [];

  for (let i = 0; i < list.length; i++) {
    const row = list[i];
    // [idProduct, name, displayNameDe, type('s'|'c'), categoryName, expansionName, expansionCode, dePrice, low, trend, avg30, idCategory, tcgdexId]
    const [idProduct, name, displayNameDe, shortType, categoryName, expansionName, expansionCode, dePrice, low, trend, avg30, idCategory, tcgdexId] = row;
    const itemType = shortType === 's' ? 'sealed' : 'single';
    if (typeFilter === 'single' && itemType !== 'single') continue;
    if (typeFilter === 'sealed' && itemType !== 'sealed') continue;

    let extra = '';
    if (idCategory === 1016) extra = 'ttb etb top trainer box';
    else if (idCategory === 53) extra = 'display booster box';

    const hay = `${name} ${displayNameDe} ${expansionName} ${expansionCode} ${idProduct} ${extra}`.toLowerCase();
    let match = true;
    for (let t = 0; t < tokens.length; t++) {
      if (!hay.includes(tokens[t])) {
        match = false;
        break;
      }
    }
    if (!match) continue;

    results.push({
      idProduct,
      name,
      displayNameDe: displayNameDe || name,
      type: itemType,
      categoryName,
      expansionName,
      expansionCode,
      tcgdexId: tcgdexId || '',
      imageUrl: `./images/${idProduct}.jpg`,
      cardmarketUrl: `https://www.cardmarket.com/de/Pokemon/Products/Search?searchString=${encodeURIComponent(name)}&language=3`,
      prices: { dePrice, low, trend, avg30 }
    });

    if (results.length >= 60) break;
  }
  return results;
}

// Catalog Search in Wide Modal
async function performCatalogSearch() {
  const input = document.getElementById('catalogSearchInput');
  const container = document.getElementById('catalogSearchResults');
  const q = input.value.trim();

  if (q.length < 2) {
    container.innerHTML = `<div class="search-hint">Gib oben mindestens 2 Buchstaben ein (z.B. „Glurak“, „Quajutsu“, „151 TTB“, „Ewige Rivalen“).</div>`;
    return;
  }

  container.innerHTML = `<div class="search-hint">Suche nach „${escapeHtml(q)}“...</div>`;

  try {
    let items = [];
    if (!isStaticMode) {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}&type=${encodeURIComponent(catalogSearchType)}`);
      const data = await res.json();
      if (data.status !== 'ready') {
        container.innerHTML = `<div class="search-hint">Der Cardmarket-Katalog wird gerade noch geladen...</div>`;
        return;
      }
      items = data.results || [];
    } else {
      items = await searchStaticCatalogClient(q, catalogSearchType);
    }

    if (items.length === 0) {
      container.innerHTML = `<div class="search-hint">Keine Treffer gefunden. Du kannst das Produkt rechts auch direkt manuell eintragen.</div>`;
      return;
    }

    container.innerHTML = '';
    for (const prod of items) {
      const div = document.createElement('div');
      div.className = 'catalog-item';

      const dePriceTxt = prod.prices?.dePrice != null ? fmtEuro(prod.prices.dePrice) : '—';
      const euLowTxt = prod.prices?.low != null ? fmtEuro(prod.prices.low) : '—';
      const imgUrl = prod.imageUrl || (isStaticMode ? `./images/${prod.idProduct}.jpg` : `/api/cm-image/${prod.idProduct}`);
      const setLabel = prod.expansionName ? `${escapeHtml(prod.expansionName)} • ` : '';
      const mainTitle = prod.displayNameDe || prod.name;
      const showOriginalSub = prod.displayNameDe && prod.displayNameDe !== prod.name;

      const setBadgeTxt = prod.expansionCode || (prod.type === 'sealed' ? 'BOX' : 'TCG');
      div.innerHTML = `
        <div class="catalog-thumb">
          <img src="${escapeHtml(imgUrl)}" loading="lazy" alt="" data-id="${escapeHtml(prod.idProduct)}" data-name="${escapeHtml(prod.name)}" data-type="${escapeHtml(prod.type)}" data-tcgdex="${escapeHtml(prod.tcgdexId || '')}" data-badge="${escapeHtml(setBadgeTxt)}" onerror="handleCardImageError(this)" />
        </div>
        <div class="catalog-item-info">
          <div class="catalog-item-name">${escapeHtml(mainTitle)}</div>
          ${showOriginalSub ? `<div class="catalog-item-subname">${escapeHtml(prod.name)}</div>` : ''}
          <div class="catalog-item-meta">${setLabel}${escapeHtml(prod.categoryName)} (#${prod.idProduct})</div>
          <div class="catalog-item-price-row">
            <span class="cm-de-tag">DE: ${dePriceTxt}</span>
            <span class="cm-eu-tag">(EU-Low: ${euLowTxt})</span>
          </div>
        </div>
      `;

      div.addEventListener('click', () => {
        document.querySelectorAll('.catalog-item.active-selection').forEach(el => el.classList.remove('active-selection'));
        div.classList.add('active-selection');
        selectCatalogProduct(prod);
      });
      container.appendChild(div);
    }
  } catch (err) {
    container.innerHTML = `<div class="search-hint">Fehler bei der Suche: ${escapeHtml(err.message)}</div>`;
  }
}

let lastSelectedCatalogProd = null;

function selectCatalogProduct(prod) {
  lastSelectedCatalogProd = prod;
  const imgUrl = prod.imageUrl || (isStaticMode ? `./images/${prod.idProduct}.jpg` : `/api/cm-image/${prod.idProduct}`);
  const mainTitle = prod.displayNameDe || prod.name;

  document.getElementById('formIdProduct').value = prod.idProduct;
  document.getElementById('formName').value = mainTitle;
  document.getElementById('formType').value = prod.type;
  document.getElementById('formImageUrl').value = imgUrl;
  document.getElementById('formCardmarketUrl').value = prod.cardmarketUrl || '';

  const badge = document.getElementById('selectedCategoryBadge');
  const nameEl = document.getElementById('selectedProductName');
  const pricesEl = document.getElementById('selectedCmPrices');
  const thumbEl = document.getElementById('selectedBannerThumb');
  const cmLink = document.getElementById('selectedDirectCmLink');
  const setBadgeTxt = prod.expansionCode || (prod.type === 'sealed' ? 'BOX' : 'TCG');

  thumbEl.innerHTML = `<img src="${escapeHtml(imgUrl)}" alt="" data-id="${escapeHtml(prod.idProduct)}" data-name="${escapeHtml(prod.name)}" data-type="${escapeHtml(prod.type)}" data-tcgdex="${escapeHtml(prod.tcgdexId || '')}" data-badge="${escapeHtml(setBadgeTxt)}" onerror="handleCardImageError(this)" />`;
  badge.textContent = `${prod.type === 'sealed' ? 'Sealed' : 'Einzelkarte'} #${prod.idProduct}${prod.expansionName ? ' • ' + prod.expansionName : ''}`;
  nameEl.textContent = mainTitle;
  pricesEl.innerHTML = `DE-Richtwert: <strong style="color:var(--text-main)">${fmtEuro(prod.prices?.dePrice)}</strong> • EU-Low (inkl. IT/ES): ${fmtEuro(prod.prices?.low)}`;

  if (prod.cardmarketUrl) {
    cmLink.href = prod.cardmarketUrl;
    cmLink.classList.remove('hidden');
  } else {
    cmLink.classList.add('hidden');
  }

  document.getElementById('formBuyPrice').focus();
  if (window.innerWidth <= 920) {
    document.querySelector('.catalog-form-pane')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function openAddModal() {
  lastSelectedCatalogProd = null;
  if (isStaticMode) {
    ensureStaticCatalogLoaded().catch(() => {});
  }
  document.getElementById('modalTitle').textContent = 'Produkt suchen & hinzufügen';
  document.getElementById('btnSaveItem').textContent = 'Zum Portfolio hinzufügen';
  document.getElementById('catalogSearchSection').classList.remove('hidden');
  document.querySelector('.modal-split-body').classList.remove('edit-only');
  document.querySelector('.modal').classList.add('modal-wide');

  document.getElementById('formEditId').value = '';
  document.getElementById('formIdProduct').value = '';
  document.getElementById('formName').value = '';
  document.getElementById('formType').value = 'single';
  document.getElementById('formIsHolo').value = 'false';
  document.getElementById('formBuyPrice').value = '';
  document.getElementById('formQuantity').value = '1';
  document.getElementById('formCondition').value = 'NM';
  document.getElementById('formLanguage').value = 'DE';
  document.getElementById('formBuyDate').value = new Date().toISOString().slice(0, 10);
  document.getElementById('formCustomLowPrice').value = '';
  document.getElementById('formImageUrl').value = '';
  document.getElementById('formCardmarketUrl').value = '';

  document.getElementById('selectedBannerThumb').innerHTML = 'CM';
  document.getElementById('selectedCategoryBadge').textContent = 'Auswahl';
  document.getElementById('selectedProductName').textContent = 'Links ein Produkt anklicken';
  document.getElementById('selectedCmPrices').textContent = '';
  document.getElementById('selectedDirectCmLink').classList.add('hidden');
  document.getElementById('btnDeleteInModal').classList.add('hidden');

  document.getElementById('addModal').classList.remove('hidden');
  document.getElementById('catalogSearchInput').focus();
}

function openEditModal(itemId) {
  const item = portfolioItems.find(i => i.id === itemId);
  if (!item) return;

  document.getElementById('modalTitle').textContent = 'Eintrag bearbeiten';
  document.getElementById('btnSaveItem').textContent = 'Änderungen speichern';
  document.getElementById('catalogSearchSection').classList.add('hidden');
  document.querySelector('.modal-split-body').classList.add('edit-only');
  document.querySelector('.modal').classList.remove('modal-wide');

  document.getElementById('formEditId').value = item.id;
  document.getElementById('formIdProduct').value = item.idProduct || '';
  document.getElementById('formName').value = item.displayNameDe || item.name || '';
  document.getElementById('formType').value = item.type || 'single';
  document.getElementById('formIsHolo').value = item.isHolo ? 'true' : 'false';
  document.getElementById('formBuyPrice').value = item.buyPrice ?? 0;
  document.getElementById('formQuantity').value = item.quantity ?? 1;
  document.getElementById('formCondition').value = item.condition || 'NM';
  document.getElementById('formLanguage').value = item.language || 'DE';
  document.getElementById('formBuyDate').value = item.buyDate || '';
  document.getElementById('formCustomLowPrice').value = item.customLowPrice != null ? item.customLowPrice : '';
  document.getElementById('formImageUrl').value = item.imageUrl || '';
  document.getElementById('formCardmarketUrl').value = item.cardmarketUrl || '';

  const editImg = resolveItemImageUrl(item);
  document.getElementById('selectedBannerThumb').innerHTML = editImg
    ? `<img src="${escapeHtml(editImg)}" alt="" onerror="this.parentElement.textContent='${item.type === 'sealed' ? 'BOX' : 'TCG'}'" />`
    : (item.type === 'sealed' ? 'BOX' : 'TCG');
  document.getElementById('selectedCategoryBadge').textContent = item.idProduct ? `Cardmarket #${item.idProduct}` : 'Manuell';
  document.getElementById('selectedProductName').textContent = item.displayNameDe || item.name;
  document.getElementById('selectedCmPrices').textContent = `DE-Richtwert: ${fmtEuro(item.marketPrices?.dePrice ?? item.marketPrices?.trend)} • EU-Low: ${fmtEuro(item.marketPrices?.low)}`;

  const cmLink = document.getElementById('selectedDirectCmLink');
  if (item.cardmarketUrl) {
    cmLink.href = item.cardmarketUrl.includes('language=') ? item.cardmarketUrl : `${item.cardmarketUrl}&language=3`;
    cmLink.classList.remove('hidden');
  } else {
    cmLink.classList.add('hidden');
  }

  const delBtn = document.getElementById('btnDeleteInModal');
  delBtn.classList.remove('hidden');
  delBtn.onclick = async () => {
    closeAddModal();
    await deleteItem(item.id);
  };

  document.getElementById('addModal').classList.remove('hidden');
}

function closeAddModal() {
  document.getElementById('addModal').classList.add('hidden');
}

function openSnapshotModal(itemId) {
  const item = portfolioItems.find(i => i.id === itemId);
  if (!item) return;
  document.getElementById('snapshotItemId').value = item.id;
  document.getElementById('snapshotItemName').textContent = item.displayNameDe || item.name;
  document.getElementById('snapshotPrice').value = getUnitDePrice(item);
  document.getElementById('snapshotDate').value = new Date().toISOString().slice(0, 10);
  document.getElementById('snapshotModal').classList.remove('hidden');
  document.getElementById('snapshotPrice').focus();
}

function closeSnapshotModal() {
  document.getElementById('snapshotModal').classList.add('hidden');
}

async function deleteItem(itemId) {
  const item = portfolioItems.find(i => i.id === itemId);
  if (!item) return;
  if (!confirm(`Möchtest du „${item.displayNameDe || item.name}“ wirklich entfernen?`)) return;

  if (!isStaticMode && profileMode === 'owner') {
    await fetch(`/api/portfolio/${itemId}`, { method: 'DELETE' });
    if (selectedChartItemId === itemId) selectedChartItemId = null;
    await fetchPortfolio();
  } else {
    portfolioItems = portfolioItems.filter(i => i.id !== itemId);
    if (selectedChartItemId === itemId) selectedChartItemId = null;
    saveLocalPortfolio();
    renderAll();
  }
}

function openProfileModal(isFirstFriendPrompt = false) {
  const modal = document.getElementById('profileModal');
  const titleEl = document.getElementById('profileModalTitle');
  const subEl = document.getElementById('profileModalSub');
  const nameInput = document.getElementById('profileNameInput');
  const switchOwnerBtn = document.getElementById('btnSwitchToOwner');
  const saveBtn = document.getElementById('btnSaveProfile');

  nameInput.value = profileName || '';

  if (isFirstFriendPrompt || profileMode !== 'personal') {
    titleEl.textContent = 'Eigenes Portfolio starten';
    subEl.textContent = 'Gib deinen Namen ein – deine Karten und Preise werden sicher gespeichert';
    saveBtn.textContent = 'Mein Portfolio starten';
  } else {
    titleEl.textContent = 'Name ändern';
    subEl.textContent = 'Passe deinen Anzeigenamen für deine Sammlung an';
    saveBtn.textContent = 'Namen speichern';
  }

  // Only show "Geteilte Sammlung" switch back to owner if user is Admin
  if (profileMode === 'personal' && isAdminMode) {
    switchOwnerBtn.classList.remove('hidden');
  } else {
    switchOwnerBtn.classList.add('hidden');
  }

  modal.classList.remove('hidden');
  setTimeout(() => nameInput.focus(), 60);
}

function closeProfileModal() {
  document.getElementById('profileModal').classList.add('hidden');
}

function openAdminLoginModal() {
  const modal = document.getElementById('adminLoginModal');
  const errEl = document.getElementById('adminLoginError');
  const emailEl = document.getElementById('adminEmailInput');
  const pwEl = document.getElementById('adminPasswordInput');
  errEl.classList.add('hidden');
  errEl.textContent = '';
  const sess = getAdminSession();
  if (sess?.email) emailEl.value = sess.email;
  pwEl.value = '';
  modal.classList.remove('hidden');
  setTimeout(() => (emailEl.value ? pwEl.focus() : emailEl.focus()), 60);
}

function closeAdminLoginModal() {
  document.getElementById('adminLoginModal').classList.add('hidden');
}

async function openFriendsModal() {
  if (!isAdminMode) return;

  const token = await getValidAdminAccessToken();
  if (!token) {
    openAdminLoginModal();
    return;
  }

  const modal = document.getElementById('friendsModal');
  const container = document.getElementById('friendsListContainer');
  modal.classList.remove('hidden');
  container.innerHTML = `<div class="search-hint">Lade Freunde-Sammlungen aus der Cloud...</div>`;

  try {
    const res = await fetch(`${SUPABASE_REST_URL}/portfolios?select=id,owner_name,items,updated_at&order=updated_at.desc`, {
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${token}`
      }
    });
    if (res.status === 401 || res.status === 403) {
      clearAdminSession();
      closeFriendsModal();
      openAdminLoginModal();
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const friends = await res.json();

    if (!Array.isArray(friends) || friends.length === 0) {
      container.innerHTML = `<div class="search-hint">Noch keine Freunde eingetragen. Schick deinen Freunden den Freunde-Link, dann erscheinen sie hier automatisch!</div>`;
      return;
    }

    // Enrich all friends' items with today's Cardmarket catalog prices
    for (const f of friends) {
      if (Array.isArray(f.items) && f.items.length > 0) {
        await enrichItemsWithCatalog(f.items);
      }
    }

    container.innerHTML = '';
    for (const f of friends) {
      const fItems = Array.isArray(f.items) ? f.items : [];
      let totalVal = 0;
      let totalBuy = 0;
      let totalQty = 0;
      for (const it of fItems) {
        const qty = Number(it.quantity) || 1;
        totalVal += getUnitDePrice(it) * qty;
        totalBuy += (Number(it.buyPrice) || 0) * qty;
        totalQty += qty;
      }
      const profit = totalVal - totalBuy;
      const profColor = profit >= 0 ? 'var(--green)' : 'var(--red)';
      const upd = f.updated_at ? new Date(f.updated_at).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';

      const row = document.createElement('div');
      row.className = 'friend-row';
      row.innerHTML = `
        <div class="friend-row-left">
          <div class="friend-avatar">${escapeHtml((f.owner_name || 'F').slice(0, 2).toUpperCase())}</div>
          <div>
            <div class="friend-name">${escapeHtml(f.owner_name || 'Unbekannt')}</div>
            <div class="friend-meta">${fItems.length} Positionen (${totalQty} Stück)${upd ? ` • Stand: ${upd}` : ''}</div>
          </div>
        </div>
        <div class="friend-row-right">
          <div>
            <div class="friend-val">${fmtEuro(totalVal)}</div>
            <div class="friend-profit" style="color:${profColor};">${fmtSignedEuro(profit)}</div>
          </div>
          <button type="button" class="action-btn delete" title="Diesen Freund / Testkonto löschen">Löschen</button>
        </div>
      `;
      row.querySelector('.action-btn.delete').addEventListener('click', e => {
        e.stopPropagation();
        deleteFriendFromCloud(f.id, f.owner_name || 'Unbekannt');
      });
      row.addEventListener('click', () => {
        closeFriendsModal();
        enterFriendView(f);
      });
      container.appendChild(row);
    }
  } catch (err) {
    container.innerHTML = `<div class="search-hint">Fehler beim Laden: ${escapeHtml(err.message)}</div>`;
  }
}

async function deleteFriendFromCloud(friendId, friendName) {
  if (!isAdminMode) return;
  const token = await getValidAdminAccessToken();
  if (!token) {
    closeFriendsModal();
    openAdminLoginModal();
    return;
  }
  if (!confirm(`Möchtest du das Konto „${friendName}“ wirklich komplett löschen?`)) return;

  try {
    const res = await fetch(`${SUPABASE_REST_URL}/portfolios?id=eq.${encodeURIComponent(friendId)}`, {
      method: 'DELETE',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${token}`,
        'Prefer': 'return=representation'
      }
    });
    if (res.status === 401 || res.status === 403) {
      clearAdminSession();
      closeFriendsModal();
      openAdminLoginModal();
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const deleted = await res.json();
    if (!Array.isArray(deleted) || deleted.length === 0) {
      alert('Löschen wurde von Supabase blockiert. Prüfe, ob die Admin-Delete-Regel gesetzt ist.');
      return;
    }
    if (viewingFriend && viewingFriend.id === friendId) {
      exitFriendView();
    }
    showToast(`„${friendName}“ gelöscht.`);
    openFriendsModal();
  } catch (err) {
    alert('Fehler beim Löschen: ' + err.message);
  }
}

function closeFriendsModal() {
  document.getElementById('friendsModal').classList.add('hidden');
}

function enterFriendView(friendRecord) {
  viewingFriend = friendRecord;
  selectedChartItemId = null;
  updateProfileHeader();
  fetchPortfolio();
}

function exitFriendView() {
  viewingFriend = null;
  selectedChartItemId = null;
  updateProfileHeader();
  fetchPortfolio();
}

async function shareFriendLink() {
  const url = getFriendShareUrl();
  try {
    if (navigator.share) {
      await navigator.share({
        title: 'Pokémon Portfolio Tracker',
        text: 'Leg dir hier dein eigenes Pokémon-Karten & Sealed-Portfolio an (mit täglichen Cardmarket-Preisen):',
        url
      });
      return;
    }
  } catch (e) {}
  try {
    await navigator.clipboard.writeText(url);
    showToast('Freunde-Link kopiert! Einfach per WhatsApp / Nachricht teilen.');
  } catch (e) {
    prompt('Kopiere diesen Link für deine Freunde:', url);
  }
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

document.addEventListener('DOMContentLoaded', () => {
  initProfileState();
  pollCatalogStatus();
  fetchPortfolio();

  // Secret 5-tap on CM logo to unlock Admin/Freunde button inside iPhone Home-Screen PWA
  let brandTapCount = 0;
  let brandTapTimer = null;
  const brandMarkEl = document.getElementById('brandMark');
  if (brandMarkEl) {
    brandMarkEl.style.cursor = 'pointer';
    brandMarkEl.addEventListener('click', () => {
      brandTapCount++;
      clearTimeout(brandTapTimer);
      brandTapTimer = setTimeout(() => { brandTapCount = 0; }, 1600);
      if (brandTapCount >= 5) {
        brandTapCount = 0;
        isAdminMode = true;
        localStorage.setItem(ADMIN_FLAG_KEY, '1');
        updateProfileHeader();
        openFriendsModal();
      }
    });
  }

  document.getElementById('btnOpenAddModal').addEventListener('click', openAddModal);
  document.getElementById('btnEmptyAdd').addEventListener('click', openAddModal);
  document.getElementById('btnCloseModal').addEventListener('click', closeAddModal);
  document.getElementById('btnCancelModal').addEventListener('click', closeAddModal);

  document.getElementById('btnCloseSnapshotModal').addEventListener('click', closeSnapshotModal);
  document.getElementById('btnCancelSnapshot').addEventListener('click', closeSnapshotModal);

  // Friends Admin Viewer & Secure Login listeners
  document.getElementById('btnOpenFriendsModal').addEventListener('click', openFriendsModal);
  document.getElementById('btnCloseFriendsModal').addEventListener('click', closeFriendsModal);
  document.getElementById('btnCloseFriendsBtn').addEventListener('click', closeFriendsModal);
  document.getElementById('btnCopyFriendInviteFromModal').addEventListener('click', shareFriendLink);
  document.getElementById('btnExitFriendView').addEventListener('click', exitFriendView);
  document.getElementById('btnSwitchAnotherFriend').addEventListener('click', openFriendsModal);

  document.getElementById('btnCloseAdminLogin').addEventListener('click', closeAdminLoginModal);
  document.getElementById('btnCancelAdminLogin').addEventListener('click', closeAdminLoginModal);
  document.getElementById('btnAdminLogout').addEventListener('click', () => {
    clearAdminSession();
    closeFriendsModal();
    if (viewingFriend) exitFriendView();
    showToast('Admin abgemeldet.');
  });

  document.getElementById('adminLoginForm').addEventListener('submit', async e => {
    e.preventDefault();
    const email = document.getElementById('adminEmailInput').value.trim();
    const pw = document.getElementById('adminPasswordInput').value;
    const errEl = document.getElementById('adminLoginError');
    const submitBtn = document.getElementById('btnSubmitAdminLogin');

    errEl.classList.add('hidden');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Prüfe...';

    try {
      await adminSignIn(email, pw);
      closeAdminLoginModal();
      showToast('Erfolgreich angemeldet.');
      openFriendsModal();
    } catch (err) {
      errEl.textContent = err.message || 'Anmeldung fehlgeschlagen.';
      errEl.classList.remove('hidden');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Anmelden';
    }
  });

  // Friends / Profile Modal listeners
  document.getElementById('btnShareFriendLink').addEventListener('click', shareFriendLink);
  document.getElementById('btnOpenProfileModal').addEventListener('click', () => openProfileModal(false));
  document.getElementById('profileBadgeBtn').addEventListener('click', () => {
    if (!viewingFriend) openProfileModal(false);
  });
  document.getElementById('btnCloseProfileModal').addEventListener('click', closeProfileModal);
  document.getElementById('btnCancelProfile').addEventListener('click', closeProfileModal);

  document.getElementById('btnSwitchToOwner').addEventListener('click', () => {
    profileMode = 'owner';
    localStorage.setItem(PROFILE_MODE_KEY, 'owner');
    selectedChartItemId = null;
    closeProfileModal();
    updateProfileHeader();
    fetchPortfolio();
    showToast('Geteilte Hauptsammlung geladen.');
  });

  document.getElementById('profileForm').addEventListener('submit', async e => {
    e.preventDefault();
    const enteredName = document.getElementById('profileNameInput').value.trim();
    if (!enteredName) return;

    const wasOwner = profileMode !== 'personal';
    profileName = enteredName;
    profileMode = 'personal';
    localStorage.setItem(PROFILE_NAME_KEY, profileName);
    localStorage.setItem(PROFILE_MODE_KEY, 'personal');

    selectedChartItemId = null;
    closeProfileModal();
    updateProfileHeader();
    await fetchPortfolio();
    // Immediately register/update profile in Supabase cloud
    await syncPersonalPortfolioToSupabase();
    showToast(wasOwner ? `Willkommen, ${profileName}! Dein Portfolio ist bereit.` : `Profilname auf „${profileName}“ aktualisiert.`);
  });

  // Export Backup (for Google Drive / iCloud / GitHub)
  document.getElementById('btnExportBackup').addEventListener('click', () => {
    const safeName = profileName ? `-${profileName.toLowerCase().replace(/[^a-z0-9]/g, '')}` : '';
    const blob = new Blob([JSON.stringify({ ownerName: profileName || 'Standard', items: portfolioItems }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `portfolio${safeName}.json`;
    a.click();
  });

  // Import Backup
  document.getElementById('inputImportBackup').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed.items)) {
        portfolioItems = parsed.items;
        saveLocalPortfolio();
        renderAll();
        showToast(`${portfolioItems.length} Einträge erfolgreich geladen!`);
      }
    } catch (err) {
      alert('Ungültige Portfolio-Datei.');
    }
    e.target.value = '';
  });

  document.getElementById('btnResetChartFilter').addEventListener('click', () => {
    selectedChartItemId = null;
    renderTable();
    renderChart();
  });

  document.getElementById('btnRefreshCatalog').addEventListener('click', async () => {
    const badge = document.getElementById('catalogStatusBadge');
    const text = document.getElementById('catalogStatusText');
    badge.className = 'status-pill loading';
    text.textContent = 'Aktualisiere...';

    if (!isStaticMode && profileMode === 'owner') {
      await fetch('/api/refresh-catalog', { method: 'POST' });
      setTimeout(async () => {
        await pollCatalogStatus();
        await fetchPortfolio();
      }, 1500);
    } else if (profileMode === 'personal') {
      staticCatalogItems = null;
      staticCatalogLoadingPromise = null;
      await refreshPersonalItemsFromCatalog();
      badge.className = 'status-pill ready';
      text.textContent = 'Preise synchronisiert';
      showToast('Cardmarket-Preise aktualisiert.');
    } else {
      window.location.href = window.location.pathname + '?v=' + Date.now();
    }
  });

  document.querySelectorAll('.tabs .tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tabs .tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeFilter = btn.dataset.filter;
      renderTable();
    });
  });

  document.querySelectorAll('.view-switcher .view-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.view-switcher .view-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      viewMode = btn.dataset.view;
      renderTable();
    });
  });

  document.getElementById('portfolioSearch').addEventListener('input', e => {
    searchQuery = e.target.value.trim();
    renderTable();
  });

  document.getElementById('portfolioSort').addEventListener('change', e => {
    sortMode = e.target.value;
    renderTable();
  });

  document.querySelectorAll('.search-type-pills .pill').forEach(pill => {
    pill.addEventListener('click', () => {
      document.querySelectorAll('.search-type-pills .pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      catalogSearchType = pill.dataset.stype;
      performCatalogSearch();
    });
  });

  document.getElementById('catalogSearchInput').addEventListener('input', () => {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(performCatalogSearch, 200);
  });

  document.getElementById('portfolioForm').addEventListener('submit', async e => {
    e.preventDefault();
    const editId = document.getElementById('formEditId').value;
    const payload = {
      idProduct: document.getElementById('formIdProduct').value || null,
      name: document.getElementById('formName').value.trim(),
      type: document.getElementById('formType').value,
      isHolo: document.getElementById('formIsHolo').value === 'true',
      buyPrice: Number(document.getElementById('formBuyPrice').value) || 0,
      quantity: Number(document.getElementById('formQuantity').value) || 1,
      condition: document.getElementById('formCondition').value,
      language: document.getElementById('formLanguage').value,
      buyDate: document.getElementById('formBuyDate').value,
      customLowPrice: document.getElementById('formCustomLowPrice').value,
      imageUrl: document.getElementById('formImageUrl').value.trim(),
      cardmarketUrl: document.getElementById('formCardmarketUrl').value.trim()
    };

    if (!isStaticMode && profileMode === 'owner') {
      if (editId) {
        await fetch(`/api/portfolio/${editId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
      } else {
        await fetch('/api/portfolio', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
      }
      closeAddModal();
      await fetchPortfolio();
    } else {
      // Static / iPhone / Personal Friends mode
      const now = new Date();
      const today = now.toISOString().slice(0, 10);
      const customLow = payload.customLowPrice !== '' && payload.customLowPrice != null ? Number(payload.customLowPrice) : null;
      if (editId) {
        const idx = portfolioItems.findIndex(i => i.id === editId);
        if (idx !== -1) {
          const it = portfolioItems[idx];
          it.name = payload.name;
          it.displayNameDe = payload.name;
          it.buyPrice = payload.buyPrice;
          it.quantity = payload.quantity;
          it.condition = payload.condition;
          it.language = payload.language;
          it.buyDate = payload.buyDate;
          it.customLowPrice = customLow;
        }
      } else {
        const pr = lastSelectedCatalogProd?.prices || {};
        const eff = customLow ?? pr.dePrice ?? pr.trend ?? pr.low ?? payload.buyPrice;
        const hist = [];
        const d30 = new Date(now.getTime() - 30 * 86400000).toISOString().slice(0, 10);
        const d7 = new Date(now.getTime() - 7 * 86400000).toISOString().slice(0, 10);
        const p30 = pr.avg30 ?? pr.trend ?? eff;
        if (p30 > 0) hist.push({ date: d30, low: Number(p30.toFixed(2)), trend: Number((pr.trend ?? p30).toFixed(2)), label: '30T Ø' });
        if ((pr.trend ?? eff) > 0) hist.push({ date: d7, low: Number((pr.trend ?? eff).toFixed(2)), trend: Number((pr.trend ?? eff).toFixed(2)), label: '7T Ø' });
        hist.push({ date: today, low: Number(eff.toFixed(2)), trend: Number((pr.trend ?? eff).toFixed(2)), label: 'Heute' });

        const cachedFallback = payload.idProduct ? tcgdexImgCache[String(payload.idProduct)] : '';
        portfolioItems.unshift({
          id: 'mobile_' + Date.now(),
          idProduct: payload.idProduct ? Number(payload.idProduct) : null,
          name: lastSelectedCatalogProd?.name || payload.name,
          displayNameDe: payload.name,
          type: payload.type,
          categoryName: lastSelectedCatalogProd?.categoryName || (payload.type === 'sealed' ? 'Sealed' : 'Single'),
          expansionName: lastSelectedCatalogProd?.expansionName || '',
          expansionCode: lastSelectedCatalogProd?.expansionCode || '',
          tcgdexId: lastSelectedCatalogProd?.tcgdexId || '',
          isHolo: payload.isHolo,
          condition: payload.condition,
          language: payload.language,
          quantity: payload.quantity,
          buyPrice: payload.buyPrice,
          buyDate: payload.buyDate || today,
          customLowPrice: customLow,
          imageUrl: payload.imageUrl,
          fallbackImageUrl: cachedFallback || '',
          cardmarketUrl: payload.cardmarketUrl,
          marketPrices: {
            dePrice: pr.dePrice ?? eff,
            low: pr.low ?? eff,
            trend: pr.trend ?? eff,
            avg30: pr.avg30 ?? eff,
            updatedAt: today
          },
          priceHistory: hist,
          createdAt: now.toISOString()
        });
      }
      saveLocalPortfolio();
      closeAddModal();
      renderAll();
    }
  });

  document.getElementById('snapshotForm').addEventListener('submit', async e => {
    e.preventDefault();
    const id = document.getElementById('snapshotItemId').value;
    const price = Number(document.getElementById('snapshotPrice').value);
    const date = document.getElementById('snapshotDate').value;

    if (!isStaticMode && profileMode === 'owner') {
      await fetch(`/api/portfolio/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          newSnapshotPrice: price,
          newSnapshotDate: date
        })
      });
      closeSnapshotModal();
      await fetchPortfolio();
    } else {
      const item = portfolioItems.find(i => i.id === id);
      if (item) {
        item.customLowPrice = price;
        if (!Array.isArray(item.priceHistory)) item.priceHistory = [];
        const ex = item.priceHistory.find(h => h.date === date);
        if (ex) ex.low = price;
        else item.priceHistory.push({ date, low: price, trend: price, label: 'DE Preis' });
        item.priceHistory.sort((a, b) => a.date.localeCompare(b.date));
        saveLocalPortfolio();
      }
      closeSnapshotModal();
      renderAll();
    }
  });
});
