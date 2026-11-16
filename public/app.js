let portfolioItems = [];
let activeFilter = 'all';
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
  if (isStaticMode) {
    if (item.staticImageUrl) return `./${item.staticImageUrl}`;
    if (item.idProduct) {
      const ext = item.type === 'sealed' ? 'png' : 'jpg';
      return `./images/${item.idProduct}.${ext}`;
    }
  }
  if (item.imageUrl) return item.imageUrl;
  if (item.idProduct) return `/api/cm-image/${item.idProduct}`;
  return '';
}

function saveLocalPortfolio() {
  try {
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify({ items: portfolioItems, savedAt: new Date().toISOString() }));
  } catch (e) {}
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
    badge.className = 'status-pill ready';
    text.textContent = 'Cloud / iPhone Modus aktiv';
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

// Load Portfolio (merges latest server/GitHub daily prices with local iPhone additions)
async function fetchPortfolio() {
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

  if (localData && Array.isArray(localData.items) && localData.items.length > 0) {
    // Update marketPrices and priceHistory of matching items from remote daily GitHub update
    const remoteById = new Map(remoteItems.map(i => [i.id, i]));
    const remoteByProd = new Map(remoteItems.filter(i => i.idProduct).map(i => [Number(i.idProduct), i]));

    for (const locItem of localData.items) {
      const rem = remoteById.get(locItem.id) || (locItem.idProduct ? remoteByProd.get(Number(locItem.idProduct)) : null);
      if (rem) {
        locItem.marketPrices = rem.marketPrices || locItem.marketPrices;
        locItem.priceHistory = rem.priceHistory || locItem.priceHistory;
        locItem.staticImageUrl = rem.staticImageUrl || locItem.staticImageUrl;
        locItem.displayNameDe = locItem.displayNameDe || rem.displayNameDe;
      }
    }
    portfolioItems = localData.items;
  } else {
    portfolioItems = remoteItems;
    saveLocalPortfolio();
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

  if (portfolioItems.length === 0) {
    emptyState.classList.remove('hidden');
    tableWrap.classList.add('hidden');
    return;
  }
  emptyState.classList.add('hidden');
  tableWrap.classList.remove('hidden');

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
        (item.categoryName || '').toLowerCase().includes(q)
      );
    }
    return true;
  });

  filtered.sort((a, b) => {
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
  });

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
    const thumbContent = effectiveImg
      ? `<img src="${escapeHtml(effectiveImg)}" alt="" onerror="this.parentElement.textContent='${item.type === 'sealed' ? 'BOX' : 'TCG'}'" />`
      : (item.type === 'sealed' ? 'BOX' : 'TCG');

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
          <button class="action-btn" title="DE-Preis direkt anpassen" onclick="openSnapshotModal('${item.id}')">DE €</button>
          ${cmUrl ? `<a class="action-btn" href="${escapeHtml(cmUrl)}" target="_blank" rel="noopener" title="Auf Cardmarket (Deutsch) öffnen">CM ↗</a>` : ''}
          <button class="action-btn" title="Bearbeiten" onclick="openEditModal('${item.id}')">Bearbeiten</button>
          <button class="action-btn delete" title="Aus Portfolio löschen" onclick="deleteItem('${item.id}')">Löschen</button>
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
    // [idProduct, name, displayNameDe, type('s'|'c'), categoryName, expansionName, expansionCode, dePrice, low, trend, avg30, idCategory]
    const [idProduct, name, displayNameDe, shortType, categoryName, expansionName, expansionCode, dePrice, low, trend, avg30, idCategory] = row;
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

    const ext = itemType === 'sealed' ? 'png' : 'jpg';
    results.push({
      idProduct,
      name,
      displayNameDe: displayNameDe || name,
      type: itemType,
      categoryName,
      expansionName,
      expansionCode,
      imageUrl: `./images/${idProduct}.${ext}`,
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
      const imgUrl = prod.imageUrl || (isStaticMode ? `./images/${prod.idProduct}.${prod.type === 'sealed' ? 'png' : 'jpg'}` : `/api/cm-image/${prod.idProduct}`);
      const setLabel = prod.expansionName ? `${escapeHtml(prod.expansionName)} • ` : '';
      const mainTitle = prod.displayNameDe || prod.name;
      const showOriginalSub = prod.displayNameDe && prod.displayNameDe !== prod.name;

      div.innerHTML = `
        <div class="catalog-thumb">
          <img src="${escapeHtml(imgUrl)}" loading="lazy" alt="" onerror="this.parentElement.textContent='${prod.type === 'sealed' ? 'BOX' : 'TCG'}'" />
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
  const imgUrl = prod.imageUrl || (isStaticMode ? `./images/${prod.idProduct}.${prod.type === 'sealed' ? 'png' : 'jpg'}` : `/api/cm-image/${prod.idProduct}`);
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

  thumbEl.innerHTML = `<img src="${escapeHtml(imgUrl)}" alt="" onerror="this.parentElement.textContent='${prod.type === 'sealed' ? 'BOX' : 'TCG'}'" />`;
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

  if (!isStaticMode) {
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

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

document.addEventListener('DOMContentLoaded', () => {
  pollCatalogStatus();
  fetchPortfolio();

  document.getElementById('btnOpenAddModal').addEventListener('click', openAddModal);
  document.getElementById('btnEmptyAdd').addEventListener('click', openAddModal);
  document.getElementById('btnCloseModal').addEventListener('click', closeAddModal);
  document.getElementById('btnCancelModal').addEventListener('click', closeAddModal);

  document.getElementById('btnCloseSnapshotModal').addEventListener('click', closeSnapshotModal);
  document.getElementById('btnCancelSnapshot').addEventListener('click', closeSnapshotModal);

  // Export Backup (for Google Drive / iCloud / GitHub)
  document.getElementById('btnExportBackup').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify({ items: portfolioItems }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `portfolio.json`;
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
        alert(`${portfolioItems.length} Einträge erfolgreich geladen!`);
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

    if (!isStaticMode) {
      await fetch('/api/refresh-catalog', { method: 'POST' });
      setTimeout(async () => {
        await pollCatalogStatus();
        await fetchPortfolio();
      }, 1500);
    } else {
      staticCatalogItems = null;
      await fetchPortfolio();
      badge.className = 'status-pill ready';
      text.textContent = 'Preise synchronisiert';
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

    if (!isStaticMode) {
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
      // Static / iPhone mode
      const today = new Date().toISOString().slice(0, 10);
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
        portfolioItems.unshift({
          id: 'item_' + Date.now(),
          idProduct: payload.idProduct ? Number(payload.idProduct) : null,
          name: payload.name,
          displayNameDe: payload.name,
          type: payload.type,
          categoryName: lastSelectedCatalogProd?.categoryName || (payload.type === 'sealed' ? 'Sealed' : 'Single'),
          expansionName: lastSelectedCatalogProd?.expansionName || '',
          isHolo: payload.isHolo,
          condition: payload.condition,
          language: payload.language,
          quantity: payload.quantity,
          buyPrice: payload.buyPrice,
          buyDate: payload.buyDate || today,
          customLowPrice: customLow,
          imageUrl: payload.imageUrl,
          cardmarketUrl: payload.cardmarketUrl,
          marketPrices: {
            dePrice: pr.dePrice ?? eff,
            low: pr.low ?? eff,
            trend: pr.trend ?? eff,
            avg30: pr.avg30 ?? eff,
            updatedAt: today
          },
          priceHistory: [
            { date: today, low: Number(eff.toFixed(2)), trend: Number((pr.trend ?? eff).toFixed(2)), label: 'Heute' }
          ],
          createdAt: new Date().toISOString()
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

    if (!isStaticMode) {
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
