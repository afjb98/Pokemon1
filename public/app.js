let portfolioItems = [];
let activeFilter = 'all';
let viewMode = 'sets'; // 'sets' (Pro Set Galerie wie im Screenshot) | 'table'
let collapsedSets = new Set();
let searchQuery = '';
let sortMode = 'profitDesc';
let selectedChartItemId = null;
let chartTimeframe = 'all'; // '7' | '14' | '30' | '90' | '365' | 'all'
let catalogSearchType = 'all';
let priceChartInstance = null;
let searchDebounceTimer = null;

// Hybrid Mode State: works with local Node.js backend OR pure static GitHub Pages / iPhone PWA
let isStaticMode = false;
let staticCatalogItems = null; // loaded lazily from ./data/catalog_compact.json when in static mode
const LOCAL_STORAGE_KEY = 'pokevault_portfolio_v1';
const DELETED_OWNER_IDS_KEY = 'pokevault_deleted_owner_ids_v1';
const PERSONAL_PORTFOLIO_KEY = 'pokevault_personal_portfolio_v1';
const PERSONAL_ID_KEY = 'pokevault_personal_profile_id';
const PROFILE_MODE_KEY = 'pokevault_profile_mode';
const PROFILE_NAME_KEY = 'pokevault_profile_name';
const ADMIN_FLAG_KEY = 'pokevault_is_admin';
const ADMIN_SESSION_KEY = 'pokevault_admin_session_v1';
const IMG_FALLBACK_CACHE_KEY = 'pokevault_img_cache_v4';
const CHECKLIST_STORAGE_PREFIX = 'pokevault_checklist_v1_';
const CHECKLIST_SAVED_AT_KEY = 'pokevault_checklist_saved_at_v1';
const CHECKLIST_LAST_SET_KEY = 'pokevault_checklist_last_set_v1';

let activeMainPage = 'portfolio'; // 'portfolio' | 'sets'
let setsIndexList = null;
let setsIndexPromise = null;
let selectedChecklistSetId = '';
let checklistFilter = 'all'; // 'all' | 'owned' | 'missing' | 'secrets'
let checklistSearch = '';
let currentChecklistData = null;
const FEATURED_CHECKLIST_SETS = [
  { id: 'me06', label: 'Delta-Herrschaft (DLR)' },
  { id: '30th-c', label: '30th Classic Collection (30C)' },
  { id: 'me05', label: 'Dunkelnacht (PBL)' },
  { id: 'me01', label: 'Mega-Entwicklung (MEG)' },
  { id: 'sv08.5', label: 'Prismatische Entwicklungen (PRE)' },
  { id: 'sv08', label: 'Stürmische Funken (SSP)' },
  { id: 'sv09', label: 'Reisegefährten (JTG)' },
  { id: 'sv03.5', label: 'Karmesin & Purpur 151 (MEW)' },
  { id: 'ex11', label: 'EX Delta Species (DS)' }
];

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

function stripTransientPortfolioFields(items) {
  return (items || []).map(it => {
    const copy = { ...it };
    if (copy.marketPrices && copy.marketPrices.raw) {
      copy.marketPrices = { ...copy.marketPrices };
      delete copy.marketPrices.raw;
    }
    return copy;
  });
}

function getDeletedOwnerIds() {
  try {
    const arr = JSON.parse(localStorage.getItem(DELETED_OWNER_IDS_KEY) || '[]');
    return new Set(Array.isArray(arr) ? arr : []);
  } catch (e) {
    return new Set();
  }
}

function addDeletedOwnerId(id) {
  if (!id) return;
  try {
    const set = getDeletedOwnerIds();
    set.add(id);
    localStorage.setItem(DELETED_OWNER_IDS_KEY, JSON.stringify([...set]));
  } catch (e) {}
}

function saveDeletedOwnerIdsSet(set) {
  try {
    localStorage.setItem(DELETED_OWNER_IDS_KEY, JSON.stringify([...set]));
  } catch (e) {}
}

let ownerCloudSyncTimer = null;
let ownerCloudVaultSetupMissing = false;

function scheduleOwnerCloudSync() {
  if (profileMode !== 'owner' || !isAdminMode || viewingFriend || ownerCloudVaultSetupMissing) return;
  clearTimeout(ownerCloudSyncTimer);
  ownerCloudSyncTimer = setTimeout(() => {
    pushOwnerCloudVaultNow();
  }, 500);
}

async function fetchOwnerCloudVault(token) {
  if (!token) return null;
  try {
    const res = await fetch(`${SUPABASE_REST_URL}/owner_vault?id=eq.main&select=id,items,checklists,deleted_ids,updated_at`, {
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${token}`
      }
    });
    if (res.status === 404) {
      ownerCloudVaultSetupMissing = true;
      return null;
    }
    if (!res.ok) return null;
    ownerCloudVaultSetupMissing = false;
    const rows = await res.json();
    return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
  } catch (e) {
    return null;
  }
}

async function pushOwnerCloudVaultNow() {
  if (profileMode !== 'owner' || !isAdminMode || viewingFriend || ownerCloudVaultSetupMissing) return false;
  const token = await getValidAdminAccessToken();
  if (!token) return false;
  try {
    const res = await fetch(`${SUPABASE_REST_URL}/owner_vault?on_conflict=id`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates,return=minimal'
      },
      body: JSON.stringify({
        id: 'main',
        items: stripTransientPortfolioFields(portfolioItems),
        checklists: loadChecklistOwnedMap(),
        deleted_ids: [...getDeletedOwnerIds()],
        updated_at: new Date().toISOString()
      })
    });
    if (res.status === 404) {
      ownerCloudVaultSetupMissing = true;
      return false;
    }
    if (res.ok) {
      updateStaticStatusBadge();
      return true;
    }
    return false;
  } catch (e) {
    return false;
  }
}

async function syncPersonalPortfolioToSupabase() {
  if (profileMode !== 'personal' || !profileName || viewingFriend) return;
  try {
    const pid = personalProfileId || getOrCreatePersonalId();
    const cleanItems = stripTransientPortfolioFields(portfolioItems);
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
  const expBtn = document.getElementById('btnOpenExpenseModal');
  const scanBtn = document.getElementById('btnOpenScannerModal');
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
    if (expBtn) expBtn.classList.add('hidden');
    if (scanBtn) scanBtn.classList.add('hidden');
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
  if (expBtn) expBtn.classList.remove('hidden');
  if (scanBtn) scanBtn.classList.remove('hidden');

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

const CONDITION_FACTORS = {
  M: 1.10,
  NM: 1.00,
  EX: 0.80,
  GD: 0.62,
  LP: 0.48,
  PL: 0.35,
  PO: 0.22
};

function hasBuyPrice(item) {
  return Boolean(
    item &&
    item.buyPrice !== null &&
    item.buyPrice !== undefined &&
    item.buyPrice !== '' &&
    !Number.isNaN(Number(item.buyPrice))
  );
}

function applyConditionPrice(basePrice, condition = 'NM', isSealed = false) {
  if (basePrice == null || Number.isNaN(Number(basePrice))) return null;
  const factor = isSealed
    ? (CONDITION_FACTORS[condition] != null && CONDITION_FACTORS[condition] < 1 ? CONDITION_FACTORS[condition] : 1)
    : (CONDITION_FACTORS[condition] ?? 1);
  return Number((Number(basePrice) * factor).toFixed(2));
}

function getVariantBadgeText(item) {
  const v = item?.variant || (item?.isHolo ? 'holo' : 'normal');
  if (v === 'reverse') return 'Reverse Holo';
  if (v === 'stamped') return 'Stamped';
  if (v === 'holo') return 'Holo';
  return '';
}

function getBaseDePrice(item) {
  if (item.marketPrices?.dePrice != null) return Number(item.marketPrices.dePrice);
  if (item.type === 'sealed' && item.marketPrices?.trend != null) return Number(item.marketPrices.trend);
  if (item.marketPrices?.low != null) return Number(item.marketPrices.low);
  return null;
}

function getUnitDePrice(item) {
  if (!item || item.type === 'expense') return 0;
  if (item.customLowPrice !== null && item.customLowPrice !== undefined && item.customLowPrice !== '') {
    return Number(item.customLowPrice);
  }
  const baseDe = getBaseDePrice(item);
  if (baseDe != null) {
    return applyConditionPrice(baseDe, item.condition || 'NM', item.type === 'sealed');
  }
  return hasBuyPrice(item) ? Number(item.buyPrice) : 0;
}

function getUnitRawEuLow(item) {
  if (!item || item.type === 'expense') return 0;
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

function saveLocalPortfolio(skipCloudSync = false) {
  if (viewingFriend) return; // Never overwrite local storage when inspecting a friend
  try {
    localStorage.setItem(
      getActiveStorageKey(),
      JSON.stringify({ items: portfolioItems, ownerName: profileName, savedAt: new Date().toISOString() })
    );
  } catch (e) {}
  if (!skipCloudSync) {
    if (profileMode === 'personal' && profileName) {
      scheduleSupabaseSync();
    } else if (profileMode === 'owner' && isAdminMode) {
      scheduleOwnerCloudSync();
    }
  }
}

let tcgdexAllSetsPromise = null;
let tcgdexAllDeSetsPromise = null;
const tcgdexCardDetailPromises = new Map();

function parseCardmarketHints(rawName, displayNameDe = '') {
  const raw = String(rawName || '').replace(/[’‘`]/g, "'");
  const bracketBlocks = [];
  raw.replace(/\[([^\]]+)\]/g, (_, inner) => {
    bracketBlocks.push(inner);
    return '';
  });

  const attackHints = [];
  for (const blk of bracketBlocks) {
    for (const part of blk.split('|')) {
      const cleaned = part.trim().toLowerCase();
      if (cleaned.length >= 3) attackHints.push(cleaned);
    }
  }

  let variantIndex = null;
  const verMatch = raw.match(/\((?:v|ver|version)\s*\.?\s*(\d+)\)/i);
  if (verMatch) variantIndex = parseInt(verMatch[1], 10);

  let localIdHint = '';
  const numMatch = raw.match(/(?:#|\b)(\d{1,3})\s*(?:\/\s*\d+)?\b/);
  if (numMatch && !/\b(?:gen|lv)\b/i.test(raw)) {
    localIdHint = String(parseInt(numMatch[1], 10));
  }

  let n = raw.replace(/\[.*?\]/g, '').trim();
  if (n.includes(' – ')) n = n.split(' – ').slice(1).join(' – ').trim();
  const parenDeMatch = n.match(/^[^(]+\(([^)]+)\)$/);
  if (parenDeMatch && !/^(?:v\s*\d+|version\s*\d+|\d+\/\d+|full art|secret|alt art|promo|holo|illustration rare|special illustration rare|hyper rare|double rare|ultra rare|ace spec|reverse holo|cosmos holo|poke ball|master ball|shiny)$/i.test(parenDeMatch[1].trim())) {
    n = parenDeMatch[1].trim();
  }
  n = n
    .replace(/\((?:v|ver|version)\s*\.?\s*\d+\)/gi, '')
    .replace(/\(\s*\d+\s*\/\s*\d+\s*\)/g, '')
    .replace(/\((?:full art|secret(?: rare)?|alt art|promo|holo|illustration rare|special illustration rare|hyper rare|double rare|ultra rare|ace spec|reverse holo|cosmos holo|pok[eé] ball|master ball|shiny)\)/gi, '')
    .replace(/#\s*\d+(?:\s*\/\s*\d+)?/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  const nameCandidates = [n];
  if (/[δ]|delta\s+species/i.test(n)) {
    nameCandidates.push(n.replace(/[δ]/g, '').replace(/\bdelta\s+species\b/gi, '').replace(/\s+/g, ' ').trim());
  }
  if (/gold\s*star/i.test(n)) {
    nameCandidates.unshift(n.replace(/\s*gold\s*star/gi, ' ☆').trim());
    nameCandidates.push(n.replace(/\s*gold\s*star/gi, ' ★').trim());
    nameCandidates.push(n.replace(/\s*gold\s*star/gi, '').trim());
  }
  if (/\bex\b/i.test(n) && !/-ex/i.test(n)) {
    nameCandidates.push(n.replace(/\s+EX\b/, '-EX').trim());
  }
  if (/-EX\b/i.test(n)) {
    nameCandidates.push(n.replace(/-EX\b/gi, ' ex').trim());
  }
  if (/^Mega\s+/i.test(n)) {
    nameCandidates.push(n.replace(/^Mega\s+/i, 'M ').trim());
    nameCandidates.push(n.replace(/^Mega\s+/i, 'M ').replace(/\s+ex$/i, '-EX').trim());
  }

  const deNameCandidates = [];
  if (displayNameDe) {
    let deClean = String(displayNameDe).replace(/[’‘`]/g, "'").replace(/\[.*?\]/g, '').trim();
    if (deClean.includes(' – ')) deClean = deClean.split(' – ')[0].trim();
    deClean = deClean.replace(/\([^)]*\)/g, '').replace(/#\s*\d+(?:\s*\/\s*\d+)?/g, '').replace(/[δ]/g, '').replace(/\s+/g, ' ').trim();
    if (deClean && deClean.toLowerCase() !== n.toLowerCase()) {
      deNameCandidates.push(deClean);
    }
  }

  return {
    cleanName: nameCandidates[0],
    nameCandidates: [...new Set(nameCandidates.filter(Boolean))],
    deNameCandidates: [...new Set(deNameCandidates.filter(Boolean))],
    attackHints,
    variantIndex,
    localIdHint
  };
}

async function fetchAllTcgdexSets() {
  if (!tcgdexAllSetsPromise) {
    tcgdexAllSetsPromise = fetch('https://api.tcgdex.net/v2/en/sets')
      .then(r => (r.ok ? r.json() : []))
      .catch(() => []);
  }
  return tcgdexAllSetsPromise;
}

async function fetchAllTcgdexDeSets() {
  if (!tcgdexAllDeSetsPromise) {
    tcgdexAllDeSetsPromise = fetch('https://api.tcgdex.net/v2/de/sets')
      .then(r => (r.ok ? r.json() : []))
      .catch(() => []);
  }
  return tcgdexAllDeSetsPromise;
}

async function findTcgdexSetIdByExpansion(expansionName, expansionCode = '') {
  const codeUpper = String(expansionCode || '').trim().toUpperCase();
  const cleanExp = String(expansionName || '')
    .replace(/^(?:karmesin\s*&\s*purpur|schwert\s*&\s*schild|sonne\s*&\s*mond|scarlet\s*&\s*violet|sword\s*&\s*shield|sun\s*&\s*moon)[:\s–-]*/i, '')
    .trim()
    .toLowerCase();
  const normExp = cleanExp.replace(/[^a-z0-9äöüß]/g, '');

  // 1. Check sets_index.json first (supports code, German names, and English names)
  try {
    const idxSets = await ensureSetsIndexLoaded();
    if (Array.isArray(idxSets) && idxSets.length > 0) {
      if (codeUpper) {
        const byCode = idxSets.find(s => String(s.code || '').toUpperCase() === codeUpper);
        if (byCode?.tcgdexId) return byCode.tcgdexId;
      }
      if (cleanExp) {
        for (const s of idxSets) {
          const de = String(s.de || '').toLowerCase();
          const en = String(s.en || '').toLowerCase();
          if (de === cleanExp || en === cleanExp) return s.tcgdexId;
        }
        for (const s of idxSets) {
          const deNorm = String(s.de || '').toLowerCase().replace(/[^a-z0-9äöüß]/g, '');
          const enNorm = String(s.en || '').toLowerCase().replace(/[^a-z0-9äöüß]/g, '');
          if (normExp && (deNorm === normExp || enNorm === normExp)) return s.tcgdexId;
        }
        if (cleanExp.length >= 4) {
          for (const s of idxSets) {
            const de = String(s.de || '').toLowerCase();
            const en = String(s.en || '').toLowerCase();
            if ((de && (de.includes(cleanExp) || cleanExp.includes(de))) ||
                (en && (en.includes(cleanExp) || cleanExp.includes(en)))) {
              return s.tcgdexId;
            }
          }
        }
      }
    }
  } catch (e) {}

  if (!cleanExp) return '';

  // 2. Fallback: TCGdex EN sets, then DE sets
  for (const fetcher of [fetchAllTcgdexSets, fetchAllTcgdexDeSets]) {
    const allSets = await fetcher();
    if (!Array.isArray(allSets) || allSets.length === 0) continue;
    for (const s of allSets) {
      if (s.name && s.name.toLowerCase() === cleanExp) return s.id;
    }
    for (const s of allSets) {
      if (s.name && s.name.toLowerCase().replace(/[^a-z0-9äöüß]/g, '') === normExp) return s.id;
    }
    if (cleanExp.length >= 4) {
      for (const s of allSets) {
        const sn = (s.name || '').toLowerCase();
        if (sn && (sn.includes(cleanExp) || cleanExp.includes(sn))) return s.id;
      }
    }
  }
  return '';
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

async function fetchTcgdexCardDetail(cardId) {
  if (!cardId) return null;
  if (tcgdexCardDetailPromises.has(cardId)) return tcgdexCardDetailPromises.get(cardId);
  const p = fetch(`https://api.tcgdex.net/v2/en/cards/${encodeURIComponent(cardId)}`)
    .then(r => (r.ok ? r.json() : null))
    .catch(() => null);
  tcgdexCardDetailPromises.set(cardId, p);
  return p;
}

function getCatalogSiblingIndex(idProduct, rawName, expansionName) {
  if (!idProduct || !rawName || !Array.isArray(staticCatalogItems)) return 0;
  const normName = String(rawName).trim().toLowerCase();
  const normExp = String(expansionName || '').trim().toLowerCase();
  const siblingIds = [];
  for (let i = 0; i < staticCatalogItems.length; i++) {
    const row = staticCatalogItems[i];
    if (String(row[1] || '').trim().toLowerCase() !== normName) continue;
    if (normExp && String(row[5] || '').trim().toLowerCase() !== normExp) continue;
    siblingIds.push(Number(row[0]));
  }
  if (siblingIds.length <= 1) return 0;
  siblingIds.sort((a, b) => a - b);
  const idx = siblingIds.indexOf(Number(idProduct));
  return idx >= 0 ? idx : 0;
}

async function pickBestCardCandidate(matches, hints, siblingIdx = 0) {
  if (!Array.isArray(matches) || matches.length === 0) return null;
  if (matches.length === 1) return matches[0];

  if (hints.localIdHint) {
    const byNum = matches.find(c => String(parseInt(c.localId, 10)) === hints.localIdHint);
    if (byNum) return byNum;
  }

  let pool = matches;
  if (hints.attackHints.length > 0) {
    const slice = matches.slice(0, 8);
    const details = await Promise.all(slice.map(c => fetchTcgdexCardDetail(c.id)));
    const scores = new Array(slice.length).fill(0);
    let bestScore = 0;
    for (let i = 0; i < details.length; i++) {
      const d = details[i];
      if (!d) continue;
      const moveNames = [
        ...(Array.isArray(d.attacks) ? d.attacks.map(a => (a.name || '').toLowerCase()) : []),
        ...(Array.isArray(d.abilities) ? d.abilities.map(a => (a.name || '').toLowerCase()) : [])
      ];
      let score = 0;
      for (const h of hints.attackHints) {
        if (moveNames.some(m => m === h || m.includes(h) || h.includes(m))) score += 1;
      }
      scores[i] = score;
      if (score > bestScore) bestScore = score;
    }
    if (bestScore > 0) {
      pool = slice.filter((_, i) => scores[i] === bestScore);
    }
  }

  if (hints.variantIndex && hints.variantIndex >= 1) {
    const idx = Math.min(hints.variantIndex - 1, pool.length - 1);
    return pool[idx];
  }

  if (siblingIdx > 0 && pool.length > 1) {
    return pool[siblingIdx % pool.length];
  }

  return pool[0];
}

async function resolveTcgdexImage(idProduct, rawName, type, tcgdexId, expansionName = '', siblingIdxOverride = null, expansionCode = '', displayNameDe = '') {
  const key = String(idProduct || rawName || '');
  if (tcgdexImgCache[key]) return tcgdexImgCache[key];
  if (tcgdexInflightCard.has(key)) return tcgdexInflightCard.get(key);

  const task = (async () => {
    try {
      const hints = parseCardmarketHints(rawName, displayNameDe);
      const siblingIdx = siblingIdxOverride != null
        ? Number(siblingIdxOverride) || 0
        : getCatalogSiblingIndex(idProduct, rawName, expansionName);
      const resolvedSetId = tcgdexId || await findTcgdexSetIdByExpansion(expansionName, expansionCode);

      if (type === 'sealed') {
        if (resolvedSetId) {
          const setObj = await fetchTcgdexSet(resolvedSetId) || await fetchTcgdexSetDe(resolvedSetId);
          if (setObj?.logo) {
            const url = `${setObj.logo}.webp`;
            tcgdexImgCache[key] = url;
            saveImgFallbackCache();
            return url;
          }
        }
        return null;
      }

      // Single card: match inside resolved TCGdex set (EN first, then DE fallback)
      if (resolvedSetId) {
        if (hints.nameCandidates.length > 0) {
          const setObj = await fetchTcgdexSet(resolvedSetId);
          if (setObj && Array.isArray(setObj.cards)) {
            let matches = [];
            for (const cand of hints.nameCandidates) {
              const lower = cand.toLowerCase();
              const norm = lower.replace(/[^a-z0-9]/g, '');
              matches = setObj.cards.filter(c => c.image && c.name && c.name.toLowerCase() === lower);
              if (matches.length === 0) {
                matches = setObj.cards.filter(c => c.image && c.name && c.name.toLowerCase().replace(/[^a-z0-9]/g, '') === norm);
              }
              if (matches.length === 0 && lower.length >= 4) {
                matches = setObj.cards.filter(c => c.image && c.name && (c.name.toLowerCase().includes(lower) || lower.includes(c.name.toLowerCase())));
              }
              if (matches.length > 0) break;
            }

            const chosen = await pickBestCardCandidate(matches, hints, siblingIdx);
            if (chosen?.image) {
              const url = `${chosen.image}/low.webp`;
              tcgdexImgCache[key] = url;
              saveImgFallbackCache();
              return url;
            }
          }
        }

        if (hints.deNameCandidates.length > 0) {
          const deSetObj = await fetchTcgdexSetDe(resolvedSetId);
          if (deSetObj && Array.isArray(deSetObj.cards)) {
            let deMatches = [];
            for (const cand of hints.deNameCandidates) {
              const lower = cand.toLowerCase();
              const norm = lower.replace(/[^a-z0-9äöüß]/g, '');
              deMatches = deSetObj.cards.filter(c => c.image && c.name && c.name.toLowerCase() === lower);
              if (deMatches.length === 0) {
                deMatches = deSetObj.cards.filter(c => c.image && c.name && c.name.toLowerCase().replace(/[^a-z0-9äöüß]/g, '') === norm);
              }
              if (deMatches.length > 0) break;
            }
            const chosenDe = await pickBestCardCandidate(deMatches, hints, siblingIdx);
            if (chosenDe?.image) {
              const url = `${chosenDe.image}/low.webp`;
              tcgdexImgCache[key] = url;
              saveImgFallbackCache();
              return url;
            }
          }
        }
      }

      // Global TCGdex search by card name with set-filter & attack matching (avoids identical Base Set artwork!)
      for (const cand of hints.nameCandidates.slice(0, 2)) {
        if (!cand || cand.length < 2) continue;
        const res = await fetch(`https://api.tcgdex.net/v2/en/cards?name=${encodeURIComponent(cand)}`);
        if (!res.ok) continue;
        const list = await res.json();
        if (!Array.isArray(list) || list.length === 0) continue;

        const withImg = list.filter(c => c.image);
        const physical = withImg.filter(c => !String(c.image).includes('/tcgp/'));
        let pool = physical.length > 0 ? physical : withImg;

        if (resolvedSetId) {
          const prefix = `${resolvedSetId.toLowerCase()}-`;
          const inSet = pool.filter(c => c.id && c.id.toLowerCase().startsWith(prefix));
          if (inSet.length > 0) {
            pool = inSet;
          } else {
            // Do NOT show a random wrong-set card image when we know the set!
            continue;
          }
        } else if (pool.length > 1 && hints.attackHints.length === 0 && !hints.localIdHint) {
          // Without set or attack disambiguation, avoid returning the exact same first hit for unrelated printings
          continue;
        }

        const chosen = await pickBestCardCandidate(pool, hints, siblingIdx);
        if (chosen?.image) {
          const url = `${chosen.image}/low.webp`;
          tcgdexImgCache[key] = url;
          saveImgFallbackCache();
          return url;
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
  const deName = imgEl.dataset.de || '';
  const type = imgEl.dataset.type || 'single';
  const tcgdexId = imgEl.dataset.tcgdex || '';
  const expName = imgEl.dataset.exp || '';
  const expCode = imgEl.dataset.code || '';
  const sidx = imgEl.dataset.sidx != null && imgEl.dataset.sidx !== '' ? Number(imgEl.dataset.sidx) : null;
  const badge = imgEl.dataset.badge || (type === 'sealed' ? 'BOX' : 'TCG');
  const step = imgEl.dataset.tryStep || '';

  const curSrc = imgEl.getAttribute('src') || '';

  // If a TCGdex image 404s on a card that also has a Cardmarket idProduct, try local/static Cardmarket image first
  if (idProduct && step === '' && curSrc.includes('tcgdex.net')) {
    imgEl.dataset.tryStep = isStaticMode ? 'cm_jpg' : 'cm_api';
    imgEl.src = isStaticMode ? `./images/${idProduct}.jpg` : `/api/cm-image/${idProduct}`;
    return;
  }

  // Step 1 on static mode: if .jpg failed, try .png in ./images/
  if (isStaticMode && idProduct && (step === '' || step === 'cm_jpg') && curSrc.endsWith('.jpg')) {
    imgEl.dataset.tryStep = 'png';
    imgEl.src = `./images/${idProduct}.png`;
    return;
  }

  // Step 2: if already tried TCGdex fallback (or cm_api failed), show badge (and purge broken cached URL)
  if (step === 'tcgdex' || step === 'done' || step === 'cm_api') {
    if (curSrc.includes('tcgdex.net')) {
      const cacheKey = String(idProduct || rawName || '');
      if (cacheKey && tcgdexImgCache[cacheKey]) {
        delete tcgdexImgCache[cacheKey];
        saveImgFallbackCache();
      }
    }
    if (imgEl.parentElement) imgEl.parentElement.textContent = badge;
    return;
  }

  imgEl.dataset.tryStep = 'tcgdex';

  if (!isStaticMode && !tcgdexId && !expName && !expCode) {
    if (imgEl.parentElement) imgEl.parentElement.textContent = badge;
    return;
  }

  const url = await resolveTcgdexImage(idProduct, rawName, type, tcgdexId, expName, sidx, expCode, deName);
  if (url) {
    imgEl.src = url;
  } else {
    imgEl.dataset.tryStep = 'done';
    if (imgEl.parentElement) imgEl.parentElement.textContent = badge;
  }
};

function updateStaticStatusBadge() {
  if (!isStaticMode) return;
  const badge = document.getElementById('catalogStatusBadge');
  const text = document.getElementById('catalogStatusText');
  if (!badge || !text) return;

  if (profileMode === 'personal') {
    badge.className = 'status-pill ready';
    text.textContent = 'Persönlicher Modus';
    badge.style.cursor = 'default';
    badge.onclick = null;
    return;
  }

  if (isAdminMode) {
    const sess = getAdminSession();
    if (ownerCloudVaultSetupMissing) {
      badge.className = 'status-pill loading';
      text.textContent = 'Cloud-Sync: SQL Setup offen';
      badge.style.cursor = 'pointer';
      badge.onclick = () => openAdminLoginModal('sync');
    } else if (sess && sess.access_token) {
      badge.className = 'status-pill ready';
      text.textContent = '☁️ Cloud-Sync aktiv';
      badge.style.cursor = 'default';
      badge.onclick = null;
    } else {
      badge.className = 'status-pill loading';
      text.textContent = 'Cloud-Sync: Admin-Login';
      badge.style.cursor = 'pointer';
      badge.title = 'Klicken zum Einloggen für iPhone ↔ PC Sync';
      badge.onclick = () => openAdminLoginModal('sync');
    }
  } else {
    badge.className = 'status-pill ready';
    text.textContent = 'Cloud / iPhone Modus aktiv';
    badge.style.cursor = 'default';
    badge.onclick = null;
  }
}

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
    updateStaticStatusBadge();
  }
}

let staticCatalogLoadingPromise = null;

// Load Static Catalog on demand when on GitHub Pages
async function ensureStaticCatalogLoaded() {
  if (staticCatalogItems) return staticCatalogItems;
  if (staticCatalogLoadingPromise) return staticCatalogLoadingPromise;
  staticCatalogLoadingPromise = (async () => {
    const res = await fetch(`./data/catalog_compact.json?t=${Date.now()}`);
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
      if (!item.idProduct || item.type === 'expense') continue;
      const row = byId.get(Number(item.idProduct));
      if (!row) continue;
      const [, , , , , , , stdDePrice, stdLow, stdTrend, stdAvg30, , tcgdexId, holoRow] = row;
      if (tcgdexId && !item.tcgdexId) item.tcgdexId = tcgdexId;
      const useHolo = Boolean(item.isHolo) && Array.isArray(holoRow);
      const dePrice = useHolo ? (holoRow[0] ?? stdDePrice) : stdDePrice;
      const low = useHolo ? (holoRow[1] ?? stdLow) : stdLow;
      const trend = useHolo ? (holoRow[2] ?? stdTrend) : stdTrend;
      const avg30 = useHolo ? (holoRow[3] ?? stdAvg30) : stdAvg30;

      item.marketPrices = {
        ...(item.marketPrices || {}),
        dePrice: dePrice ?? item.marketPrices?.dePrice ?? null,
        low: low ?? item.marketPrices?.low ?? null,
        trend: trend ?? item.marketPrices?.trend ?? null,
        avg30: avg30 ?? item.marketPrices?.avg30 ?? null,
        hasHoloPrices: Array.isArray(holoRow),
        updatedAt: today
      };
      const condAdjusted = applyConditionPrice(dePrice ?? trend ?? low, item.condition || 'NM', item.type === 'sealed');
      const eff = item.customLowPrice != null
        ? Number(item.customLowPrice)
        : (condAdjusted ?? 0);
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

  // Static Mode (GitHub Pages / iPhone): Fetch `./data/portfolio.json` + 2-way Supabase Admin Vault if logged in
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

  const deletedIds = getDeletedOwnerIds();
  const adminToken = isAdminMode ? await getValidAdminAccessToken() : null;
  const cloudVault = adminToken ? await fetchOwnerCloudVault(adminToken) : null;
  updateStaticStatusBadge();

  if (cloudVault && Array.isArray(cloudVault.deleted_ids)) {
    for (const did of cloudVault.deleted_ids) deletedIds.add(did);
    saveDeletedOwnerIdsSet(deletedIds);
  }

  // Merge Set-Checkliste from cloud cleanly (timestamp-aware)
  const chkMerge = mergeChecklistWithCloud(cloudVault);
  const cloudUpdatedMs = cloudVault?.updated_at ? Date.parse(cloudVault.updated_at) : 0;
  let needsCloudPush = Boolean(chkMerge.needsPush);

  if (cloudVault && Array.isArray(cloudVault.items) && cloudVault.items.length > 0) {
    // Cloud Vault exists -> use as primary truth across PC & iPhone, plus newer local edits & any new GitHub items
    const cloudById = new Map(cloudVault.items.map(i => [i.id, i]));
    const localById = new Map((localData?.items || []).map(i => [i.id, i]));
    const mergedList = [];

    for (const cItem of cloudVault.items) {
      if (deletedIds.has(cItem.id)) continue;
      const localEd = localById.get(cItem.id);
      const localEdMs = localEd?.mobileEditedAt ? Date.parse(localEd.mobileEditedAt) : 0;
      if (localEd && localEdMs > cloudUpdatedMs) {
        mergedList.push({ ...cItem, ...localEd });
        needsCloudPush = true;
      } else {
        mergedList.push(cItem);
      }
    }

    // Add brand-new items from GitHub portfolio.json or local mobile_ items not yet in cloudVault
    for (const rItem of remoteItems) {
      if (deletedIds.has(rItem.id) || cloudById.has(rItem.id)) continue;
      const localEd = localById.get(rItem.id);
      mergedList.push(localEd?.mobileEditedAt ? { ...rItem, ...localEd } : rItem);
      needsCloudPush = true;
    }
    for (const lItem of (localData?.items || [])) {
      if (deletedIds.has(lItem.id) || cloudById.has(lItem.id)) continue;
      if (String(lItem.id).startsWith('mobile_')) {
        mergedList.unshift(lItem);
        needsCloudPush = true;
      }
    }

    portfolioItems = mergedList;
    saveLocalPortfolio(true);
  } else if (localData && Array.isArray(localData.items) && localData.items.length > 0 && remoteItems.length === 0) {
    portfolioItems = localData.items.filter(i => !deletedIds.has(i.id));
    if (adminToken && !ownerCloudVaultSetupMissing) needsCloudPush = true;
  } else if (remoteItems.length > 0) {
    // No Cloud Vault row yet -> merge GitHub portfolio.json with local mobile edits / deletions
    const localById = new Map((localData?.items || []).map(i => [i.id, i]));
    const remoteIds = new Set(remoteItems.map(i => i.id));
    const mergedRemote = [];
    for (const rItem of remoteItems) {
      if (deletedIds.has(rItem.id)) continue;
      const localEd = localById.get(rItem.id);
      if (localEd && localEd.mobileEditedAt) {
        mergedRemote.push({
          ...rItem,
          name: localEd.name,
          displayNameDe: localEd.displayNameDe,
          type: localEd.type,
          variant: localEd.variant,
          isHolo: localEd.isHolo,
          isFirstEdition: localEd.isFirstEdition,
          buyPrice: localEd.buyPrice,
          quantity: localEd.quantity,
          condition: localEd.condition,
          language: localEd.language,
          buyDate: localEd.buyDate,
          customLowPrice: localEd.customLowPrice,
          packsCount: localEd.packsCount,
          expensePreset: localEd.expensePreset,
          notes: localEd.notes,
          mobileEditedAt: localEd.mobileEditedAt
        });
      } else {
        mergedRemote.push(rItem);
      }
    }
    const mobileOnlyItems = (localData?.items || []).filter(i => !remoteIds.has(i.id) && String(i.id).startsWith('mobile_') && !deletedIds.has(i.id));
    portfolioItems = [...mobileOnlyItems, ...mergedRemote];
    saveLocalPortfolio(true);
    if (adminToken && !ownerCloudVaultSetupMissing) needsCloudPush = true;
  } else {
    portfolioItems = [];
  }

  renderAll();
  const enriched = await enrichItemsWithCatalog(portfolioItems);
  if (enriched) {
    saveLocalPortfolio(true);
    renderAll();
    if (adminToken && !ownerCloudVaultSetupMissing) needsCloudPush = true;
  }
  if (needsCloudPush && adminToken && !ownerCloudVaultSetupMissing) {
    await pushOwnerCloudVaultNow();
  }
}

function renderAll() {
  renderKpis();
  renderTable();
  renderChart();
  if (activeMainPage === 'sets' && currentChecklistData) {
    renderChecklistView();
  }
}

function renderKpis() {
  let totalValueDe = 0;
  let totalValueEuLow = 0;
  let totalInvested = 0;
  let totalExpenseCost = 0;
  let expenseCount = 0;
  let trackedCostCount = 0;
  let activePosCount = 0;
  let totalQty = 0;

  let singlesQty = 0;
  let sealedQty = 0;
  let singlesVal = 0;
  let sealedVal = 0;

  for (const item of portfolioItems) {
    const qty = Number(item.quantity) || 1;
    const hasCost = hasBuyPrice(item);
    const unitBuy = hasCost ? Number(item.buyPrice) : 0;

    if (item.type === 'expense') {
      const expCost = unitBuy * qty;
      totalInvested += expCost;
      totalExpenseCost += expCost;
      expenseCount++;
      continue;
    }

    const unitDe = getUnitDePrice(item);
    const unitEuLow = getUnitRawEuLow(item);
    const itemVal = unitDe * qty;
    totalValueDe += itemVal;
    totalValueEuLow += unitEuLow * qty;
    activePosCount++;
    totalQty += qty;

    if (hasCost) {
      totalInvested += unitBuy * qty;
      trackedCostCount++;
    }

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
  document.getElementById('kpiTotalInvested').textContent = (trackedCostCount > 0 || expenseCount > 0) ? fmtEuro(totalInvested) : '—';

  const countParts = [`${activePosCount} Positionen (${totalQty} Stück)`];
  if (expenseCount > 0) {
    countParts.push(`Geöffnet: ${fmtEuro(totalExpenseCost)} (${expenseCount}x)`);
  } else if (trackedCostCount > 0 && trackedCostCount < activePosCount) {
    countParts.push(`EK bei ${trackedCostCount}`);
  }
  document.getElementById('kpiItemCount').textContent = countParts.join(' • ');

  const profitEl = document.getElementById('kpiTotalProfit');
  const profitPctEl = document.getElementById('kpiTotalProfitPct');

  if (totalInvested === 0 && activePosCount > 0 && expenseCount === 0) {
    profitEl.textContent = 'Kein EK';
    profitPctEl.textContent = 'Einkaufspreis optional (nicht eingetragen)';
    profitEl.style.color = 'var(--text-muted)';
  } else {
    profitEl.textContent = fmtSignedEuro(totalProfit);
    profitPctEl.textContent = totalInvested > 0
      ? `${fmtSignedPct(profitPct)} Rendite auf alle Ausgaben`
      : 'Noch keine Ausgaben eingetragen';
    profitEl.style.color = totalProfit >= 0 ? 'var(--green)' : 'var(--red)';
  }

  document.getElementById('kpiSplitValue').textContent = `${singlesQty} Karten / ${sealedQty} Sealed`;
  document.getElementById('kpiSplitSub').textContent = `Karten: ${fmtEuro(singlesVal)} • Sealed: ${fmtEuro(sealedVal)}`;

  const activeItems = portfolioItems.filter(i => i.type !== 'expense');
  document.getElementById('countAll').textContent = activeItems.length;
  document.getElementById('countSingles').textContent = activeItems.filter(i => i.type !== 'sealed').length;
  document.getElementById('countSealed').textContent = activeItems.filter(i => i.type === 'sealed').length;
  const expCountEl = document.getElementById('countExpense');
  if (expCountEl) expCountEl.textContent = expenseCount;
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
    const isExp = item.type === 'expense';
    if (activeFilter === 'expense' && !isExp) return false;
    if (activeFilter !== 'expense' && isExp) return false;
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
        (item.categoryName || '').toLowerCase().includes(q) ||
        (item.notes || '').toLowerCase().includes(q)
      );
    }
    return true;
  });

  const sortItemsFn = (a, b) => {
    const qtyA = Number(a.quantity) || 1;
    const qtyB = Number(b.quantity) || 1;
    const valA = getUnitDePrice(a) * qtyA;
    const valB = getUnitDePrice(b) * qtyB;
    const hasCostA = hasBuyPrice(a);
    const hasCostB = hasBuyPrice(b);
    const buyA = hasCostA ? Number(a.buyPrice) * qtyA : 0;
    const buyB = hasCostB ? Number(b.buyPrice) * qtyB : 0;
    const profA = hasCostA ? (valA - buyA) : -Infinity;
    const profB = hasCostB ? (valB - buyB) : -Infinity;
    const pctA = (hasCostA && buyA > 0) ? (profA / buyA) * 100 : -Infinity;
    const pctB = (hasCostB && buyB > 0) ? (profB / buyB) * 100 : -Infinity;

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
    const hasCost = hasBuyPrice(item);
    const unitBuy = hasCost ? Number(item.buyPrice) : null;
    const unitDe = getUnitDePrice(item);
    const euLow = item.marketPrices?.low;
    const avg30 = item.marketPrices?.avg30 ?? item.marketPrices?.avg;

    const totalBuy = hasCost ? unitBuy * qty : null;
    const totalVal = unitDe * qty;
    const profit = hasCost ? totalVal - totalBuy : null;
    const profitPct = (hasCost && totalBuy > 0) ? (profit / totalBuy) * 100 : 0;

    const tr = document.createElement('tr');
    if (selectedChartItemId === item.id) {
      tr.classList.add('selected-row');
    }

    const profitClass = profit == null ? 'neutral' : profit > 0.001 ? 'pos' : profit < -0.001 ? 'neg' : 'neutral';
    const effectiveImg = resolveItemImageUrl(item);
    const badgeTxt = item.expansionCode || (item.type === 'sealed' ? 'BOX' : 'TCG');
    const thumbContent = effectiveImg
      ? `<img src="${escapeHtml(effectiveImg)}" alt="" data-id="${escapeHtml(item.idProduct || '')}" data-name="${escapeHtml(item.name)}" data-de="${escapeHtml(item.displayNameDe || '')}" data-type="${escapeHtml(item.type)}" data-tcgdex="${escapeHtml(item.tcgdexId || '')}" data-exp="${escapeHtml(item.expansionName || '')}" data-code="${escapeHtml(item.expansionCode || '')}" data-badge="${escapeHtml(badgeTxt)}" onerror="handleCardImageError(this)" />`
      : escapeHtml(badgeTxt);

    const displayTitle = item.displayNameDe || item.name;
    const condCode = item.condition || 'NM';
    const variantTxt = getVariantBadgeText(item);
    const priceSourceLabel = item.customLowPrice != null
      ? 'Eigener DE-Preis'
      : (item.type === 'sealed'
        ? 'CM DE-Richtwert'
        : (condCode !== 'NM' ? `CM ~${condCode} Schätzwert` : 'CM DE-Kurs'));

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
        <span class="badge ${item.type === 'sealed' ? 'badge-sealed' : item.type === 'expense' ? 'badge-meta' : 'badge-single'}">
          ${item.type === 'sealed' ? 'Sealed' : item.type === 'expense' ? 'Geöffnet' : 'Karte'}
        </span>
        ${variantTxt ? `<span class="badge">${escapeHtml(variantTxt)}</span>` : ''}
        ${item.isFirstEdition ? '<span class="badge badge-sealed">1st Ed.</span>' : ''}
        ${item.type === 'expense'
          ? `<span class="badge badge-meta">${item.packsCount ? `${item.packsCount} Packs` : 'Ausgabe'}${item.buyDate ? ` • ${escapeHtml(item.buyDate)}` : ''}</span>`
          : `<span class="badge badge-meta">${escapeHtml(condCode)} • ${escapeHtml(item.language || 'DE')}</span>`}
      </td>
      <td class="num">${qty}x</td>
      <td class="num">
        <div>${hasCost ? fmtEuro(unitBuy) : '—'}</div>
        ${hasCost && qty > 1 ? `<div class="product-id">Gesamt: ${fmtEuro(totalBuy)}</div>` : ''}
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
        ${profit == null
          ? `<div class="profit-pill neutral"><span>Kein EK</span></div>`
          : `<div class="profit-pill ${profitClass}">
              <span>${fmtSignedEuro(profit)}</span>
              <span class="profit-pct">${fmtSignedPct(profitPct)}</span>
            </div>`}
      </td>
      <td>
        <div class="row-actions" onclick="event.stopPropagation();">
          ${!viewingFriend && item.type === 'sealed' ? `<button class="action-btn open-sealed-btn" title="Aus Sealed-Bestand öffnen & unter Geöffnet verbuchen" onclick="markSealedAsOpened('${item.id}')">📦 Geöffnet</button>` : ''}
          ${viewingFriend ? '' : (item.type === 'expense' ? '' : `<button class="action-btn" title="DE-Preis direkt anpassen" onclick="openSnapshotModal('${item.id}')">DE €</button>`)}
          ${cmUrl ? `<a class="action-btn" href="${escapeHtml(cmUrl)}" target="_blank" rel="noopener" title="Auf Cardmarket (Deutsch) öffnen">CM ↗</a>` : ''}
          ${viewingFriend ? '' : `<button class="action-btn" title="Bearbeiten" onclick="${item.type === 'expense' ? `openExpenseModal('${item.id}')` : `openEditModal('${item.id}')`}">Bearbeiten</button>`}
          ${viewingFriend ? '' : `<button class="action-btn delete" title="Aus Portfolio löschen" onclick="deleteItem('${item.id}')">Löschen</button>`}
        </div>
      </td>
    `;

    const thumbEl = tr.querySelector('.product-thumb');
    if (thumbEl) {
      thumbEl.addEventListener('click', e => {
        e.stopPropagation();
        openCardZoomModal(item, thumbEl.querySelector('img'));
      });
    }

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
    container.innerHTML = activeFilter === 'expense'
      ? `<div class="search-hint">Noch keine geöffneten Displays oder TTBs eingetragen. Klicke oben auf „+ Display/TTB geöffnet“, um Pack-Ausgaben zu erfassen.</div>`
      : `<div class="search-hint">Keine passenden Einträge gefunden.</div>`;
    return;
  }

  if (activeFilter === 'expense') {
    const listEl = document.createElement('div');
    listEl.className = 'expense-list';
    for (const item of items) {
      const qty = Number(item.quantity) || 1;
      const costUnit = Number(item.buyPrice) || 0;
      const totCost = costUnit * qty;
      const totalPacks = (Number(item.packsCount) || 0) * qty;
      const perPack = totalPacks > 0 && totCost > 0 ? totCost / totalPacks : null;

      const card = document.createElement('div');
      card.className = 'expense-card';
      const metaBits = [
        qty > 1 ? `${qty}x` : '',
        totalPacks > 0 ? `${totalPacks} Packs` : '',
        perPack != null ? `${fmtEuro(perPack)} / Pack` : '',
        item.buyDate || '',
        item.notes || ''
      ].filter(Boolean);

      const imgUrl = resolveItemImageUrl(item);
      const thumbBadge = item.expansionCode || 'BOX';
      card.innerHTML = `
        <div class="expense-card-left-wrap">
          ${imgUrl ? `<div class="expense-card-thumb"><img src="${escapeHtml(imgUrl)}" loading="lazy" alt="" data-id="${escapeHtml(item.idProduct || '')}" data-name="${escapeHtml(item.name || '')}" data-de="${escapeHtml(item.displayNameDe || '')}" data-type="sealed" data-tcgdex="${escapeHtml(item.tcgdexId || '')}" data-exp="${escapeHtml(item.expansionName || '')}" data-code="${escapeHtml(item.expansionCode || '')}" data-badge="${escapeHtml(thumbBadge)}" onerror="handleCardImageError(this)" /></div>` : ''}
          <div class="expense-card-left">
            <div class="expense-card-title">${escapeHtml(item.displayNameDe || item.name || 'Geöffnetes Produkt')}</div>
            <div class="expense-card-meta">${escapeHtml(metaBits.join(' • '))}</div>
          </div>
        </div>
        <div class="expense-card-right">
          <div class="expense-card-amount">-${fmtEuro(totCost)}</div>
          ${viewingFriend ? '' : `<div class="row-actions">
            <button type="button" class="action-btn" onclick="openExpenseModal('${item.id}')">Bearbeiten</button>
            <button type="button" class="action-btn delete" onclick="deleteItem('${item.id}')">✕</button>
          </div>`}
        </div>
      `;
      listEl.appendChild(card);
    }
    container.appendChild(listEl);
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
        totalValWithCost: 0,
        trackedCostCount: 0,
        totalQty: 0
      });
    }
    const g = groupsMap.get(setName);
    if (!g.code || g.code === 'SET' || g.code === 'BOX') {
      if (item.expansionCode) g.code = item.expansionCode;
    }
    const qty = Number(item.quantity) || 1;
    const uDe = getUnitDePrice(item);
    const hasCost = hasBuyPrice(item);
    const uBuy = hasCost ? Number(item.buyPrice) : 0;
    g.items.push(item);
    g.totalVal += uDe * qty;
    if (hasCost) {
      g.totalBuy += uBuy * qty;
      g.totalValWithCost += uDe * qty;
      g.trackedCostCount++;
    }
    g.totalQty += qty;
  }

  // Sort sets by total value descending
  const groups = Array.from(groupsMap.values()).sort((a, b) => b.totalVal - a.totalVal);

  for (const g of groups) {
    const setProfit = g.totalValWithCost - g.totalBuy;
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
        ${g.trackedCostCount > 0 ? `<span style="color:${profitColor}; font-weight:600;">${fmtSignedEuro(setProfit)}</span>` : ''}
        <span class="set-group-chevron">⌄</span>
      </div>
    `;
    headerEl.addEventListener('click', () => toggleSetCollapse(g.name));

    const gridEl = document.createElement('div');
    gridEl.className = 'set-cards-grid';

    for (const item of g.items) {
      const qty = Number(item.quantity) || 1;
      const uDe = getUnitDePrice(item);
      const hasCost = hasBuyPrice(item);
      const uBuy = hasCost ? Number(item.buyPrice) : null;
      const totVal = uDe * qty;
      const totBuy = hasCost ? uBuy * qty : null;
      const prof = hasCost ? totVal - totBuy : null;
      const profClass = prof == null ? 'neutral' : prof > 0.001 ? 'pos' : prof < -0.001 ? 'neg' : 'neutral';

      const effectiveImg = resolveItemImageUrl(item);
      const displayTitle = (item.displayNameDe || item.name).replace(/\[.*?\]/g, '').trim();
      const cardBadgeTxt = item.expansionCode || (item.type === 'sealed' ? 'BOX' : 'TCG');
      const condBadge = item.condition && item.condition !== 'NM' ? item.condition : '';
      const variantTxt = getVariantBadgeText(item);
      const metaTagParts = [variantTxt, item.isFirstEdition ? '1st Ed.' : '', condBadge].filter(Boolean);

      const cardEl = document.createElement('div');
      cardEl.className = `gallery-card${selectedChartItemId === item.id ? ' selected-card' : ''}`;

      cardEl.innerHTML = `
        <div class="gallery-card-visual">
          ${qty > 1 ? `<span class="gallery-qty-badge">${qty}x</span>` : ''}
          ${effectiveImg ? `<img src="${escapeHtml(effectiveImg)}" loading="lazy" alt="" data-id="${escapeHtml(item.idProduct || '')}" data-name="${escapeHtml(item.name)}" data-de="${escapeHtml(item.displayNameDe || '')}" data-type="${escapeHtml(item.type)}" data-tcgdex="${escapeHtml(item.tcgdexId || '')}" data-exp="${escapeHtml(item.expansionName || '')}" data-code="${escapeHtml(item.expansionCode || '')}" data-badge="${escapeHtml(cardBadgeTxt)}" onerror="handleCardImageError(this)" />` : `<span>${escapeHtml(cardBadgeTxt)}</span>`}
          <span class="gallery-price-pill">${fmtEuro(uDe)}</span>
        </div>
        <div class="gallery-card-footer">
          <div class="gallery-card-title" title="${escapeHtml(item.displayNameDe || item.name)}">${escapeHtml(displayTitle)}</div>
          ${metaTagParts.length ? `<div class="product-id" style="font-size:0.68rem;">${escapeHtml(metaTagParts.join(' • '))}</div>` : ''}
          <div class="gallery-card-profit-row">
            <span class="gallery-buy-txt">EK: ${hasCost ? fmtEuro(uBuy) : '—'}</span>
            <span class="gallery-profit-txt ${profClass}">${prof != null ? fmtSignedEuro(prof) : 'Kein EK'}</span>
          </div>
          ${viewingFriend ? '' : `<div class="gallery-card-actions" onclick="event.stopPropagation();">
            <button class="action-btn" onclick="openSnapshotModal('${item.id}')">DE €</button>
            <button class="action-btn" onclick="openEditModal('${item.id}')">Edit</button>
            <button class="action-btn delete" onclick="deleteItem('${item.id}')">✕</button>
            ${item.type === 'sealed' ? `<button type="button" class="action-btn open-sealed-btn" title="Aus Sealed-Bestand öffnen & unter Geöffnet verbuchen" onclick="markSealedAsOpened('${item.id}')">📦 Geöffnet</button>` : ''}
          </div>`}
        </div>
      `;

      cardEl.addEventListener('click', () => {
        selectedChartItemId = item.id;
        renderChart();
        document.querySelectorAll('.gallery-card.selected-card').forEach(el => el.classList.remove('selected-card'));
        cardEl.classList.add('selected-card');
        openCardZoomModal(item, cardEl.querySelector('.gallery-card-visual img'));
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
      const ekLabel = hasBuyPrice(found) ? fmtEuro(found.buyPrice) : '— (optional)';
      subtitleEl.textContent = `Aktueller Richtwert: ${fmtEuro(getUnitDePrice(found))} • Einkaufspreis: ${ekLabel}`;
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

  let sortedDates = Array.from(dateSet).sort();
  if (chartTimeframe !== 'all') {
    const days = Number(chartTimeframe) || 30;
    const cutoffStr = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    sortedDates = sortedDates.filter(d => d >= cutoffStr);
    if (!sortedDates.includes(cutoffStr)) {
      sortedDates.unshift(cutoffStr);
    }
  }

  const valSeries = [];
  const buySeries = [];

  for (const d of sortedDates) {
    let sumVal = 0;
    let sumBuy = 0;

    for (const item of itemsToPlot) {
      const qty = Number(item.quantity) || 1;
      const buyUnit = hasBuyPrice(item) ? Number(item.buyPrice) : 0;
      if (item.type === 'expense') {
        if (!item.buyDate || item.buyDate <= d || d === today) {
          sumBuy += buyUnit * qty;
        }
        continue;
      }
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

  if (valSeries.length >= 2) {
    const firstVal = valSeries[0];
    const lastVal = valSeries[valSeries.length - 1];
    const rangeDiff = lastVal - firstVal;
    const rangePct = firstVal > 0 ? (rangeDiff / firstVal) * 100 : 0;
    const rangeLabelMap = { '7': '7T', '14': '14T', '30': '30T', '90': '90T', '365': '1J', 'all': 'Gesamt' };
    const rLabel = rangeLabelMap[chartTimeframe] || 'Zeitraum';
    if (selectedChartItemId || chartTimeframe !== 'all') {
      subtitleEl.textContent += ` • ${rLabel}: ${fmtSignedEuro(rangeDiff)} (${fmtSignedPct(rangePct)})`;
    }
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
    // [idProduct, name, displayNameDe, type('s'|'c'), categoryName, expansionName, expansionCode, dePrice, low, trend, avg30, idCategory, tcgdexId, holoPrices?]
    const [idProduct, name, displayNameDe, shortType, categoryName, expansionName, expansionCode, dePrice, low, trend, avg30, idCategory, tcgdexId, holoRow] = row;
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

    const holoPrices = Array.isArray(holoRow)
      ? { dePrice: holoRow[0], low: holoRow[1], trend: holoRow[2], avg30: holoRow[3] }
      : null;

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
      prices: { dePrice, low, trend, avg30 },
      holoPrices,
      hasHolo: Boolean(holoPrices)
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

    // Group sibling printings (e.g., Normal / Full Art / SIR / Gold in the same set) sorted by idProduct
    const siblingGroups = new Map();
    for (const prod of items) {
      const k = `${String(prod.name || '').trim().toLowerCase()}::${String(prod.expansionName || '').trim().toLowerCase()}`;
      if (!siblingGroups.has(k)) siblingGroups.set(k, []);
      siblingGroups.get(k).push(Number(prod.idProduct));
    }
    for (const ids of siblingGroups.values()) {
      ids.sort((a, b) => a - b);
    }

    container.innerHTML = '';
    for (const prod of items) {
      const div = document.createElement('div');
      div.className = 'catalog-item';

      const k = `${String(prod.name || '').trim().toLowerCase()}::${String(prod.expansionName || '').trim().toLowerCase()}`;
      const sibIds = siblingGroups.get(k) || [];
      const sibIdx = sibIds.length > 1 ? sibIds.indexOf(Number(prod.idProduct)) : 0;
      const sibLabel = sibIds.length > 1 && sibIdx >= 0 ? ` • Variante ${sibIdx + 1}/${sibIds.length}` : '';

      const dePriceTxt = prod.prices?.dePrice != null ? fmtEuro(prod.prices.dePrice) : '—';
      const euLowTxt = prod.prices?.low != null ? fmtEuro(prod.prices.low) : '—';
      const imgUrl = prod.imageUrl || (isStaticMode ? `./images/${prod.idProduct}.jpg` : `/api/cm-image/${prod.idProduct}`);
      const setLabel = prod.expansionName ? `${escapeHtml(prod.expansionName)} • ` : '';
      const mainTitle = prod.displayNameDe || prod.name;
      const showOriginalSub = prod.displayNameDe && prod.displayNameDe !== prod.name;

      const setBadgeTxt = prod.expansionCode || (prod.type === 'sealed' ? 'BOX' : 'TCG');
      const holoTagTxt = prod.hasHolo && prod.holoPrices?.dePrice != null
        ? ` • Holo/Rev: ${fmtEuro(prod.holoPrices.dePrice)}`
        : '';
      div.innerHTML = `
        <div class="catalog-thumb">
          <img src="${escapeHtml(imgUrl)}" loading="lazy" alt="" data-id="${escapeHtml(prod.idProduct)}" data-name="${escapeHtml(prod.name)}" data-type="${escapeHtml(prod.type)}" data-tcgdex="${escapeHtml(prod.tcgdexId || '')}" data-exp="${escapeHtml(prod.expansionName || '')}" data-sidx="${sibIdx >= 0 ? sibIdx : 0}" data-badge="${escapeHtml(setBadgeTxt)}" onerror="handleCardImageError(this)" />
        </div>
        <div class="catalog-item-info">
          <div class="catalog-item-name">${escapeHtml(mainTitle)}</div>
          ${showOriginalSub ? `<div class="catalog-item-subname">${escapeHtml(prod.name)}</div>` : ''}
          <div class="catalog-item-meta">${setLabel}${escapeHtml(prod.categoryName)} (#${prod.idProduct})${escapeHtml(sibLabel)}</div>
          <div class="catalog-item-price-row">
            <span class="cm-de-tag">DE: ${dePriceTxt}${holoTagTxt}</span>
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
let currentModalPriceData = null;

function getSelectedPricesForVariant(priceData, isHolo) {
  if (!priceData) return {};
  if (isHolo && priceData.holoPrices && (priceData.holoPrices.dePrice != null || priceData.holoPrices.trend != null || priceData.holoPrices.low != null)) {
    return priceData.holoPrices;
  }
  return priceData.prices || {};
}

function updateModalLivePricePreview() {
  const pricesEl = document.getElementById('selectedCmPrices');
  if (!pricesEl) return;
  if (!currentModalPriceData) return;

  const variant = document.getElementById('formIsHolo').value;
  const isHolo = variant !== 'normal';
  const cond = document.getElementById('formCondition').value || 'NM';
  const isFirstEd = document.getElementById('formIsFirstEdition').value === 'true';
  const isSealed = document.getElementById('formType').value === 'sealed';
  const customRaw = document.getElementById('formCustomLowPrice').value;

  const activePrices = getSelectedPricesForVariant(currentModalPriceData, isHolo);
  const baseDe = activePrices.dePrice ?? activePrices.trend ?? activePrices.low ?? null;
  const euLow = activePrices.low ?? null;
  const condPrice = applyConditionPrice(baseDe, cond, isSealed);
  const hasSeparateHolo = Boolean(
    currentModalPriceData.hasHolo &&
    currentModalPriceData.holoPrices &&
    (currentModalPriceData.holoPrices.dePrice != null || currentModalPriceData.holoPrices.trend != null || currentModalPriceData.holoPrices.low != null)
  );

  const parts = [];
  if (customRaw !== '' && !Number.isNaN(Number(customRaw))) {
    parts.push(`Eigener Preis: <strong style="color:var(--text-main)">${fmtEuro(Number(customRaw))}</strong>`);
  } else if (condPrice != null) {
    const label = (!isSealed && cond !== 'NM') ? `Schätzwert (${cond})` : 'DE-Richtwert';
    parts.push(`${label}: <strong style="color:var(--text-main)">${fmtEuro(condPrice)}</strong>`);
  }
  if (baseDe != null && (!isSealed && cond !== 'NM')) {
    parts.push(`Basis (NM/Trend): ${fmtEuro(baseDe)}`);
  }
  if (euLow != null) {
    parts.push(`EU-Low: ${fmtEuro(euLow)}`);
  }
  if (isHolo) {
    parts.push(hasSeparateHolo ? '✓ Cardmarket Holo/Reverse-Kurs' : 'ℹ️ Kein separater Holo-Kurs in CM (Standard-Kurs)');
  }
  if (isFirstEd) {
    parts.push('1st Ed. (CM-Basis meist Unlimited)');
  }
  pricesEl.innerHTML = parts.join(' • ');
}

function selectCatalogProduct(prod) {
  lastSelectedCatalogProd = prod;
  currentModalPriceData = prod;
  const imgUrl = prod.imageUrl || (isStaticMode ? `./images/${prod.idProduct}.jpg` : `/api/cm-image/${prod.idProduct}`);
  const mainTitle = prod.displayNameDe || prod.name;

  document.getElementById('formIdProduct').value = prod.idProduct;
  document.getElementById('formName').value = mainTitle;
  document.getElementById('formType').value = prod.type;
  document.getElementById('formImageUrl').value = imgUrl;
  document.getElementById('formCardmarketUrl').value = prod.cardmarketUrl || '';

  const badge = document.getElementById('selectedCategoryBadge');
  const nameEl = document.getElementById('selectedProductName');
  const thumbEl = document.getElementById('selectedBannerThumb');
  const cmLink = document.getElementById('selectedDirectCmLink');
  const setBadgeTxt = prod.expansionCode || (prod.type === 'sealed' ? 'BOX' : 'TCG');

  thumbEl.innerHTML = `<img src="${escapeHtml(imgUrl)}" alt="" data-id="${escapeHtml(prod.idProduct)}" data-name="${escapeHtml(prod.name)}" data-type="${escapeHtml(prod.type)}" data-tcgdex="${escapeHtml(prod.tcgdexId || '')}" data-exp="${escapeHtml(prod.expansionName || '')}" data-badge="${escapeHtml(setBadgeTxt)}" onerror="handleCardImageError(this)" />`;
  badge.textContent = `${prod.type === 'sealed' ? 'Sealed' : 'Einzelkarte'} #${prod.idProduct}${prod.expansionName ? ' • ' + prod.expansionName : ''}`;
  nameEl.textContent = mainTitle;
  updateModalLivePricePreview();

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
  currentModalPriceData = null;
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
  document.getElementById('formIsHolo').value = 'normal';
  document.getElementById('formIsFirstEdition').value = 'false';
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

async function openEditModal(itemId) {
  const item = portfolioItems.find(i => i.id === itemId);
  if (!item) return;

  lastSelectedCatalogProd = null;
  currentModalPriceData = {
    idProduct: item.idProduct || null,
    type: item.type || 'single',
    prices: item.marketPrices || {},
    holoPrices: null,
    hasHolo: Boolean(item.marketPrices?.hasHoloPrices)
  };

  document.getElementById('modalTitle').textContent = 'Eintrag bearbeiten';
  document.getElementById('btnSaveItem').textContent = 'Änderungen speichern';
  document.getElementById('catalogSearchSection').classList.add('hidden');
  document.querySelector('.modal-split-body').classList.add('edit-only');
  document.querySelector('.modal').classList.remove('modal-wide');

  const initVariant = item.variant || (item.isHolo ? 'holo' : 'normal');
  document.getElementById('formEditId').value = item.id;
  document.getElementById('formIdProduct').value = item.idProduct || '';
  document.getElementById('formName').value = item.displayNameDe || item.name || '';
  document.getElementById('formType').value = item.type || 'single';
  document.getElementById('formIsHolo').value = initVariant;
  document.getElementById('formIsFirstEdition').value = item.isFirstEdition ? 'true' : 'false';
  document.getElementById('formBuyPrice').value = hasBuyPrice(item) ? item.buyPrice : '';
  document.getElementById('formQuantity').value = item.quantity ?? 1;
  document.getElementById('formCondition').value = item.condition || 'NM';
  document.getElementById('formLanguage').value = item.language || 'DE';
  document.getElementById('formBuyDate').value = item.buyDate || '';
  document.getElementById('formCustomLowPrice').value = item.customLowPrice != null ? item.customLowPrice : '';
  document.getElementById('formImageUrl').value = item.imageUrl || '';
  document.getElementById('formCardmarketUrl').value = item.cardmarketUrl || '';

  const editImg = resolveItemImageUrl(item);
  const editBadgeTxt = item.expansionCode || (item.type === 'sealed' ? 'BOX' : 'TCG');
  document.getElementById('selectedBannerThumb').innerHTML = editImg
    ? `<img src="${escapeHtml(editImg)}" alt="" data-id="${escapeHtml(item.idProduct || '')}" data-name="${escapeHtml(item.name)}" data-type="${escapeHtml(item.type)}" data-tcgdex="${escapeHtml(item.tcgdexId || '')}" data-exp="${escapeHtml(item.expansionName || '')}" data-badge="${escapeHtml(editBadgeTxt)}" onerror="handleCardImageError(this)" />`
    : editBadgeTxt;
  document.getElementById('selectedCategoryBadge').textContent = item.idProduct ? `Cardmarket #${item.idProduct}` : 'Manuell';
  document.getElementById('selectedProductName').textContent = item.displayNameDe || item.name;
  updateModalLivePricePreview();

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

  // Load full catalog entry (both standard + holo prices) so live variant switching works during Edit too
  if (item.idProduct) {
    try {
      if (isStaticMode) {
        const list = await ensureStaticCatalogLoaded();
        const row = list.find(r => Number(r[0]) === Number(item.idProduct));
        if (row) {
          const [, , , , , , , dePrice, low, trend, avg30, , , holoRow] = row;
          currentModalPriceData = {
            idProduct: item.idProduct,
            type: item.type || 'single',
            prices: { dePrice, low, trend, avg30 },
            holoPrices: Array.isArray(holoRow) ? { dePrice: holoRow[0], low: holoRow[1], trend: holoRow[2], avg30: holoRow[3] } : null,
            hasHolo: Array.isArray(holoRow)
          };
          updateModalLivePricePreview();
        }
      } else {
        const res = await fetch(`/api/search?q=${encodeURIComponent(item.idProduct)}&type=all`);
        const data = await res.json();
        const found = (data.results || []).find(r => Number(r.idProduct) === Number(item.idProduct));
        if (found) {
          currentModalPriceData = found;
          updateModalLivePricePreview();
        }
      }
    } catch (e) {}
  }
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
    if (isStaticMode && profileMode === 'owner' && !String(itemId).startsWith('mobile_')) {
      addDeletedOwnerId(itemId);
    }
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

let adminLoginNextAction = 'friends';

function openAdminLoginModal(nextAction = 'friends') {
  adminLoginNextAction = nextAction || 'friends';
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
        if (hasBuyPrice(it)) {
          totalBuy += Number(it.buyPrice) * qty;
        }
        if (it.type !== 'expense') {
          totalVal += getUnitDePrice(it) * qty;
          totalQty += qty;
        }
      }
      const profit = totalBuy > 0 ? totalVal - totalBuy : 0;
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

function openCardZoomModal(item, sourceImgEl = null) {
  if (!item) return;
  const modal = document.getElementById('cardZoomModal');
  if (!modal) return;

  const displayTitle = item.displayNameDe || item.name || 'Produkt';
  document.getElementById('cardZoomTitle').textContent = displayTitle.replace(/\[.*?\]/g, '').trim();
  const subParts = [];
  if (item.expansionName) subParts.push(item.expansionName);
  if (item.idProduct) subParts.push(`#${item.idProduct}`);
  document.getElementById('cardZoomSubtitle').textContent = subParts.join(' • ');

  // Badges
  const badgesEl = document.getElementById('cardZoomBadges');
  const variantTxt = getVariantBadgeText(item);
  const badgeHtml = [
    `<span class="badge ${item.type === 'sealed' ? 'badge-sealed' : 'badge-single'}">${item.type === 'sealed' ? 'Sealed' : 'Karte'}</span>`,
    variantTxt ? `<span class="badge">${escapeHtml(variantTxt)}</span>` : '',
    item.isFirstEdition ? `<span class="badge badge-sealed">1st Edition</span>` : '',
    `<span class="badge badge-meta">${escapeHtml(item.condition || 'NM')} • ${escapeHtml(item.language || 'DE')}</span>`,
    `<span class="badge badge-meta">${Number(item.quantity) || 1}x</span>`
  ].filter(Boolean).join('');
  badgesEl.innerHTML = badgeHtml;

  // Prices
  const qty = Number(item.quantity) || 1;
  const uDe = getUnitDePrice(item);
  const hasCost = hasBuyPrice(item);
  const uBuy = hasCost ? Number(item.buyPrice) : null;
  const prof = hasCost ? (uDe - uBuy) * qty : null;
  const profColor = prof == null ? 'var(--text-muted)' : prof >= 0 ? 'var(--green)' : 'var(--red)';

  document.getElementById('cardZoomPrices').innerHTML = `
    <div>
      <div class="card-zoom-stat-label">DE Richtwert</div>
      <div class="card-zoom-stat-val">${fmtEuro(uDe)}</div>
    </div>
    <div>
      <div class="card-zoom-stat-label">Einkaufspreis</div>
      <div class="card-zoom-stat-val">${hasCost ? fmtEuro(uBuy) : '—'}</div>
    </div>
    <div>
      <div class="card-zoom-stat-label">Ergebnis</div>
      <div class="card-zoom-stat-val" style="color:${profColor};">${prof != null ? fmtSignedEuro(prof) : 'Kein EK'}</div>
    </div>
  `;

  // Links & Chart button
  const cmLink = document.getElementById('cardZoomCmLink');
  if (item.cardmarketUrl) {
    cmLink.href = item.cardmarketUrl.includes('language=') ? item.cardmarketUrl : `${item.cardmarketUrl}&language=3`;
    cmLink.classList.remove('hidden');
  } else {
    cmLink.classList.add('hidden');
  }

  const zoomOpenSealedBtn = document.getElementById('btnCardZoomOpenSealed');
  if (zoomOpenSealedBtn) {
    const canOpenSealed = item.type === 'sealed' && !viewingFriend && item.id && portfolioItems.some(p => p.id === item.id);
    if (canOpenSealed) {
      zoomOpenSealedBtn.classList.remove('hidden');
      zoomOpenSealedBtn.onclick = () => {
        closeCardZoomModal();
        markSealedAsOpened(item.id);
      };
    } else {
      zoomOpenSealedBtn.classList.add('hidden');
      zoomOpenSealedBtn.onclick = null;
    }
  }

  const chartBtn = document.getElementById('btnCardZoomChart');
  chartBtn.onclick = () => {
    closeCardZoomModal();
    selectedChartItemId = item.id;
    renderTable();
    renderChart();
    document.querySelector('.chart-section')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };

  // High-res Image (upgrade TCGdex /low.webp -> /high.webp with clean fallback to low/original)
  const imgWrap = document.getElementById('cardZoomImageWrap');
  const badgeTxt = item.expansionCode || (item.type === 'sealed' ? 'BOX' : 'TCG');
  let rawSrc = (sourceImgEl && sourceImgEl.getAttribute('src')) ? sourceImgEl.src : resolveItemImageUrl(item);
  if (rawSrc) {
    const isTcgdexLow = rawSrc.includes('assets.tcgdex.net') && rawSrc.endsWith('/low.webp');
    const initialSrc = isTcgdexLow ? rawSrc.replace(/\/low\.webp$/, '/high.webp') : rawSrc;
    imgWrap.innerHTML = `<img src="${escapeHtml(initialSrc)}" alt="${escapeHtml(displayTitle)}" />`;
    const zoomImg = imgWrap.querySelector('img');
    zoomImg.onerror = () => {
      if (isTcgdexLow && zoomImg.src.endsWith('/high.webp')) {
        zoomImg.src = rawSrc;
        return;
      }
      zoomImg.dataset.id = item.idProduct || '';
      zoomImg.dataset.name = item.name || '';
      zoomImg.dataset.de = item.displayNameDe || '';
      zoomImg.dataset.type = item.type || 'single';
      zoomImg.dataset.tcgdex = item.tcgdexId || '';
      zoomImg.dataset.exp = item.expansionName || '';
      zoomImg.dataset.code = item.expansionCode || '';
      zoomImg.dataset.badge = badgeTxt;
      handleCardImageError(zoomImg);
    };
  } else {
    imgWrap.textContent = badgeTxt;
  }

  modal.classList.remove('hidden');
}

function closeCardZoomModal() {
  const modal = document.getElementById('cardZoomModal');
  if (modal) modal.classList.add('hidden');
}

function updateExpensePerPackHelp() {
  const helpEl = document.getElementById('expensePerPackHelp');
  if (!helpEl) return;
  const cost = Number(document.getElementById('expenseCost').value) || 0;
  const packs = Math.max(1, Number(document.getElementById('expensePacksCount').value) || 1);
  if (cost > 0) {
    helpEl.textContent = `Ø Preis/Pack: ${fmtEuro(cost / packs)}`;
  } else {
    helpEl.textContent = 'Ø Preis/Pack: —';
  }
}

function guessExpensePresetForSealed(item) {
  const txt = `${item?.displayNameDe || ''} ${item?.name || ''} ${item?.categoryName || ''}`.toLowerCase();
  if (/booster\s*pack|\b1\s*pack\b|sleeved/.test(txt) && !/bundle|box|display|tin/.test(txt)) {
    return { preset: 'booster', packs: 1 };
  }
  if (/top[-\s]*trainer|ttb|etb|elite\s*trainer/.test(txt)) {
    return { preset: 'ttb', packs: 9 };
  }
  if (/bundle|\b6\s*pack/.test(txt)) {
    return { preset: 'bundle', packs: 6 };
  }
  if (/tin|\bmini\s*tin\b|blister|collection|kollektion/.test(txt)) {
    return { preset: 'bundle', packs: 4 };
  }
  if (/display|booster\s*box|\b36\b/.test(txt)) {
    return { preset: 'display', packs: 36 };
  }
  return { preset: 'display', packs: 36 };
}

function populateExpenseSetSuggestionsLazy() {
  const dl = document.getElementById('expenseSetSuggestions');
  if (!dl || dl.options.length > 0) return;
  ensureSetsIndexLoaded().then(list => {
    if (!Array.isArray(list) || dl.options.length > 0) return;
    const frag = document.createDocumentFragment();
    for (const s of list.slice(0, 60)) {
      const label = s.de || s.en || '';
      if (!label) continue;
      for (const suffix of ['Display (36 Packs)', 'Top-Trainer-Box (TTB)']) {
        const opt = document.createElement('option');
        opt.value = `${label} ${suffix}`;
        frag.appendChild(opt);
      }
    }
    dl.appendChild(frag);
  }).catch(() => {});
}

function markSealedAsOpened(itemId) {
  if (viewingFriend || !itemId) return;
  const item = portfolioItems.find(i => i.id === itemId && i.type === 'sealed');
  if (!item) return;

  const modal = document.getElementById('expenseModal');
  const delBtn = document.getElementById('btnDeleteExpense');
  const titleEl = document.getElementById('expenseModalTitle');
  const subEl = document.getElementById('expenseModalSub');
  const saveBtn = document.getElementById('btnSaveExpense');
  const qtyEl = document.getElementById('expenseQuantity');
  const today = new Date().toISOString().slice(0, 10);

  const sealedQty = Math.max(1, Number(item.quantity) || 1);
  const guess = guessExpensePresetForSealed(item);
  const defaultCost = hasBuyPrice(item) ? Number(item.buyPrice) : Number((getUnitDePrice(item) || 0).toFixed(2));

  document.querySelectorAll('#expenseModal .expense-preset-pills .pill').forEach(p => p.classList.remove('active'));
  document.querySelector(`#expenseModal .expense-preset-pills .pill[data-preset="${guess.preset}"]`)?.classList.add('active');

  titleEl.textContent = 'Sealed-Produkt öffnen';
  if (subEl) {
    subEl.textContent = sealedQty > 1
      ? `Bestand im Sealed-Portfolio: ${sealedQty}x → gewählte Anzahl wird abgezogen & zu „Geöffnet“ verschoben`
      : 'Wird aus deinem Sealed-Bestand entfernt und automatisch zu „Geöffnet“ verschoben';
  }
  saveBtn.textContent = '📦 Als geöffnet verschieben';

  document.getElementById('expenseEditId').value = '';
  document.getElementById('expenseSourceSealedId').value = item.id;
  document.getElementById('expenseName').value = (item.displayNameDe || item.name || '').replace(/\[.*?\]/g, '').trim();
  document.getElementById('expenseCost').value = defaultCost;
  document.getElementById('expensePacksCount').value = guess.packs;
  qtyEl.value = '1';
  qtyEl.max = String(sealedQty);
  document.getElementById('expenseDate').value = today;
  document.getElementById('expenseNotes').value = item.notes || '';
  delBtn.classList.add('hidden');
  delBtn.onclick = null;

  updateExpensePerPackHelp();
  modal.classList.remove('hidden');
  populateExpenseSetSuggestionsLazy();
}

function openExpenseModal(editItemId = null) {
  const modal = document.getElementById('expenseModal');
  const delBtn = document.getElementById('btnDeleteExpense');
  const titleEl = document.getElementById('expenseModalTitle');
  const subEl = document.getElementById('expenseModalSub');
  const saveBtn = document.getElementById('btnSaveExpense');
  const qtyEl = document.getElementById('expenseQuantity');
  const today = new Date().toISOString().slice(0, 10);

  let item = null;
  if (editItemId) {
    item = portfolioItems.find(i => i.id === editItemId);
  }

  document.getElementById('expenseSourceSealedId').value = '';
  qtyEl.removeAttribute('max');
  if (subEl) {
    subEl.textContent = 'Zählt als Ausgabe ins Gesamt-Ergebnis, ohne dass noch Sealed-Wert dazugerechnet wird';
  }
  document.querySelectorAll('#expenseModal .expense-preset-pills .pill').forEach(p => p.classList.remove('active'));

  if (item) {
    titleEl.textContent = 'Geöffnetes Produkt bearbeiten';
    saveBtn.textContent = 'Änderungen speichern';
    document.getElementById('expenseEditId').value = item.id;
    document.getElementById('expenseName').value = item.displayNameDe || item.name || '';
    document.getElementById('expenseCost').value = item.buyPrice ?? '';
    document.getElementById('expensePacksCount').value = item.packsCount || 36;
    qtyEl.value = item.quantity || 1;
    document.getElementById('expenseDate').value = item.buyDate || today;
    document.getElementById('expenseNotes').value = item.notes || '';
    const presetKey = item.expensePreset || 'display';
    document.querySelector(`#expenseModal .expense-preset-pills .pill[data-preset="${presetKey}"]`)?.classList.add('active');
    delBtn.classList.remove('hidden');
    delBtn.onclick = async () => {
      closeExpenseModal();
      await deleteItem(item.id);
    };
  } else {
    titleEl.textContent = 'Geöffnetes Display / TTB eintragen';
    saveBtn.textContent = 'Ausgabe speichern';
    document.getElementById('expenseEditId').value = '';
    document.getElementById('expenseName').value = '';
    document.getElementById('expenseCost').value = '';
    document.getElementById('expensePacksCount').value = '36';
    qtyEl.value = '1';
    document.getElementById('expenseDate').value = today;
    document.getElementById('expenseNotes').value = '';
    document.querySelector('#expenseModal .expense-preset-pills .pill[data-preset="display"]')?.classList.add('active');
    delBtn.classList.add('hidden');
  }

  updateExpensePerPackHelp();
  modal.classList.remove('hidden');
  setTimeout(() => document.getElementById('expenseName').focus(), 50);
  populateExpenseSetSuggestionsLazy();
}

function closeExpenseModal() {
  document.getElementById('expenseModal')?.classList.add('hidden');
}

function getChecklistStorageKey() {
  if (viewingFriend?.id) return `${CHECKLIST_STORAGE_PREFIX}friend_${viewingFriend.id}`;
  if (profileMode === 'personal') return `${CHECKLIST_STORAGE_PREFIX}personal_${personalProfileId || 'default'}`;
  return `${CHECKLIST_STORAGE_PREFIX}owner`;
}

function loadChecklistOwnedMap() {
  try {
    const parsed = JSON.parse(localStorage.getItem(getChecklistStorageKey()) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (e) {
    return {};
  }
}

function getChecklistSavedAtMs() {
  try {
    return Number(localStorage.getItem(CHECKLIST_SAVED_AT_KEY)) || 0;
  } catch (e) {
    return 0;
  }
}

function saveChecklistOwnedMap(mapObj, skipCloudPush = false) {
  try {
    localStorage.setItem(getChecklistStorageKey(), JSON.stringify(mapObj));
    localStorage.setItem(CHECKLIST_SAVED_AT_KEY, String(Date.now()));
  } catch (e) {}
  if (!skipCloudPush && profileMode === 'owner' && isAdminMode && !viewingFriend) {
    pushOwnerCloudVaultNow();
  }
}

function mergeChecklistWithCloud(cloudVault) {
  const localChk = loadChecklistOwnedMap();
  const cloudChk = (cloudVault && cloudVault.checklists && typeof cloudVault.checklists === 'object')
    ? cloudVault.checklists
    : {};
  const cloudUpdatedMs = cloudVault?.updated_at ? Date.parse(cloudVault.updated_at) : 0;
  const localSavedAtMs = getChecklistSavedAtMs();
  const cloudWins = cloudUpdatedMs > localSavedAtMs;

  const allSetKeys = new Set([...Object.keys(cloudChk), ...Object.keys(localChk)]);
  const merged = {};
  for (const sk of allSetKeys) {
    const cBucket = (cloudChk[sk] && typeof cloudChk[sk] === 'object') ? cloudChk[sk] : {};
    const lBucket = (localChk[sk] && typeof localChk[sk] === 'object') ? localChk[sk] : {};
    merged[sk] = cloudWins ? { ...lBucket, ...cBucket } : { ...cBucket, ...lBucket };
  }

  try {
    localStorage.setItem(getChecklistStorageKey(), JSON.stringify(merged));
    if (cloudWins && cloudUpdatedMs > 0) {
      localStorage.setItem(CHECKLIST_SAVED_AT_KEY, String(cloudUpdatedMs));
    }
  } catch (e) {}

  const needsPush = Object.keys(localChk).length > 0 &&
    JSON.stringify(merged) !== JSON.stringify(cloudChk);
  return { merged, needsPush };
}

let lastCloudLiveCheckMs = 0;
async function syncOwnerChecklistsFromCloud() {
  if (profileMode !== 'owner' || !isAdminMode || viewingFriend) return;
  const now = Date.now();
  if (now - lastCloudLiveCheckMs < 2500) return;
  lastCloudLiveCheckMs = now;

  const token = await getValidAdminAccessToken();
  if (!token) return;
  const cloudVault = await fetchOwnerCloudVault(token);
  if (!cloudVault) return;

  const { needsPush } = mergeChecklistWithCloud(cloudVault);
  if (needsPush) {
    await pushOwnerCloudVaultNow();
  }
  if (activeMainPage === 'sets' && currentChecklistData) {
    renderChecklistView();
  }
}

async function ensureSetsIndexLoaded() {
  if (setsIndexList) return setsIndexList;
  if (setsIndexPromise) return setsIndexPromise;
  setsIndexPromise = fetch('./data/sets_index.json')
    .then(r => (r.ok ? r.json() : []))
    .then(arr => {
      setsIndexList = Array.isArray(arr) ? arr : [];
      return setsIndexList;
    })
    .catch(() => []);
  return setsIndexPromise;
}

function renderFeaturedSetsStrip() {
  const strip = document.getElementById('featuredSetsStrip');
  if (!strip) return;
  strip.innerHTML = '';
  for (const fsItem of FEATURED_CHECKLIST_SETS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `featured-set-chip${selectedChecklistSetId === fsItem.id ? ' active' : ''}`;
    btn.textContent = fsItem.label;
    btn.addEventListener('click', () => loadChecklistSet(fsItem.id));
    strip.appendChild(btn);
  }
}

function populateSetPickerSelect(filterText = '') {
  const selectEl = document.getElementById('setPickerSelect');
  if (!selectEl || !Array.isArray(setsIndexList)) return;
  const q = filterText.trim().toLowerCase();
  const filtered = q
    ? setsIndexList.filter(s => `${s.de} ${s.en} ${s.code} ${s.tcgdexId}`.toLowerCase().includes(q))
    : setsIndexList;

  selectEl.innerHTML = '';
  if (filtered.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'Kein Set gefunden';
    selectEl.appendChild(opt);
    return;
  }

  for (const s of filtered) {
    const opt = document.createElement('option');
    opt.value = s.tcgdexId;
    const label = s.de && s.de !== s.en ? `${s.de} (${s.en})` : (s.de || s.en);
    opt.textContent = s.code ? `${s.code} • ${label}` : label;
    if (s.tcgdexId === selectedChecklistSetId) opt.selected = true;
    selectEl.appendChild(opt);
  }
}

function normalizeCardMatchName(str) {
  return String(str || '')
    .toLowerCase()
    .replace(/δ/g, '')
    .replace(/\bdelta\s*species\b/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function getSetScopedCatalogSiblings(idProduct, rawCatalogName, setInfo) {
  if (!idProduct || !rawCatalogName || !Array.isArray(staticCatalogItems)) return [];
  const normRaw = String(rawCatalogName).trim().toLowerCase();
  const targetCode = String(setInfo?.code || '').trim().toUpperCase();
  const targetEn = String(setInfo?.en || '').trim().toLowerCase();
  const targetDe = String(setInfo?.de || '').trim().toLowerCase();
  const ids = [];

  for (let i = 0; i < staticCatalogItems.length; i++) {
    const row = staticCatalogItems[i];
    if (String(row[1] || '').trim().toLowerCase() !== normRaw) continue;
    const rowCode = String(row[6] || '').trim().toUpperCase();
    const rowExp = String(row[5] || '').trim().toLowerCase();
    const setOk =
      (targetCode && rowCode === targetCode) ||
      (targetEn && rowExp === targetEn) ||
      (targetDe && rowExp === targetDe);
    if (!setOk) continue;
    ids.push(Number(row[0]));
  }
  ids.sort((a, b) => a - b);
  return ids;
}

function extractCatalogRowMarketData(row) {
  if (!Array.isArray(row)) return { marketEur: null, marketPrices: {} };
  const dePrice = row[7] ?? null;
  const low = row[8] ?? null;
  const trend = row[9] ?? null;
  const avg30 = row[10] ?? null;
  const unitEur = dePrice ?? trend ?? low ?? null;
  return {
    marketEur: unitEur != null && !Number.isNaN(Number(unitEur)) ? Number(unitEur) : null,
    marketPrices: {
      dePrice,
      low,
      trend,
      avg30,
      hasHoloPrices: Array.isArray(row[13])
    }
  };
}

function getChecklistCardDisplayPrice(card, matchedItems) {
  if (Array.isArray(matchedItems) && matchedItems.length > 0) {
    let best = null;
    for (const it of matchedItems) {
      const p = getUnitDePrice(it);
      if (p != null && !Number.isNaN(Number(p)) && (best === null || Number(p) > best)) {
        best = Number(p);
      }
    }
    if (best !== null && best > 0) return best;
  }
  return card?.marketEur != null ? Number(card.marketEur) : null;
}

function buildPortfolioMatchedCardMapForSet(cards, setInfo) {
  const matchedMap = new Map();
  if (!Array.isArray(cards) || cards.length === 0) return matchedMap;

  const addMatch = (key, item) => {
    if (!key) return;
    if (!matchedMap.has(key)) matchedMap.set(key, []);
    matchedMap.get(key).push(item);
  };

  const catalogById = new Map();
  if (Array.isArray(staticCatalogItems)) {
    for (let i = 0; i < staticCatalogItems.length; i++) {
      catalogById.set(Number(staticCatalogItems[i][0]), staticCatalogItems[i]);
    }
  }

  for (const item of portfolioItems) {
    if (!item || item.type === 'expense' || item.type === 'sealed') continue;
    const itemExpMatch =
      (item.tcgdexId && setInfo?.tcgdexId && item.tcgdexId === setInfo.tcgdexId) ||
      (item.expansionCode && setInfo?.code && item.expansionCode.toUpperCase() === setInfo.code.toUpperCase()) ||
      (item.expansionName && setInfo &&
        (item.expansionName.toLowerCase() === (setInfo.de || '').toLowerCase() ||
         item.expansionName.toLowerCase() === (setInfo.en || '').toLowerCase()));
    if (!itemExpMatch) continue;

    // 1. Direct idProduct match (for fallback catalog-built checklists)
    const directCard = item.idProduct ? cards.find(c => c.idProduct && Number(c.idProduct) === Number(item.idProduct)) : null;
    if (directCard) {
      addMatch(directCard.key, item);
      continue;
    }

    // 2. Resolve true Cardmarket raw EN name via staticCatalogItems so "DE – EN" prefix never breaks matching
    const catRow = item.idProduct ? catalogById.get(Number(item.idProduct)) : null;
    const rawEnSource = catRow ? catRow[1] : item.name;
    const itemEnHints = parseCardmarketHints(rawEnSource);
    const itemEnCands = itemEnHints.nameCandidates.map(normalizeCardMatchName).filter(Boolean);

    const rawDeFirst = String(item.displayNameDe || '').split(' – ')[0].replace(/\(.*?\)/g, '').replace(/\[.*?\]/g, '').trim();
    const itemDeNorm = normalizeCardMatchName(rawDeFirst);

    const matchingCards = cards.filter(c => {
      const cEnNorm = normalizeCardMatchName(c.enName || c.name);
      const cDeNorm = normalizeCardMatchName(c.deName || '');
      if (cEnNorm && itemEnCands.includes(cEnNorm)) return true;
      if (cDeNorm && itemDeNorm && cDeNorm === itemDeNorm) return true;
      return false;
    });

    if (matchingCards.length === 0) continue;
    if (matchingCards.length === 1) {
      addMatch(matchingCards[0].key, item);
      continue;
    }

    // 3. Disambiguate multiple rarities/artworks of the same card in the set using Cardmarket idProduct sibling order
    let chosenIdx = 0;
    if (item.idProduct && catRow) {
      const sibIds = getSetScopedCatalogSiblings(item.idProduct, catRow[1], setInfo);
      const sibIdx = sibIds.indexOf(Number(item.idProduct));
      if (sibIdx >= 0 && sibIds.length > 1) {
        if (sibIds.length === matchingCards.length) {
          chosenIdx = sibIdx;
        } else {
          chosenIdx = Math.round((sibIdx / (sibIds.length - 1)) * (matchingCards.length - 1));
        }
      }
    } else if (itemEnHints.variantIndex && itemEnHints.variantIndex >= 1) {
      chosenIdx = Math.min(itemEnHints.variantIndex - 1, matchingCards.length - 1);
    }

    const picked = matchingCards[Math.min(Math.max(0, chosenIdx), matchingCards.length - 1)];
    if (picked) addMatch(picked.key, item);
  }

  return matchedMap;
}

function buildPortfolioMatchedCardKeysForSet(cards, setInfo) {
  return new Set(buildPortfolioMatchedCardMapForSet(cards, setInfo).keys());
}

function getChecklistCardOwnedState(tcgdexId, card, ownedMap, portfolioMatchedKeys) {
  const setBucket = ownedMap[tcgdexId] || {};
  if (Object.prototype.hasOwnProperty.call(setBucket, card.key)) {
    return Boolean(setBucket[card.key]);
  }
  return portfolioMatchedKeys.has(card.key);
}

async function addChecklistCardToPortfolio(card, setInfo, tcgdexId) {
  if (viewingFriend || !card) return;
  const now = new Date();
  const today = now.toISOString().slice(0, 10);

  // Resolve matching catalog item (with live Cardmarket DE price) if available
  let matchedRow = null;
  try {
    const list = await ensureStaticCatalogLoaded();
    if (card.idProduct) {
      matchedRow = list.find(r => Number(r[0]) === Number(card.idProduct)) || null;
    }
    if (!matchedRow) {
      const targetCode = String(setInfo?.code || '').trim().toUpperCase();
      const targetEn = String(setInfo?.en || '').trim().toLowerCase();
      const targetDe = String(setInfo?.de || '').trim().toLowerCase();
      const cardEnNorm = normalizeCardMatchName(card.enName || card.name);
      const matches = list.filter(r => {
        if (r[3] !== 'c') return false;
        const setOk =
          r[12] === tcgdexId ||
          (targetCode && String(r[6] || '').toUpperCase() === targetCode) ||
          (targetEn && String(r[5] || '').toLowerCase() === targetEn) ||
          (targetDe && String(r[5] || '').toLowerCase() === targetDe);
        if (!setOk) return false;
        const clean = parseCardmarketHints(r[1]).cleanName;
        return normalizeCardMatchName(clean) === cardEnNorm;
      }).sort((a, b) => Number(a[0]) - Number(b[0]));
      if (matches.length > 0) {
        matchedRow = matches[Math.min(card.siblingIdx || 0, matches.length - 1)];
      }
    }
  } catch (e) {}

  const idProduct = matchedRow ? Number(matchedRow[0]) : (card.idProduct || null);
  const rawName = matchedRow ? matchedRow[1] : (card.enName || card.name);
  const displayNameDe = (matchedRow && matchedRow[2]) ? matchedRow[2] : (card.deName || card.name);
  const dePrice = matchedRow ? (matchedRow[7] ?? matchedRow[9] ?? matchedRow[8] ?? null) : null;
  const low = matchedRow ? (matchedRow[8] ?? null) : null;
  const trend = matchedRow ? (matchedRow[9] ?? dePrice ?? null) : null;
  const avg30 = matchedRow ? (matchedRow[10] ?? trend ?? null) : null;
  const holoRow = matchedRow && Array.isArray(matchedRow[13]) ? matchedRow[13] : null;

  if (!isStaticMode && profileMode === 'owner') {
    await fetch('/api/portfolio', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        idProduct,
        name: displayNameDe,
        type: 'single',
        variant: 'normal',
        isHolo: false,
        isFirstEdition: false,
        buyPrice: null,
        quantity: 1,
        condition: 'NM',
        language: card.deName ? 'DE' : 'EN',
        buyDate: today,
        imageUrl: idProduct ? `/api/cm-image/${idProduct}` : (card.imageHigh || card.imageLow || ''),
        cardmarketUrl: `https://www.cardmarket.com/de/Pokemon/Products/Search?searchString=${encodeURIComponent(rawName)}&language=3`
      })
    });
    await fetchPortfolio();
  } else {
    const eff = dePrice ?? trend ?? low ?? 0;
    const hist = [];
    const d30 = new Date(now.getTime() - 30 * 86400000).toISOString().slice(0, 10);
    const d7 = new Date(now.getTime() - 7 * 86400000).toISOString().slice(0, 10);
    if ((avg30 ?? eff) > 0) hist.push({ date: d30, low: Number((avg30 ?? eff).toFixed(2)), trend: Number((trend ?? eff).toFixed(2)), label: '30T Ø' });
    if ((trend ?? eff) > 0) hist.push({ date: d7, low: Number((trend ?? eff).toFixed(2)), trend: Number((trend ?? eff).toFixed(2)), label: '7T Ø' });
    if (eff > 0) hist.push({ date: today, low: Number(eff.toFixed(2)), trend: Number((trend ?? eff).toFixed(2)), label: 'Heute' });

    portfolioItems.unshift({
      id: 'mobile_' + Date.now() + '_' + Math.random().toString(36).slice(2, 5),
      idProduct,
      name: rawName,
      displayNameDe,
      type: 'single',
      categoryName: 'Pokémon Single',
      expansionName: setInfo?.de || setInfo?.en || '',
      expansionCode: setInfo?.code || '',
      tcgdexId: tcgdexId || '',
      variant: 'normal',
      isHolo: false,
      isFirstEdition: false,
      condition: 'NM',
      language: card.deName ? 'DE' : 'EN',
      quantity: 1,
      buyPrice: null,
      buyDate: today,
      customLowPrice: null,
      imageUrl: idProduct ? `./images/${idProduct}.jpg` : (card.imageLow || ''),
      fallbackImageUrl: card.imageLow || '',
      cardmarketUrl: `https://www.cardmarket.com/de/Pokemon/Products/Search?searchString=${encodeURIComponent(rawName)}&language=3`,
      marketPrices: {
        dePrice,
        low,
        trend,
        avg30,
        hasHoloPrices: Boolean(holoRow),
        updatedAt: today
      },
      priceHistory: hist,
      createdAt: now.toISOString()
    });
    saveLocalPortfolio();
  }

  // Also ensure card is marked owned in checklist
  const ownedMap = loadChecklistOwnedMap();
  if (!ownedMap[tcgdexId] || typeof ownedMap[tcgdexId] !== 'object') ownedMap[tcgdexId] = {};
  ownedMap[tcgdexId][card.key] = true;
  saveChecklistOwnedMap(ownedMap);
  renderAll();

  const priceInfo = dePrice != null ? ` (${fmtEuro(dePrice)})` : '';
  showToast(`„${card.name}“ ins Portfolio übernommen${priceInfo}`);
}

function toggleChecklistCardOwned(tcgdexId, cardKey, card, portfolioMatchedKeys) {
  const ownedMap = loadChecklistOwnedMap();
  if (!ownedMap[tcgdexId] || typeof ownedMap[tcgdexId] !== 'object') {
    ownedMap[tcgdexId] = {};
  }
  const currentlyOwned = getChecklistCardOwnedState(tcgdexId, card, ownedMap, portfolioMatchedKeys);
  ownedMap[tcgdexId][cardKey] = !currentlyOwned;
  saveChecklistOwnedMap(ownedMap);
  renderChecklistView();
  if (profileMode === 'owner' && isAdminMode && !getAdminSession()?.access_token && !toggleChecklistCardOwned._warned) {
    toggleChecklistCardOwned._warned = true;
    showToast('Tipp: Oben als Admin anmelden, damit die Checkliste auch auf dem PC synct.');
  }
}

async function fetchTcgdexSetDe(tcgdexId) {
  if (!tcgdexId) return null;
  try {
    const r = await fetch(`https://api.tcgdex.net/v2/de/sets/${encodeURIComponent(tcgdexId)}`);
    return r.ok ? await r.json() : null;
  } catch (e) {
    return null;
  }
}

async function loadChecklistSet(tcgdexId) {
  if (!tcgdexId) return;
  selectedChecklistSetId = tcgdexId;
  try { localStorage.setItem(CHECKLIST_LAST_SET_KEY, tcgdexId); } catch (e) {}

  renderFeaturedSetsStrip();
  const selectEl = document.getElementById('setPickerSelect');
  if (selectEl && selectEl.value !== tcgdexId) {
    const hasOpt = Array.from(selectEl.options).some(o => o.value === tcgdexId);
    if (hasOpt) selectEl.value = tcgdexId;
  }

  const list = await ensureSetsIndexLoaded();
  const setInfo = list.find(s => s.tcgdexId === tcgdexId) || { tcgdexId, en: tcgdexId, de: tcgdexId, code: '' };

  document.getElementById('checklistSetTitle').textContent = setInfo.de || setInfo.en || tcgdexId;
  document.getElementById('checklistSetCode').textContent = setInfo.code || tcgdexId.toUpperCase();
  document.getElementById('checklistSetSubtitle').textContent = 'Lade Kartenliste...';
  document.getElementById('checklistSetLogo').innerHTML = escapeHtml(setInfo.code || 'SET');
  document.getElementById('checklistGrid').innerHTML = `<div class="search-hint">Lade Karten für „${escapeHtml(setInfo.de || setInfo.en)}“...</div>`;

  const [enSet, deSet] = await Promise.all([
    fetchTcgdexSet(tcgdexId),
    fetchTcgdexSetDe(tcgdexId),
    ensureStaticCatalogLoaded().catch(() => null)
  ]);

  let cards = [];
  let logoUrl = enSet?.logo ? `${enSet.logo}.webp` : (deSet?.logo ? `${deSet.logo}.webp` : '');
  let officialCount = Number(enSet?.cardCount?.official || deSet?.cardCount?.official || 0);

  // Build quick lookup from staticCatalogItems for this set so cards know their Cardmarket idProduct
  const catalogSetSingles = [];
  if (Array.isArray(staticCatalogItems)) {
    const targetCode = String(setInfo.code || '').trim().toUpperCase();
    const targetEn = String(setInfo.en || '').trim().toLowerCase();
    const targetDe = String(setInfo.de || '').trim().toLowerCase();
    for (let i = 0; i < staticCatalogItems.length; i++) {
      const r = staticCatalogItems[i];
      if (r[3] !== 'c') continue;
      const rCode = String(r[6] || '').trim().toUpperCase();
      const rExp = String(r[5] || '').trim().toLowerCase();
      if (
        r[12] === tcgdexId ||
        (targetCode && rCode === targetCode) ||
        (targetEn && rExp === targetEn) ||
        (targetDe && rExp === targetDe)
      ) {
        catalogSetSingles.push(r);
      }
    }
    catalogSetSingles.sort((a, b) => Number(a[0]) - Number(b[0]));
  }

  const tcgdexHasImages = Array.isArray(enSet?.cards) && enSet.cards.some(c => Boolean(c.image));
  const useTcgdexList = Boolean(
    enSet &&
    Array.isArray(enSet.cards) &&
    enSet.cards.length > 0 &&
    (tcgdexHasImages || catalogSetSingles.length <= enSet.cards.length)
  );

  if (useTcgdexList) {
    const deByLocal = new Map();
    if (deSet && Array.isArray(deSet.cards)) {
      for (const dc of deSet.cards) {
        if (dc.localId) deByLocal.set(String(dc.localId), dc);
      }
    }

    const sortedEn = [...enSet.cards].sort((a, b) => {
      const na = parseInt(a.localId, 10);
      const nb = parseInt(b.localId, 10);
      if (!Number.isNaN(na) && !Number.isNaN(nb) && na !== nb) return na - nb;
      return String(a.localId || '').localeCompare(String(b.localId || ''));
    });

    // Track per-name counts to pair multi-rarity cards in set order with catalogSetSingles
    const nameOccCount = new Map();
    cards = sortedEn.map(c => {
      const loc = String(c.localId || '');
      const deCard = deByLocal.get(loc);
      const numVal = parseInt(loc, 10);
      const isSecret = officialCount > 0 && !Number.isNaN(numVal) && numVal > officialCount;
      const baseImg = c.image || deCard?.image || '';

      const enNorm = normalizeCardMatchName(c.name || '');
      const occIdx = nameOccCount.get(enNorm) || 0;
      nameOccCount.set(enNorm, occIdx + 1);
      const matchingCatRows = catalogSetSingles.filter(r => {
        const clean = parseCardmarketHints(r[1]).cleanName;
        return normalizeCardMatchName(clean) === enNorm;
      });
      const matchedRow = matchingCatRows.length > 0
        ? matchingCatRows[Math.min(occIdx, matchingCatRows.length - 1)]
        : null;
      const matchedId = matchedRow ? Number(matchedRow[0]) : null;
      const fallbackCmImg = matchedId ? (isStaticMode ? `./images/${matchedId}.jpg` : `/api/cm-image/${matchedId}`) : '';
      const marketData = extractCatalogRowMarketData(matchedRow);

      return {
        key: String(c.id || loc),
        id: c.id || `${tcgdexId}-${loc}`,
        localId: loc,
        enName: c.name || '',
        rawName: matchedRow ? matchedRow[1] : (c.name || ''),
        deName: deCard?.name || '',
        name: deCard?.name && deCard.name !== c.name ? deCard.name : (c.name || ''),
        imageLow: baseImg ? `${baseImg}/low.webp` : fallbackCmImg,
        imageHigh: baseImg ? `${baseImg}/high.webp` : fallbackCmImg,
        isSecret,
        idProduct: matchedId,
        siblingIdx: occIdx,
        marketEur: marketData.marketEur,
        marketPrices: marketData.marketPrices
      };
    });
  } else {
    // Fallback for brand-new sets or incomplete TCGdex stubs (e.g. 30th-c): pull full card list from Cardmarket catalog
    officialCount = 0;
    try {
      if (catalogSetSingles.length > 0) {
        cards = catalogSetSingles.map(r => {
          const marketData = extractCatalogRowMarketData(r);
          return {
            key: String(r[0]),
            id: String(r[0]),
            localId: `#${r[0]}`,
            enName: r[1] || '',
            rawName: r[1] || '',
            deName: r[2] || '',
            name: (r[2] || r[1] || '').replace(/\[.*?\]/g, '').trim(),
            imageLow: isStaticMode ? `./images/${r[0]}.jpg` : `/api/cm-image/${r[0]}`,
            imageHigh: isStaticMode ? `./images/${r[0]}.jpg` : `/api/cm-image/${r[0]}`,
            isSecret: false,
            idProduct: r[0],
            marketEur: marketData.marketEur,
            marketPrices: marketData.marketPrices
          };
        });
      } else if (!isStaticMode) {
        const res = await fetch(`/api/search?q=${encodeURIComponent(setInfo.en || setInfo.de)}&type=single`);
        const data = await res.json();
        cards = (data.results || [])
          .filter(p => (setInfo.code && p.expansionCode === setInfo.code) || p.expansionName === setInfo.de || p.expansionName === setInfo.en)
          .sort((a, b) => Number(a.idProduct) - Number(b.idProduct))
          .map(p => ({
            key: String(p.idProduct),
            id: String(p.idProduct),
            localId: `#${p.idProduct}`,
            enName: p.name || '',
            rawName: p.name || '',
            deName: p.displayNameDe || '',
            name: (p.displayNameDe || p.name || '').replace(/\[.*?\]/g, '').trim(),
            imageLow: `/api/cm-image/${p.idProduct}`,
            imageHigh: `/api/cm-image/${p.idProduct}`,
            isSecret: false,
            idProduct: p.idProduct,
            marketEur: p.marketPrices?.dePrice ?? p.marketPrices?.trend ?? p.marketPrices?.low ?? null,
            marketPrices: p.marketPrices || {}
          }));
      }
    } catch (e) {}
  }

  currentChecklistData = {
    tcgdexId,
    setInfo,
    logoUrl,
    officialCount,
    cards
  };
  renderChecklistView();
}

function renderChecklistView() {
  if (!currentChecklistData) return;
  const { tcgdexId, setInfo, logoUrl, officialCount, cards } = currentChecklistData;
  const ownedMap = loadChecklistOwnedMap();

  const logoWrap = document.getElementById('checklistSetLogo');
  if (logoUrl) {
    logoWrap.innerHTML = `<img src="${escapeHtml(logoUrl)}" alt="${escapeHtml(setInfo.code)}" onerror="this.parentElement.textContent='${escapeHtml(setInfo.code || 'SET')}'" />`;
  } else {
    logoWrap.textContent = setInfo.code || 'SET';
  }

  const portfolioMatchMap = buildPortfolioMatchedCardMapForSet(cards, setInfo);
  const portfolioMatchedKeys = new Set(portfolioMatchMap.keys());

  let ownedCount = 0;
  let secretCount = 0;
  let ownedValueEur = 0;
  let totalValueEur = 0;
  const enriched = cards.map(c => {
    const owned = getChecklistCardOwnedState(tcgdexId, c, ownedMap, portfolioMatchedKeys);
    const inPortfolio = portfolioMatchedKeys.has(c.key);
    const matchedItems = portfolioMatchMap.get(c.key) || [];
    const displayEur = getChecklistCardDisplayPrice(c, matchedItems);
    if (displayEur != null && displayEur > 0) totalValueEur += displayEur;
    if (owned) {
      ownedCount++;
      if (displayEur != null && displayEur > 0) ownedValueEur += displayEur;
    }
    if (c.isSecret) secretCount++;
    return { ...c, owned, inPortfolio, displayEur };
  });

  const total = enriched.length;
  const missingCount = Math.max(0, total - ownedCount);
  const pct = total > 0 ? (ownedCount / total) * 100 : 0;
  const pctTxt = total > 0 ? `${pct.toFixed(pct > 0 && pct < 10 ? 1 : 0).replace('.', ',')} %` : '0 %';

  document.getElementById('checklistSetTitle').textContent = setInfo.de && setInfo.de !== setInfo.en
    ? `${setInfo.de} • ${setInfo.en}`
    : (setInfo.de || setInfo.en);
  document.getElementById('checklistSetSubtitle').textContent = total > 0
    ? `${total} Karten erfasst${officialCount ? ` (Basis-Set: ${officialCount} • Secret Rares: ${secretCount})` : ''}`
    : 'Für dieses Set liegen aktuell noch keine Kartendaten vor (wird nach Release automatisch geladen)';
  document.getElementById('checklistPctLabel').textContent = pctTxt;
  document.getElementById('checklistOwnedCount').textContent = String(ownedCount);
  document.getElementById('checklistMissingCount').textContent = String(missingCount);
  const ownedValEl = document.getElementById('checklistOwnedValue');
  if (ownedValEl) ownedValEl.textContent = fmtEuro(ownedValueEur);
  const totalValEl = document.getElementById('checklistTotalValue');
  if (totalValEl) totalValEl.textContent = fmtEuro(totalValueEur);
  document.getElementById('checklistProgressFill').style.width = `${Math.min(100, pct)}%`;

  document.getElementById('cCountAll').textContent = String(total);
  document.getElementById('cCountOwned').textContent = String(ownedCount);
  document.getElementById('cCountMissing').textContent = String(missingCount);
  document.getElementById('cCountSecrets').textContent = String(secretCount);

  const q = checklistSearch.trim().toLowerCase();
  const filtered = enriched.filter(c => {
    if (checklistFilter === 'owned' && !c.owned) return false;
    if (checklistFilter === 'missing' && c.owned) return false;
    if (checklistFilter === 'secrets' && !c.isSecret) return false;
    if (q) {
      const hay = `${c.name} ${c.enName} ${c.deName} ${c.localId}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const grid = document.getElementById('checklistGrid');
  grid.innerHTML = '';
  if (filtered.length === 0) {
    grid.innerHTML = `<div class="search-hint">${total === 0 ? 'Noch keine Kartendaten für dieses Set verfügbar.' : 'Keine passenden Karten gefunden.'}</div>`;
    return;
  }

  for (const card of filtered) {
    const el = document.createElement('div');
    el.className = `checklist-card${card.owned ? ' is-owned' : ''}`;
    const numDisplay = String(card.localId || '').startsWith('#')
      ? card.localId
      : (officialCount ? `${String(card.localId).padStart(3, '0')}/${officialCount}` : `#${card.localId}`);
    const badgeFallback = escapeHtml(setInfo.code || 'TCG');

    el.innerHTML = `
      <div class="checklist-card-visual">
        ${card.imageLow
          ? `<img src="${escapeHtml(card.imageLow)}" loading="lazy" alt="${escapeHtml(card.name)}" data-id="${escapeHtml(card.idProduct || '')}" data-name="${escapeHtml(card.rawName || card.enName || card.name)}" data-type="single" data-tcgdex="${escapeHtml(tcgdexId)}" data-exp="${escapeHtml(setInfo.en || setInfo.de || '')}" data-sidx="${card.siblingIdx ?? 0}" data-badge="${badgeFallback}" onerror="handleCardImageError(this)" />`
          : badgeFallback}
      </div>
      <div class="checklist-card-footer">
        <div class="checklist-card-meta-row">
          <span class="checklist-num-badge">${escapeHtml(numDisplay)}</span>
          ${card.isSecret ? '<span class="checklist-secret-badge">SIR / Hit</span>' : ''}
          ${card.displayEur != null ? `<span class="checklist-price-badge">${fmtEuro(card.displayEur)}</span>` : ''}
        </div>
        <div class="checklist-card-name" title="${escapeHtml(card.name)}">${escapeHtml(card.name)}</div>
        <div class="checklist-actions-row">
          <button type="button" class="checklist-toggle-btn">
            ${card.owned ? (card.inPortfolio ? '✓ Im Portfolio' : '✓ Im Besitz') : '+ Abhaken'}
          </button>
          ${(!viewingFriend && !card.inPortfolio) ? `<button type="button" class="checklist-portfolio-btn" title="Direkt ins Portfolio übernehmen">+ Portfolio</button>` : ''}
        </div>
      </div>
    `;

    el.querySelector('.checklist-card-visual').addEventListener('click', () => {
      openCardZoomModal({
        id: card.key,
        idProduct: card.idProduct,
        name: card.enName || card.name,
        displayNameDe: card.deName || card.name,
        type: 'single',
        expansionName: setInfo.de || setInfo.en,
        expansionCode: setInfo.code || '',
        tcgdexId,
        condition: 'NM',
        language: card.deName ? 'DE' : 'EN',
        quantity: 1,
        buyPrice: null,
        marketPrices: card.marketPrices || (card.displayEur != null ? { dePrice: card.displayEur } : {}),
        imageUrl: card.imageHigh || card.imageLow
      }, el.querySelector('.checklist-card-visual img'));
    });

    el.querySelector('.checklist-toggle-btn').addEventListener('click', () => {
      toggleChecklistCardOwned(tcgdexId, card.key, card, portfolioMatchedKeys);
    });
    const addPortBtn = el.querySelector('.checklist-portfolio-btn');
    if (addPortBtn) {
      addPortBtn.addEventListener('click', () => addChecklistCardToPortfolio(card, setInfo, tcgdexId));
    }

    grid.appendChild(el);
  }
}

async function switchMainPage(page) {
  activeMainPage = page === 'sets' ? 'sets' : 'portfolio';
  const portEl = document.getElementById('portfolioPage');
  const setsEl = document.getElementById('setsPage');
  document.querySelectorAll('#pageSwitcher .page-tab').forEach(b => {
    b.classList.toggle('active', b.dataset.page === activeMainPage);
  });

  if (activeMainPage === 'sets') {
    portEl?.classList.add('hidden');
    setsEl?.classList.remove('hidden');
    await ensureSetsIndexLoaded();
    if (!selectedChecklistSetId) {
      let savedSet = '';
      try { savedSet = localStorage.getItem(CHECKLIST_LAST_SET_KEY) || ''; } catch (e) {}
      selectedChecklistSetId = savedSet || 'me06';
    }
    populateSetPickerSelect(document.getElementById('setPickerSearch')?.value || '');
    renderFeaturedSetsStrip();
    syncOwnerChecklistsFromCloud();
    if (!currentChecklistData || currentChecklistData.tcgdexId !== selectedChecklistSetId) {
      await loadChecklistSet(selectedChecklistSetId);
    } else {
      renderChecklistView();
    }
  } else {
    setsEl?.classList.add('hidden');
    portEl?.classList.remove('hidden');
  }
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && profileMode === 'owner' && isAdminMode && !viewingFriend && isStaticMode) {
    fetchPortfolio();
  }
});

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

  // Page Switcher & Set-Checkliste listeners
  document.querySelectorAll('#pageSwitcher .page-tab').forEach(btn => {
    btn.addEventListener('click', () => switchMainPage(btn.dataset.page));
  });
  document.getElementById('setPickerSearch')?.addEventListener('input', e => {
    populateSetPickerSelect(e.target.value);
    const sel = document.getElementById('setPickerSelect');
    if (sel && sel.options.length === 1 && sel.value) {
      loadChecklistSet(sel.value);
    }
  });
  document.getElementById('setPickerSearch')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const sel = document.getElementById('setPickerSelect');
      if (sel && sel.value) loadChecklistSet(sel.value);
    }
  });
  document.getElementById('setPickerSelect')?.addEventListener('change', e => {
    if (e.target.value) loadChecklistSet(e.target.value);
  });
  document.querySelectorAll('#checklistFilterTabs .tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#checklistFilterTabs .tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      checklistFilter = btn.dataset.cfilter || 'all';
      renderChecklistView();
    });
  });
  document.getElementById('checklistCardSearch')?.addEventListener('input', e => {
    checklistSearch = e.target.value;
    renderChecklistView();
  });

  document.getElementById('btnCloseSnapshotModal').addEventListener('click', closeSnapshotModal);
  document.getElementById('btnCancelSnapshot').addEventListener('click', closeSnapshotModal);

  document.getElementById('btnOpenExpenseModal').addEventListener('click', () => openExpenseModal(null));
  document.getElementById('btnCloseExpenseModal').addEventListener('click', closeExpenseModal);
  document.getElementById('btnCancelExpense').addEventListener('click', closeExpenseModal);
  document.getElementById('expenseCost').addEventListener('input', updateExpensePerPackHelp);
  document.getElementById('expensePacksCount').addEventListener('input', updateExpensePerPackHelp);

  document.querySelectorAll('#expenseModal .expense-preset-pills .pill').forEach(pill => {
    pill.addEventListener('click', () => {
      document.querySelectorAll('#expenseModal .expense-preset-pills .pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      document.getElementById('expensePacksCount').value = pill.dataset.packs || '36';
      updateExpensePerPackHelp();
    });
  });

  document.getElementById('expenseForm').addEventListener('submit', async e => {
    e.preventDefault();
    const editId = document.getElementById('expenseEditId').value;
    const sourceSealedId = document.getElementById('expenseSourceSealedId').value;
    const sourceSealed = sourceSealedId
      ? portfolioItems.find(i => i.id === sourceSealedId && i.type === 'sealed')
      : null;
    const activePreset = document.querySelector('#expenseModal .expense-preset-pills .pill.active')?.dataset.preset || 'display';
    const today = new Date().toISOString().slice(0, 10);
    let requestedQty = Math.max(1, Number(document.getElementById('expenseQuantity').value) || 1);
    const sealedQty = sourceSealed ? Math.max(1, Number(sourceSealed.quantity) || 1) : 0;
    if (sourceSealed) {
      requestedQty = Math.min(sealedQty, requestedQty);
    }

    const payload = {
      name: document.getElementById('expenseName').value.trim(),
      type: 'expense',
      categoryName: 'Geöffnet / Packs',
      buyPrice: Number(document.getElementById('expenseCost').value) || 0,
      packsCount: Math.max(1, Number(document.getElementById('expensePacksCount').value) || 1),
      quantity: requestedQty,
      buyDate: document.getElementById('expenseDate').value || today,
      notes: document.getElementById('expenseNotes').value.trim(),
      expensePreset: activePreset,
      condition: 'M',
      language: sourceSealed?.language || 'DE',
      idProduct: sourceSealed?.idProduct || null,
      expansionName: sourceSealed?.expansionName || '',
      expansionCode: sourceSealed?.expansionCode || '',
      tcgdexId: sourceSealed?.tcgdexId || '',
      imageUrl: sourceSealed?.imageUrl || '',
      cardmarketUrl: sourceSealed?.cardmarketUrl || ''
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
        if (sourceSealed) {
          if (requestedQty >= sealedQty) {
            await fetch(`/api/portfolio/${sourceSealed.id}`, { method: 'DELETE' });
            if (selectedChartItemId === sourceSealed.id) selectedChartItemId = null;
          } else {
            await fetch(`/api/portfolio/${sourceSealed.id}`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ quantity: sealedQty - requestedQty })
            });
          }
        }
      }
      closeExpenseModal();
      await fetchPortfolio();
    } else {
      if (editId) {
        const idx = portfolioItems.findIndex(i => i.id === editId);
        if (idx !== -1) {
          const it = portfolioItems[idx];
          it.name = payload.name;
          it.displayNameDe = payload.name;
          it.buyPrice = payload.buyPrice;
          it.packsCount = payload.packsCount;
          it.quantity = payload.quantity;
          it.buyDate = payload.buyDate;
          it.notes = payload.notes;
          it.expensePreset = payload.expensePreset;
          it.mobileEditedAt = new Date().toISOString();
        }
      } else {
        if (sourceSealed) {
          if (requestedQty >= sealedQty) {
            if (isStaticMode && profileMode === 'owner' && !String(sourceSealed.id).startsWith('mobile_')) {
              addDeletedOwnerId(sourceSealed.id);
            }
            portfolioItems = portfolioItems.filter(i => i.id !== sourceSealed.id);
            if (selectedChartItemId === sourceSealed.id) selectedChartItemId = null;
          } else {
            sourceSealed.quantity = sealedQty - requestedQty;
            sourceSealed.mobileEditedAt = new Date().toISOString();
          }
        }
        portfolioItems.unshift({
          id: 'mobile_exp_' + Date.now(),
          idProduct: payload.idProduct,
          name: payload.name,
          displayNameDe: payload.name,
          type: 'expense',
          categoryName: 'Geöffnet / Packs',
          expansionName: payload.expansionName,
          expansionCode: payload.expansionCode,
          tcgdexId: payload.tcgdexId,
          imageUrl: payload.imageUrl,
          fallbackImageUrl: sourceSealed?.fallbackImageUrl || '',
          cardmarketUrl: payload.cardmarketUrl,
          packsCount: payload.packsCount,
          expensePreset: payload.expensePreset,
          quantity: payload.quantity,
          buyPrice: payload.buyPrice,
          buyDate: payload.buyDate,
          notes: payload.notes,
          marketPrices: { dePrice: 0, low: 0, trend: 0, avg30: 0, updatedAt: today },
          priceHistory: [],
          createdAt: new Date().toISOString()
        });
      }
      saveLocalPortfolio();
      closeExpenseModal();
      renderAll();
    }

    if (sourceSealed) {
      showToast(`„${payload.name}“ (${requestedQty}x) zu Geöffnet verschoben`);
    } else if (activeFilter !== 'expense') {
      showToast(`Ausgabe gespeichert (-${fmtEuro(payload.buyPrice * payload.quantity)})`);
    }
  });

  document.getElementById('btnCloseCardZoom').addEventListener('click', closeCardZoomModal);
  document.getElementById('cardZoomModal').addEventListener('click', e => {
    if (e.target && e.target.id === 'cardZoomModal') closeCardZoomModal();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      closeCardZoomModal();
      closeScannerModal();
    }
  });

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
      updateStaticStatusBadge();
      if (profileMode === 'owner' && isStaticMode) {
        await fetchPortfolio();
      }
      if (adminLoginNextAction === 'friends') {
        showToast('Erfolgreich angemeldet.');
        openFriendsModal();
      } else {
        showToast('☁️ 2-Wege Cloud-Sync aktiviert!');
      }
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

  // Tools Dropdown Menu (Mobile & Desktop cleanup)
  const toolsBtn = document.getElementById('btnToggleToolsMenu');
  const toolsDrop = document.getElementById('toolsDropdown');
  if (toolsBtn && toolsDrop) {
    toolsBtn.addEventListener('click', e => {
      e.stopPropagation();
      const willOpen = toolsDrop.classList.contains('hidden');
      toolsDrop.classList.toggle('hidden', !willOpen);
      toolsBtn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
    });
    toolsDrop.addEventListener('click', () => {
      toolsDrop.classList.add('hidden');
      toolsBtn.setAttribute('aria-expanded', 'false');
    });
    document.addEventListener('click', e => {
      if (!toolsDrop.classList.contains('hidden') && !e.target.closest('#toolsMenuWrap')) {
        toolsDrop.classList.add('hidden');
        toolsBtn.setAttribute('aria-expanded', 'false');
      }
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && !toolsDrop.classList.contains('hidden')) {
        toolsDrop.classList.add('hidden');
        toolsBtn.setAttribute('aria-expanded', 'false');
      }
    });
  }

  // PWA Service Worker & App Installation
  let deferredInstallPrompt = null;
  const installBtnTop = document.getElementById('btnInstallPwa');
  const installBtnMenu = document.getElementById('btnInstallPwaMenu');
  const isStandaloneApp = () =>
    window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

  if (installBtnTop && isStandaloneApp()) {
    installBtnTop.classList.add('hidden');
  }

  if ('serviceWorker' in navigator && (window.location.protocol === 'https:' || window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }

  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    deferredInstallPrompt = e;
    if (installBtnTop && !isStandaloneApp()) {
      installBtnTop.classList.remove('hidden');
      installBtnTop.textContent = '📲 App installieren';
    }
  });

  window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    if (installBtnTop) installBtnTop.classList.add('hidden');
    showToast('App erfolgreich installiert! 🎉');
  });

  async function triggerPwaInstall() {
    if (isStandaloneApp()) {
      showToast('App läuft bereits im App-Modus ✓');
      return;
    }
    if (deferredInstallPrompt) {
      deferredInstallPrompt.prompt();
      try {
        const choice = await deferredInstallPrompt.userChoice;
        if (choice?.outcome === 'accepted') {
          deferredInstallPrompt = null;
          if (installBtnTop) installBtnTop.classList.add('hidden');
        }
      } catch (e) {}
      return;
    }
    const ua = navigator.userAgent || '';
    const isIos = /iphone|ipad|ipod/i.test(ua);
    if (isIos) {
      alert('iPhone / iPad als App speichern:\n1. Unten in Safari auf das Teilen-Symbol (⬆️) tippen.\n2. „Zum Home-Bildschirm“ wählen.\n3. Auf „Hinzufügen“ tippen.');
    } else {
      alert('Als App installieren (PC & Android):\n• Chrome / Edge am PC: Rechts oben in der Adressleiste auf das „Installieren“-Symbol (💻 / ⊕) oder Menü → „App installieren“ klicken.\n• Android Chrome: Menü (⋮) → „App installieren“ / „Zum Startbildschirm hinzufügen“.');
    }
  }

  installBtnTop?.addEventListener('click', triggerPwaInstall);
  installBtnMenu?.addEventListener('click', triggerPwaInstall);

  document.getElementById('btnHardReloadApp')?.addEventListener('click', async () => {
    try {
      if ('caches' in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map(k => caches.delete(k)));
      }
      if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map(r => r.update().catch(() => {})));
      }
    } catch (e) {}
    window.location.href = window.location.pathname + '?v=' + Date.now();
  });

  // Export Backup (incl. Portfolio, Set-Checkliste & gelöschte IDs)
  document.getElementById('btnExportBackup').addEventListener('click', () => {
    const safeName = profileName ? `-${profileName.toLowerCase().replace(/[^a-z0-9]/g, '')}` : '';
    const payload = {
      ownerName: profileName || 'Standard',
      exportedAt: new Date().toISOString(),
      items: portfolioItems,
      checklists: loadChecklistOwnedMap(),
      deletedIds: [...getDeletedOwnerIds()]
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
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
        if (Array.isArray(parsed.deletedIds)) {
          saveDeletedOwnerIdsSet(new Set(parsed.deletedIds));
        }
        if (parsed.checklists && typeof parsed.checklists === 'object') {
          saveChecklistOwnedMap(parsed.checklists, true);
        }
        await enrichItemsWithCatalog(portfolioItems);
        saveLocalPortfolio();
        if (profileMode === 'owner' && isAdminMode && !viewingFriend) {
          pushOwnerCloudVaultNow();
        }
        renderAll();
        showToast(`${portfolioItems.length} Einträge (inkl. Checklisten) geladen!`);
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

  document.querySelectorAll('#chartRangePills .chart-range-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#chartRangePills .chart-range-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      chartTimeframe = btn.dataset.range || 'all';
      renderChart();
    });
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
      staticCatalogItems = null;
      staticCatalogLoadingPromise = null;
      await fetchPortfolio();
      updateStaticStatusBadge();
      showToast('Preise & Cloud-Stand aktualisiert.');
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

  document.getElementById('formIsHolo').addEventListener('change', updateModalLivePricePreview);
  document.getElementById('formCondition').addEventListener('change', updateModalLivePricePreview);
  document.getElementById('formIsFirstEdition').addEventListener('change', updateModalLivePricePreview);
  document.getElementById('formType').addEventListener('change', updateModalLivePricePreview);
  document.getElementById('formCustomLowPrice').addEventListener('input', updateModalLivePricePreview);

  document.getElementById('portfolioForm').addEventListener('submit', async e => {
    e.preventDefault();
    const editId = document.getElementById('formEditId').value;
    const rawBuyStr = document.getElementById('formBuyPrice').value.trim();
    const variantVal = document.getElementById('formIsHolo').value || 'normal';
    const isHoloBool = variantVal !== 'normal';
    const isFirstEdBool = document.getElementById('formIsFirstEdition').value === 'true';

    const payload = {
      idProduct: document.getElementById('formIdProduct').value || null,
      name: document.getElementById('formName').value.trim(),
      type: document.getElementById('formType').value,
      variant: variantVal,
      isHolo: isHoloBool,
      isFirstEdition: isFirstEdBool,
      buyPrice: rawBuyStr === '' ? null : Number(rawBuyStr),
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
          it.type = payload.type;
          it.variant = payload.variant;
          it.isHolo = payload.isHolo;
          it.isFirstEdition = payload.isFirstEdition;
          it.buyPrice = payload.buyPrice;
          it.quantity = payload.quantity;
          it.condition = payload.condition;
          it.language = payload.language;
          it.buyDate = payload.buyDate;
          it.customLowPrice = customLow;
          it.mobileEditedAt = now.toISOString();

          if (currentModalPriceData) {
            const activePr = getSelectedPricesForVariant(currentModalPriceData, payload.isHolo);
            if (activePr && (activePr.dePrice != null || activePr.trend != null || activePr.low != null)) {
              it.marketPrices = {
                ...(it.marketPrices || {}),
                dePrice: activePr.dePrice ?? it.marketPrices?.dePrice ?? null,
                low: activePr.low ?? it.marketPrices?.low ?? null,
                trend: activePr.trend ?? it.marketPrices?.trend ?? null,
                avg30: activePr.avg30 ?? it.marketPrices?.avg30 ?? null,
                hasHoloPrices: Boolean(currentModalPriceData.hasHolo),
                updatedAt: today
              };
            }
          }
          const newEff = getUnitDePrice(it);
          if (newEff > 0) {
            if (!Array.isArray(it.priceHistory)) it.priceHistory = [];
            const exToday = it.priceHistory.find(h => h.date === today);
            if (exToday) {
              exToday.low = newEff;
            } else {
              it.priceHistory.push({ date: today, low: newEff, trend: it.marketPrices?.trend ?? newEff, label: 'Heute' });
            }
          }
        }
      } else {
        const pr = getSelectedPricesForVariant(lastSelectedCatalogProd, payload.isHolo);
        const condAdj = applyConditionPrice(pr.dePrice ?? pr.trend ?? pr.low, payload.condition, payload.type === 'sealed');
        const eff = customLow ?? condAdj ?? payload.buyPrice ?? 0;
        const hist = [];
        const d30 = new Date(now.getTime() - 30 * 86400000).toISOString().slice(0, 10);
        const d7 = new Date(now.getTime() - 7 * 86400000).toISOString().slice(0, 10);
        const p30 = applyConditionPrice(pr.avg30 ?? pr.trend, payload.condition, payload.type === 'sealed') ?? eff;
        const p7 = applyConditionPrice(pr.trend, payload.condition, payload.type === 'sealed') ?? eff;
        if (p30 > 0) hist.push({ date: d30, low: Number(p30.toFixed(2)), trend: Number((pr.trend ?? p30).toFixed(2)), label: '30T Ø' });
        if (p7 > 0) hist.push({ date: d7, low: Number(p7.toFixed(2)), trend: Number((pr.trend ?? p7).toFixed(2)), label: '7T Ø' });
        if (eff > 0) hist.push({ date: today, low: Number(eff.toFixed(2)), trend: Number((pr.trend ?? eff).toFixed(2)), label: 'Heute' });

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
          variant: payload.variant,
          isHolo: payload.isHolo,
          isFirstEdition: payload.isFirstEdition,
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
            hasHoloPrices: Boolean(lastSelectedCatalogProd?.hasHolo),
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
        item.mobileEditedAt = new Date().toISOString();
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

  // =========================================================================
  // Camera Card Scanner (OCR via Tesseract.js + optional Gemini Vision KI)
  // =========================================================================
  const SCANNER_KEY_STORAGE = 'pokevault_gemini_api_key';
  const SCANNER_AI_STORAGE = 'pokevault_scanner_use_ai';
  let scannerStream = null;
  let scannerFacingMode = 'environment';
  let tesseractPromise = null;
  let scannerWorkerPromise = null;
  let scannerDebounce = null;

  function setScannerStatus(msg) {
    const el = document.getElementById('scannerStatusPill');
    if (el) el.textContent = msg;
  }

  function stopScannerStream() {
    if (scannerStream) {
      for (const track of scannerStream.getTracks()) {
        try { track.stop(); } catch (e) {}
      }
      scannerStream = null;
    }
    const video = document.getElementById('scannerVideo');
    if (video) video.srcObject = null;
  }

  async function startScannerCamera() {
    const video = document.getElementById('scannerVideo');
    const canvas = document.getElementById('scannerPreviewCanvas');
    const resumeBtn = document.getElementById('btnResumeCamera');
    const switchBtn = document.getElementById('btnSwitchCamera');
    if (!video || !canvas) return;

    canvas.classList.add('hidden');
    video.classList.remove('hidden');
    resumeBtn?.classList.add('hidden');
    stopScannerStream();

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setScannerStatus('Kamera hier nicht verfügbar – nutze 🖼️ Foto');
      return;
    }

    setScannerStatus('Kamera startet...');
    try {
      scannerStream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: scannerFacingMode },
          width: { ideal: 1280 },
          height: { ideal: 1700 }
        },
        audio: false
      });
      video.srcObject = scannerStream;
      await video.play().catch(() => {});
      setScannerStatus('Karte in Rahmen halten & scannen');

      try {
        const devs = await navigator.mediaDevices.enumerateDevices();
        const cams = devs.filter(d => d.kind === 'videoinput');
        if (switchBtn) switchBtn.classList.toggle('hidden', cams.length < 2);
      } catch (e) {}
    } catch (err) {
      setScannerStatus('Kamera abgelehnt – nutze 🖼️ Foto');
    }
  }

  function openScannerModal() {
    if (viewingFriend) return;
    const modal = document.getElementById('scannerModal');
    if (!modal) return;
    const keyInput = document.getElementById('scannerGeminiKeyInput');
    const aiCheck = document.getElementById('scannerUseAiCheck');
    const savedKey = localStorage.getItem(SCANNER_KEY_STORAGE) || '';
    if (keyInput) keyInput.value = savedKey;
    if (aiCheck) aiCheck.checked = Boolean(savedKey) && localStorage.getItem(SCANNER_AI_STORAGE) === '1';

    modal.classList.remove('hidden');
    startScannerCamera();
    ensureStaticCatalogLoaded().catch(() => {});
  }

  function closeScannerModal() {
    stopScannerStream();
    document.getElementById('scannerModal')?.classList.add('hidden');
  }

  function ensureTesseractLoaded() {
    if (window.Tesseract) return Promise.resolve(window.Tesseract);
    if (tesseractPromise) return tesseractPromise;
    tesseractPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
      s.async = true;
      s.onload = () => resolve(window.Tesseract);
      s.onerror = () => {
        tesseractPromise = null;
        reject(new Error('OCR-Bibliothek konnte nicht geladen werden.'));
      };
      document.head.appendChild(s);
    });
    return tesseractPromise;
  }

  async function getScannerOcrWorker() {
    if (scannerWorkerPromise) return scannerWorkerPromise;
    scannerWorkerPromise = (async () => {
      const T = await ensureTesseractLoaded();
      const worker = await T.createWorker('eng+deu');
      return worker;
    })().catch(err => {
      scannerWorkerPromise = null;
      throw err;
    });
    return scannerWorkerPromise;
  }

  function enhanceContrastGrayCanvas(srcCanvas, sx, sy, sw, sh, targetW = 700) {
    const scale = targetW / Math.max(1, sw);
    const out = document.createElement('canvas');
    out.width = Math.max(1, Math.round(sw * scale));
    out.height = Math.max(1, Math.round(sh * scale));
    const ctx = out.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(srcCanvas, sx, sy, sw, sh, 0, 0, out.width, out.height);
    const img = ctx.getImageData(0, 0, out.width, out.height);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const gray = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      // Boost local contrast for dark/light card header & collector numbers
      const c = Math.max(0, Math.min(255, (gray - 128) * 1.45 + 128));
      d[i] = d[i + 1] = d[i + 2] = c;
    }
    ctx.putImageData(img, 0, 0);
    return out;
  }

  function parseOcrCardFields(topText, bottomText) {
    const cleanNumText = String(bottomText || '').replace(/\s+/g, ' ');
    const numMatch = cleanNumText.match(/\b(\d{1,3})\s*\/\s*(\d{1,3})\b/) ||
      cleanNumText.match(/\b((?:TG|GG|SV|SH|AR)\s*\d{1,3})\b/i) ||
      cleanNumText.match(/(?:#|\b)(\d{2,3})\b/);
    const cardNumber = numMatch ? numMatch[1].replace(/\s+/g, '').replace(/^0+(?=\d)/, '') : '';
    const cardTotal = (numMatch && numMatch[2]) ? numMatch[2].replace(/^0+(?=\d)/, '') : '';

    const setMatch = cleanNumText.match(/\b([A-Z]{3})\b(?=\s+(?:EN|DE|FR|ES|IT|\d))/);
    const setCode = setMatch ? setMatch[1] : '';

    const stopWords = /^(basis|basic|phase|stage|trainer|unterst[uü]tzer|supporter|item|stadion|stadium|ausr[uü]stung|tool|energ[iy]e?|kp|hp|restored|entwickelt|\d+)$/i;
    const lines = String(topText || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    let bestName = '';
    for (const line of lines) {
      const stripped = line
        .replace(/\b(?:KP|HP)\s*\d{2,3}\b/gi, '')
        .replace(/[^A-Za-zÄÖÜäöüßéÉ0-9'’\-\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      const tokens = stripped.split(' ').filter(t => t.length > 1 && !stopWords.test(t));
      if (tokens.length > 0) {
        bestName = tokens.join(' ');
        break;
      }
    }
    return { name: bestName, number: cardNumber, total: cardTotal, setCode };
  }

  async function scanCardWithGeminiVision(cardCanvas, apiKey) {
    const b64 = cardCanvas.toDataURL('image/jpeg', 0.86).split(',')[1];
    const prompt = 'Identify this Pokémon TCG card. Return strictly JSON only (no markdown): {"nameEn":"","nameDe":"","number":"","total":"","setCode":""}. Leave unknown fields empty.';
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: prompt },
            { inline_data: { mime_type: 'image/jpeg', data: b64 } }
          ]
        }]
      })
    });
    if (!res.ok) throw new Error(`Gemini HTTP ${res.status}`);
    const data = await res.json();
    const rawTxt = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const jsonMatch = rawTxt.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Keine JSON-Antwort von KI');
    return JSON.parse(jsonMatch[0]);
  }

  async function addCatalogRowToPortfolio(row, alsoCheckChecklist = false) {
    if (!row || viewingFriend) return;
    const [idProduct, rawName, displayNameDe, rowType, catName, expName, expCode, stdDe, stdLow, stdTrend, stdAvg30, , tcgdexId, holoRow] = row;
    const isSealed = rowType === 's';
    const type = isSealed ? 'sealed' : 'single';
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const title = displayNameDe || rawName;
    const cmUrl = `https://www.cardmarket.com/de/Pokemon/Products/Search?searchString=${encodeURIComponent(rawName)}&language=3`;

    if (!isStaticMode && profileMode === 'owner') {
      await fetch('/api/portfolio', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          idProduct: Number(idProduct),
          name: title,
          type,
          variant: 'normal',
          isHolo: false,
          isFirstEdition: false,
          buyPrice: null,
          quantity: 1,
          condition: 'NM',
          language: 'DE',
          buyDate: today,
          imageUrl: `/api/cm-image/${idProduct}`,
          cardmarketUrl: cmUrl
        })
      });
      await fetchPortfolio();
    } else {
      const eff = stdDe ?? stdTrend ?? stdLow ?? 0;
      const hist = [];
      const d30 = new Date(now.getTime() - 30 * 86400000).toISOString().slice(0, 10);
      const d7 = new Date(now.getTime() - 7 * 86400000).toISOString().slice(0, 10);
      if ((stdAvg30 ?? eff) > 0) hist.push({ date: d30, low: Number((stdAvg30 ?? eff).toFixed(2)), trend: Number((stdTrend ?? eff).toFixed(2)), label: '30T Ø' });
      if ((stdTrend ?? eff) > 0) hist.push({ date: d7, low: Number((stdTrend ?? eff).toFixed(2)), trend: Number((stdTrend ?? eff).toFixed(2)), label: '7T Ø' });
      if (eff > 0) hist.push({ date: today, low: Number(eff.toFixed(2)), trend: Number((stdTrend ?? eff).toFixed(2)), label: 'Heute' });

      portfolioItems.unshift({
        id: 'mobile_' + Date.now() + '_' + Math.random().toString(36).slice(2, 5),
        idProduct: Number(idProduct),
        name: rawName,
        displayNameDe: title,
        type,
        categoryName: isSealed ? (catName || 'Sealed') : 'Pokémon Single',
        expansionName: expName || '',
        expansionCode: expCode || '',
        tcgdexId: tcgdexId || '',
        variant: 'normal',
        isHolo: false,
        isFirstEdition: false,
        condition: 'NM',
        language: 'DE',
        quantity: 1,
        buyPrice: null,
        buyDate: today,
        customLowPrice: null,
        imageUrl: `./images/${idProduct}.jpg`,
        cardmarketUrl: cmUrl,
        marketPrices: {
          dePrice: stdDe ?? null,
          low: stdLow ?? null,
          trend: stdTrend ?? null,
          avg30: stdAvg30 ?? null,
          hasHoloPrices: Array.isArray(holoRow),
          updatedAt: today
        },
        priceHistory: hist,
        createdAt: now.toISOString()
      });
      saveLocalPortfolio();
      renderAll();
    }

    if (alsoCheckChecklist && tcgdexId) {
      const ownedMap = loadChecklistOwnedMap();
      if (!ownedMap[tcgdexId] || typeof ownedMap[tcgdexId] !== 'object') ownedMap[tcgdexId] = {};
      ownedMap[tcgdexId][String(idProduct)] = true;
      saveChecklistOwnedMap(ownedMap);
    }

    showToast(`✓ „${title.replace(/\[.*?\]/g, '').trim()}“ hinzugefügt${stdDe != null ? ` (${fmtEuro(stdDe)})` : ''}`);
  }

  async function searchCatalogForScan(queryText, parsedHints = null) {
    const listEl = document.getElementById('scannerMatchesList');
    if (!listEl) return;
    const rawQ = String(queryText || '').trim();
    const numInQ = rawQ.match(/\b(\d{1,3})(?:\s*\/\s*\d{1,3})?\b/);
    const numHint = parsedHints?.number || (numInQ ? numInQ[1] : '');
    const setHint = (parsedHints?.setCode || '').toUpperCase();
    const cleanedWords = rawQ
      .replace(/\b\d{1,3}\s*\/\s*\d{1,3}\b/g, '')
      .toLowerCase()
      .split(/\s+/)
      .filter(w => w.length >= 2);

    if (cleanedWords.length === 0 && !numHint) {
      listEl.innerHTML = '<div class="search-hint">Name oder Kartennummer eingeben bzw. Karte scannen.</div>';
      return;
    }

    listEl.innerHTML = '<div class="search-hint">Suche passende Karten im Katalog...</div>';

    let rows = [];
    if (isStaticMode) {
      const cat = await ensureStaticCatalogLoaded();
      const scored = [];
      for (let i = 0; i < cat.length; i++) {
        const r = cat[i];
        const en = String(r[1] || '').toLowerCase();
        const de = String(r[2] || '').toLowerCase();
        const exp = String(r[5] || '').toLowerCase();
        const code = String(r[6] || '').toUpperCase();
        const hay = `${en} ${de} ${exp} ${code.toLowerCase()}`;

        let score = 0;
        let wordHits = 0;
        for (const w of cleanedWords) {
          if (hay.includes(w)) {
            wordHits++;
            score += (en.startsWith(w) || de.startsWith(w)) ? 25 : 14;
          }
        }
        if (cleanedWords.length > 0 && wordHits === 0) continue;
        if (wordHits === cleanedWords.length && cleanedWords.length > 0) score += 30;
        if (numHint && (en.includes(`#${numHint}`) || en.includes(`(${numHint})`) || en.includes(` ${numHint}/`))) {
          score += 35;
        }
        if (setHint && code === setHint) score += 25;
        if (r[3] === 'c') score += 5;

        if (score > 0) scored.push({ r, score, price: Number(r[7] ?? r[9] ?? 0) });
      }
      scored.sort((a, b) => (b.score - a.score) || (b.price - a.price));
      rows = scored.slice(0, 18).map(x => x.r);
    } else {
      const qTerm = cleanedWords.join(' ') || numHint;
      const res = await fetch(`/api/search?q=${encodeURIComponent(qTerm)}&type=single`);
      const data = await res.json();
      rows = (data.results || []).slice(0, 18).map(p => [
        p.idProduct,
        p.name,
        p.displayNameDe || '',
        p.type === 'sealed' ? 's' : 'c',
        p.categoryName,
        p.expansionName,
        p.expansionCode,
        p.prices?.dePrice ?? null,
        p.prices?.low ?? null,
        p.prices?.trend ?? null,
        p.prices?.avg30 ?? null,
        p.idCategory || 51,
        p.tcgdexId || ''
      ]);
    }

    listEl.innerHTML = '';
    if (rows.length === 0) {
      listEl.innerHTML = '<div class="search-hint">Keine exakten Treffer – passe oben den Namen kurz an (z.B. nur Pokémon-Namen eintippen).</div>';
      return;
    }

    for (const row of rows) {
      const [idProduct, rawName, deName, rowType, , expName, expCode, dePrice, low, trend, , , tcgdexId] = row;
      const title = (deName || rawName || '').replace(/\[.*?\]/g, '').trim();
      const priceVal = dePrice ?? trend ?? low;
      const badge = expCode || (rowType === 's' ? 'BOX' : 'TCG');
      const imgSrc = isStaticMode ? `./images/${idProduct}.jpg` : `/api/cm-image/${idProduct}`;

      const itemEl = document.createElement('div');
      itemEl.className = 'scanner-match-row';
      itemEl.innerHTML = `
        <div class="scanner-match-thumb">
          <img src="${escapeHtml(imgSrc)}" loading="lazy" alt="" data-id="${escapeHtml(idProduct)}" data-name="${escapeHtml(rawName)}" data-de="${escapeHtml(deName || '')}" data-type="${rowType === 's' ? 'sealed' : 'single'}" data-tcgdex="${escapeHtml(tcgdexId || '')}" data-exp="${escapeHtml(expName || '')}" data-code="${escapeHtml(expCode || '')}" data-badge="${escapeHtml(badge)}" onerror="handleCardImageError(this)" />
        </div>
        <div class="scanner-match-info">
          <div class="scanner-match-title" title="${escapeHtml(title)}">${escapeHtml(title)}</div>
          <div class="scanner-match-sub">${escapeHtml(expName || badge)}${expCode ? ` • ${escapeHtml(expCode)}` : ''} • #${idProduct}</div>
        </div>
        <div class="scanner-match-actions">
          <div class="scanner-match-price">${priceVal != null ? fmtEuro(priceVal) : '—'}</div>
          <button type="button" class="btn btn-primary btn-sm scanner-add-btn">+ Portfolio</button>
        </div>
      `;
      itemEl.querySelector('.scanner-add-btn').addEventListener('click', async btnEv => {
        const btn = btnEv.currentTarget;
        btn.disabled = true;
        btn.textContent = '...';
        try {
          await addCatalogRowToPortfolio(row, true);
          btn.textContent = '✓ Hinzugefügt';
        } catch (err) {
          btn.disabled = false;
          btn.textContent = '+ Portfolio';
        }
      });
      listEl.appendChild(itemEl);
    }
  }

  async function processScannedImageCanvas(cardCanvas) {
    const searchInput = document.getElementById('scannerSearchInput');
    const debugEl = document.getElementById('scannerOcrDebug');
    const apiKey = (document.getElementById('scannerGeminiKeyInput')?.value || '').trim();
    const useAi = Boolean(document.getElementById('scannerUseAiCheck')?.checked) && Boolean(apiKey);

    try {
      let parsed = null;
      if (useAi) {
        setScannerStatus('KI analysiert Karte...');
        if (debugEl) debugEl.textContent = 'Gemini Vision KI wird gefragt...';
        try {
          const aiRes = await scanCardWithGeminiVision(cardCanvas, apiKey);
          parsed = {
            name: aiRes.nameDe || aiRes.nameEn || '',
            enName: aiRes.nameEn || '',
            number: aiRes.number || '',
            total: aiRes.total || '',
            setCode: aiRes.setCode || ''
          };
        } catch (aiErr) {
          if (debugEl) debugEl.textContent = `KI-Fehler (${aiErr.message}) – weiche auf Browser-OCR aus...`;
        }
      }

      if (!parsed) {
        setScannerStatus('Lese Kartenname & Nummer...');
        if (debugEl) debugEl.textContent = 'Lade OCR-Texterkennung (beim 1. Mal ca. 2–3 Sek)...';
        const worker = await getScannerOcrWorker();

        const w = cardCanvas.width;
        const h = cardCanvas.height;
        const topCrop = enhanceContrastGrayCanvas(cardCanvas, w * 0.04, h * 0.02, w * 0.78, h * 0.17, 680);
        const botCrop = enhanceContrastGrayCanvas(cardCanvas, w * 0.02, h * 0.84, w * 0.66, h * 0.14, 620);

        const [topRes, botRes] = await Promise.all([
          worker.recognize(topCrop),
          worker.recognize(botCrop)
        ]);
        parsed = parseOcrCardFields(topRes?.data?.text || '', botRes?.data?.text || '');
      }

      const displayQuery = [
        parsed.enName || parsed.name,
        parsed.number ? (parsed.total ? `${parsed.number}/${parsed.total}` : parsed.number) : '',
        parsed.setCode
      ].filter(Boolean).join(' ').trim();

      if (searchInput) searchInput.value = displayQuery;
      if (debugEl) {
        debugEl.textContent = displayQuery
          ? `Erkannt: ${displayQuery} (bei Bedarf oben kurz korrigieren)`
          : 'Text war schwer lesbar – einfach oben Pokémon-Namen eintippen';
      }
      setScannerStatus(displayQuery ? 'Erkennung fertig' : 'Bitte Namen eingeben');
      await searchCatalogForScan(displayQuery, parsed);
    } catch (err) {
      setScannerStatus('Scan fehlgeschlagen');
      if (debugEl) debugEl.textContent = `Fehler: ${err.message}`;
    }
  }

  document.getElementById('btnOpenScannerModal')?.addEventListener('click', openScannerModal);
  document.getElementById('btnCloseScannerModal')?.addEventListener('click', closeScannerModal);
  document.getElementById('scannerModal')?.addEventListener('click', e => {
    if (e.target && e.target.id === 'scannerModal') closeScannerModal();
  });

  document.getElementById('btnSwitchCamera')?.addEventListener('click', () => {
    scannerFacingMode = scannerFacingMode === 'environment' ? 'user' : 'environment';
    startScannerCamera();
  });

  document.getElementById('btnResumeCamera')?.addEventListener('click', () => {
    startScannerCamera();
  });

  document.getElementById('btnSaveScannerKey')?.addEventListener('click', () => {
    const keyVal = (document.getElementById('scannerGeminiKeyInput')?.value || '').trim();
    const aiCheck = document.getElementById('scannerUseAiCheck');
    localStorage.setItem(SCANNER_KEY_STORAGE, keyVal);
    if (keyVal && aiCheck) {
      aiCheck.checked = true;
      localStorage.setItem(SCANNER_AI_STORAGE, '1');
      showToast('KI API-Key lokal gespeichert ✓');
    } else {
      localStorage.setItem(SCANNER_AI_STORAGE, '0');
      showToast('API-Key entfernt');
    }
  });

  document.getElementById('scannerUseAiCheck')?.addEventListener('change', e => {
    localStorage.setItem(SCANNER_AI_STORAGE, e.target.checked ? '1' : '0');
  });

  document.getElementById('btnCaptureScan')?.addEventListener('click', async () => {
    const video = document.getElementById('scannerVideo');
    const preview = document.getElementById('scannerPreviewCanvas');
    const resumeBtn = document.getElementById('btnResumeCamera');
    if (!video || !preview || !video.videoWidth) {
      showToast('Kamera noch nicht bereit – oder wähle 🖼️ Foto');
      return;
    }

    // Freeze full frame on preview canvas
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    preview.width = vw;
    preview.height = vh;
    const pCtx = preview.getContext('2d');
    pCtx.drawImage(video, 0, 0, vw, vh);
    video.classList.add('hidden');
    preview.classList.remove('hidden');
    resumeBtn?.classList.remove('hidden');

    // Crop exact card frame region (63:88 centered, ~82% height of video)
    const maxH = vh * 0.82;
    const rawW = maxH * (63 / 88);
    const cropW = Math.round(Math.min(vw * 0.94, rawW));
    const cropH = Math.round(Math.min(maxH, cropW * (88 / 63)));
    const sx = Math.max(0, Math.round((vw - cropW) / 2));
    const sy = Math.max(0, Math.round((vh - cropH) / 2));
    const cardCanvas = document.createElement('canvas');
    cardCanvas.width = cropW;
    cardCanvas.height = cropH;
    cardCanvas.getContext('2d').drawImage(preview, sx, sy, cropW, cropH, 0, 0, cropW, cropH);

    await processScannedImageCanvas(cardCanvas);
  });

  document.getElementById('scannerFileInput')?.addEventListener('change', async e => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const imgUrl = URL.createObjectURL(file);
      const img = new Image();
      await new Promise((res, rej) => {
        img.onload = res;
        img.onerror = rej;
        img.src = imgUrl;
      });
      const video = document.getElementById('scannerVideo');
      const preview = document.getElementById('scannerPreviewCanvas');
      const resumeBtn = document.getElementById('btnResumeCamera');
      preview.width = img.naturalWidth;
      preview.height = img.naturalHeight;
      preview.getContext('2d').drawImage(img, 0, 0);
      URL.revokeObjectURL(imgUrl);

      video.classList.add('hidden');
      preview.classList.remove('hidden');
      resumeBtn?.classList.remove('hidden');

      await processScannedImageCanvas(preview);
    } catch (err) {
      setScannerStatus('Foto konnte nicht geladen werden');
    }
    e.target.value = '';
  });

  document.getElementById('scannerSearchInput')?.addEventListener('input', e => {
    clearTimeout(scannerDebounce);
    const val = e.target.value;
    scannerDebounce = setTimeout(() => searchCatalogForScan(val), 180);
  });
});
