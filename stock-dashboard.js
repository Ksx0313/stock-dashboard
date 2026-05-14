// ============================================================
//  台股技術分析儀表板 Web 版 v1.3
//  資料源：Yahoo Finance（多 CORS proxy） + Google Gemini API
//  新增：監控清單動態管理（新增/刪除/儲存到 localStorage）
// ============================================================

// 預設監控清單（首次使用時載入）
const DEFAULT_WATCH_LIST = [
  { code: '2330', name: '台積電',   type: 'TW'  },
  { code: '2371', name: '大同',     type: 'TW'  },
  { code: '2454', name: '聯發科',   type: 'TW'  },
  { code: '4375', name: '台光電',   type: 'TWO' },
  { code: '2308', name: '台達電',   type: 'TW'  },
  { code: '2881', name: '富邦金',   type: 'TW'  },
  { code: '2355', name: '敬鵬',     type: 'TW'  },
  { code: '1815', name: '富喬',     type: 'TW'  },
  { code: '1802', name: '台玻',     type: 'TW'  },
  { code: '6265', name: '方土昶',   type: 'TWO' },
  { code: '2313', name: '華通',     type: 'TW'  },
  { code: '4958', name: '臻鼎-KY',  type: 'TW'  },
  { code: '6217', name: '中探針',   type: 'TWO' },
  { code: '4772', name: '台特化',   type: 'TWO' },
];

// 動態載入監控清單
let WATCH_LIST = loadWatchList();
let currentStock = null;
let priceChart = null;
let chartRange = '4mo';

function loadWatchList() {
  try {
    const saved = localStorage.getItem('watchList');
    if (saved) {
      const arr = JSON.parse(saved);
      if (Array.isArray(arr) && arr.length > 0) return arr;
    }
  } catch(e) {}
  return [...DEFAULT_WATCH_LIST];
}

function saveWatchList() {
  localStorage.setItem('watchList', JSON.stringify(WATCH_LIST));
}

window.addEventListener('DOMContentLoaded', () => {
  renderWatchlist();
  bindEvents();
  loadAllWatchlistPrices();

  if (!localStorage.getItem('geminiApiKey') && !localStorage.getItem('apiKeyDismissed')) {
    showApiKeyModal();
  }
});

function bindEvents() {
  document.getElementById('searchInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      const code = e.target.value.trim();
      if (code) {
        loadStock({ code, name: '', type: code.startsWith('6') || code.startsWith('5') ? 'TWO' : 'TW' });
        e.target.value = '';
      }
    }
  });
  document.getElementById('refreshAllBtn').addEventListener('click', loadAllWatchlistPrices);
  document.getElementById('settingsLink').addEventListener('click', showApiKeyModal);
  document.getElementById('apiKeySaveBtn').addEventListener('click', saveApiKey);
  document.getElementById('apiKeyCancelBtn').addEventListener('click', () => {
    localStorage.setItem('apiKeyDismissed', '1');
    hideApiKeyModal();
  });

  // Add stock modal
  document.getElementById('addStockBtn').addEventListener('click', showAddStockModal);
  document.getElementById('addStockCancelBtn').addEventListener('click', hideAddStockModal);
  document.getElementById('addStockSaveBtn').addEventListener('click', handleAddStock);
  document.getElementById('addStockCode').addEventListener('keydown', e => {
    if (e.key === 'Enter') handleAddStock();
  });
  document.getElementById('addStockName').addEventListener('keydown', e => {
    if (e.key === 'Enter') handleAddStock();
  });
}

// ─── Watchlist Management ───────────────────────────────────
function renderWatchlist() {
  const c = document.getElementById('watchlistContainer');
  if (WATCH_LIST.length === 0) {
    c.innerHTML = `<div class="watchlist-empty">
      📌 監控清單是空的<br>
      點上方「＋」新增股票
    </div>`;
    return;
  }
  c.innerHTML = WATCH_LIST.map((s, i) => `
    <div class="stock-item" data-index="${i}">
      <div class="stock-info" onclick="loadStock(WATCH_LIST[${i}])">
        <div class="stock-code">${s.code}</div>
        <div class="stock-name">${s.name || '—'}</div>
      </div>
      <div class="stock-price loading" id="wl-${s.code}">
        <div class="stock-price-val">—</div>
        <div class="stock-price-chg">—</div>
      </div>
      <button class="stock-delete" onclick="deleteStockFromList(${i})" title="移除">✕</button>
    </div>
  `).join('');
}

function deleteStockFromList(index) {
  const stock = WATCH_LIST[index];
  if (!confirm(`確定要從監控清單移除「${stock.code} ${stock.name}」嗎？`)) return;
  WATCH_LIST.splice(index, 1);
  saveWatchList();
  renderWatchlist();
  loadAllWatchlistPrices();
  showToast(`已移除 ${stock.code} ${stock.name}`, 'success');
}

function showAddStockModal() {
  document.getElementById('addStockModal').classList.add('show');
  document.getElementById('addStockCode').value = '';
  document.getElementById('addStockName').value = '';
  setTimeout(() => document.getElementById('addStockCode').focus(), 100);
}

function hideAddStockModal() {
  document.getElementById('addStockModal').classList.remove('show');
}

async function handleAddStock() {
  const code = document.getElementById('addStockCode').value.trim();
  const name = document.getElementById('addStockName').value.trim();

  if (!code) {
    showToast('請輸入股票代號', 'error');
    return;
  }
  if (!/^\d{4,6}[A-Z]?$/.test(code)) {
    showToast('股票代號格式不正確', 'error');
    return;
  }
  if (WATCH_LIST.some(s => s.code === code)) {
    showToast(`${code} 已在監控清單中`, 'error');
    return;
  }

  // 自動判斷上市/上櫃（6/5 開頭多為上櫃，但會自動嘗試）
  const type = (code.startsWith('6') || code.startsWith('5')) ? 'TWO' : 'TW';

  WATCH_LIST.push({ code, name: name || code, type });
  saveWatchList();
  renderWatchlist();
  hideAddStockModal();
  showToast(`已新增 ${code} ${name || ''}`, 'success');

  // 即時抓取新股票的價格
  try {
    const data = await fetchYahooQuote(code, type);
    if (data) {
      updateWatchlistPrice(code, data);
    } else {
      // 如果第一種類型失敗，自動換另一種
      const altType = type === 'TW' ? 'TWO' : 'TW';
      const altData = await fetchYahooQuote(code, altType);
      if (altData) {
        // 更新清單中的類型
        const idx = WATCH_LIST.findIndex(s => s.code === code);
        if (idx >= 0) {
          WATCH_LIST[idx].type = altType;
          saveWatchList();
        }
        updateWatchlistPrice(code, altData);
      }
    }
  } catch(e) { /* skip */ }
}

function showToast(message, type = 'info') {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.className = `toast show ${type}`;
  setTimeout(() => {
    toast.classList.remove('show');
  }, 2200);
}

async function loadAllWatchlistPrices() {
  for (const s of WATCH_LIST) {
    try {
      const data = await fetchYahooQuote(s.code, s.type);
      if (data) updateWatchlistPrice(s.code, data);
    } catch(e) { /* skip */ }
    await sleep(150);
  }
}

function updateWatchlistPrice(code, data) {
  const el = document.getElementById(`wl-${code}`);
  if (!el) return;
  const isUp = data.change >= 0;
  el.classList.remove('loading');
  el.classList.add(isUp ? 'up' : 'dn');
  el.innerHTML = `
    <div class="stock-price-val">${data.price.toFixed(2)}</div>
    <div class="stock-price-chg">${isUp ? '+' : ''}${data.changePct.toFixed(2)}%</div>
  `;
}

// ─── 資料抓取 (Yahoo Finance + CORS proxy) ──────────────────
async function fetchYahooQuote(code, type) {
  try {
    const data = await fetchYahooHistory(code, type, '5d');
    if (!data || data.length < 1) return null;
    const last = data[data.length - 1];
    const prev = data.length > 1 ? data[data.length - 2] : last;
    const change = last.close - prev.close;
    return {
      price: last.close,
      change,
      changePct: prev.close ? (change / prev.close * 100) : 0
    };
  } catch(e) { return null; }
}

async function fetchYahooHistory(code, type, range = '4mo') {
  const trySuffixes = type === 'TWO' ? ['.TWO', '.TW'] : ['.TW', '.TWO'];
  for (const suffix of trySuffixes) {
    const symbol = code + suffix;
    const baseUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=${range}`;

    const proxies = [
      `https://corsproxy.io/?${encodeURIComponent(baseUrl)}`,
      `https://api.allorigins.win/raw?url=${encodeURIComponent(baseUrl)}`,
      `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(baseUrl)}`,
      baseUrl,
    ];

    for (const proxyUrl of proxies) {
      try {
        const res = await fetch(proxyUrl, {
          method: 'GET',
          headers: { 'Accept': 'application/json' }
        });
        if (!res.ok) continue;
        const json = await res.json();
        if (!json.chart || !json.chart.result || !json.chart.result[0]) continue;
        const data = json.chart.result[0];
        const timestamps = data.timestamp || [];
        const quote = data.indicators.quote[0];
        const result = [];
        for (let i = 0; i < timestamps.length; i++) {
          if (quote.close[i] === null || quote.close[i] === undefined) continue;
          result.push({
            time: timestamps[i],
            date: new Date(timestamps[i] * 1000).toISOString().slice(0, 10),
            open: round2(quote.open[i] || quote.close[i]),
            high: round2(quote.high[i] || quote.close[i]),
            low:  round2(quote.low[i]  || quote.close[i]),
            close: round2(quote.close[i]),
            volume: Math.round(quote.volume[i] || 0),
          });
        }
        if (result.length > 0) return result;
      } catch(e) { /* try next proxy */ }
    }
  }
  return null;
}

function round2(v) { return Math.round(v * 100) / 100; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── 技術指標 ───────────────────────────────────────────────
function calcSMA(prices, period) {
  const r = new Array(prices.length).fill(null);
  for (let i = period - 1; i < prices.length; i++) {
    let s = 0;
    for (let j = i - period + 1; j <= i; j++) s += prices[j];
    r[i] = s / period;
  }
  return r;
}
function calcEMA(prices, period) {
  const k = 2 / (period + 1);
  const r = new Array(prices.length).fill(null);
  if (prices.length < period) return r;
  let s = 0;
  for (let i = 0; i < period; i++) s += prices[i];
  r[period - 1] = s / period;
  for (let i = period; i < prices.length; i++) {
    r[i] = prices[i] * k + r[i - 1] * (1 - k);
  }
  return r;
}
function calcMACD(prices, fast = 12, slow = 26, signal = 9) {
  const ef = calcEMA(prices, fast);
  const es = calcEMA(prices, slow);
  const dif = prices.map((_, i) => (ef[i] !== null && es[i] !== null) ? ef[i] - es[i] : null);
  const firstValid = dif.findIndex(v => v !== null);
  const macd = new Array(prices.length).fill(null);
  if (firstValid === -1) return prices.map(() => null);
  const k = 2 / (signal + 1);
  let ev = dif[firstValid];
  macd[firstValid] = ev;
  for (let i = firstValid + 1; i < dif.length; i++) {
    if (dif[i] === null) continue;
    ev = dif[i] * k + ev * (1 - k);
    macd[i] = ev;
  }
  return prices.map((_, i) => (dif[i] !== null && macd[i] !== null)
    ? { dif: dif[i], macd: macd[i], osc: dif[i] - macd[i] } : null);
}
function calcKD(highs, lows, closes, n = 9, ks = 3, ds = 3) {
  const r = new Array(closes.length).fill(null);
  let k = 50, d = 50;
  for (let i = n - 1; i < closes.length; i++) {
    let hn = highs[i - n + 1], ln = lows[i - n + 1];
    for (let j = i - n + 2; j <= i; j++) {
      if (highs[j] > hn) hn = highs[j];
      if (lows[j]  < ln) ln = lows[j];
    }
    const rsv = hn === ln ? 50 : ((closes[i] - ln) / (hn - ln)) * 100;
    k = ((ks - 1) * k + rsv) / ks;
    d = ((ds - 1) * d + k) / ds;
    r[i] = { k, d };
  }
  return r;
}
function calcRSI(prices, period = 14) {
  const r = new Array(prices.length).fill(null);
  if (prices.length < period + 1) return r;
  let g = 0, l = 0;
  for (let i = 1; i <= period; i++) {
    const d = prices[i] - prices[i-1];
    if (d > 0) g += d; else l -= d;
  }
  let ag = g / period, al = l / period;
  r[period] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  for (let i = period + 1; i < prices.length; i++) {
    const d = prices[i] - prices[i-1];
    ag = (ag * (period - 1) + Math.max(d, 0)) / period;
    al = (al * (period - 1) + Math.max(-d, 0)) / period;
    r[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return r;
}
function calcBoll(prices, period = 20, mult = 2) {
  const r = new Array(prices.length).fill(null);
  for (let i = period - 1; i < prices.length; i++) {
    const slice = prices.slice(i - period + 1, i + 1);
    const mean = slice.reduce((a,b) => a + b, 0) / period;
    const std = Math.sqrt(slice.reduce((a,b) => a + Math.pow(b - mean, 2), 0) / period);
    r[i] = { upper: mean + mult * std, mid: mean, lower: mean - mult * std };
  }
  return r;
}

// ─── 型態識別 ───────────────────────────────────────────────
function detectPattern(history) {
  if (history.length < 20) return { name: '資料不足', desc: '', color: 'neutral' };
  const closes = history.map(h => h.close);
  const recent = closes.slice(-30);
  const n = recent.length;
  const peaks = [], troughs = [];
  for (let i = 2; i < n - 2; i++) {
    if (recent[i] > recent[i-1] && recent[i] > recent[i-2] &&
        recent[i] > recent[i+1] && recent[i] > recent[i+2]) peaks.push({ idx: i, val: recent[i] });
    if (recent[i] < recent[i-1] && recent[i] < recent[i-2] &&
        recent[i] < recent[i+1] && recent[i] < recent[i+2]) troughs.push({ idx: i, val: recent[i] });
  }
  if (troughs.length >= 2) {
    const t1 = troughs[troughs.length-2], t2 = troughs[troughs.length-1];
    const tdiff = Math.abs(t1.val - t2.val) / t1.val;
    let midPeak = 0;
    for (let i = t1.idx; i <= t2.idx; i++) if (recent[i] > midPeak) midPeak = recent[i];
    const rebound = (midPeak - Math.min(t1.val, t2.val)) / Math.min(t1.val, t2.val);
    if (tdiff < 0.05 && rebound > 0.03 && recent[n-1] > midPeak)
      return { name: 'W 底完成 📈', desc: '突破頸線，多頭訊號確立，趨勢可能反轉向上', color: 'bull' };
    if (tdiff < 0.05 && rebound > 0.03)
      return { name: 'W 底成形中 📊', desc: '左底右底已現，等待突破頸線確認', color: 'neutral' };
  }
  if (peaks.length >= 2) {
    const p1 = peaks[peaks.length-2], p2 = peaks[peaks.length-1];
    const pdiff = Math.abs(p1.val - p2.val) / p1.val;
    let midTrough = Infinity;
    for (let i = p1.idx; i <= p2.idx; i++) if (recent[i] < midTrough) midTrough = recent[i];
    const pullback = (Math.max(p1.val, p2.val) - midTrough) / Math.max(p1.val, p2.val);
    if (pdiff < 0.05 && pullback > 0.03 && recent[n-1] < midTrough)
      return { name: 'M 頭跌破 📉', desc: '跌破頸線，空頭訊號確立，注意下跌風險', color: 'bear' };
    if (pdiff < 0.05 && pullback > 0.03)
      return { name: 'M 頭觀察中 ⚠️', desc: '雙頭型態出現，尚未跌破頸線，需謹慎', color: 'neutral' };
  }
  const ma5 = calcSMA(closes, 5);
  const ma20 = calcSMA(closes, 20);
  const last = closes.length - 1;
  if (ma5[last] && ma20[last]) {
    if (closes[last] > ma5[last] && ma5[last] > ma20[last])
      return { name: '多頭趨勢 📈', desc: '價格站上短中期均線，多頭排列確立', color: 'bull' };
    if (closes[last] < ma5[last] && ma5[last] < ma20[last])
      return { name: '空頭趨勢 📉', desc: '價格跌破短中期均線，空頭排列確立', color: 'bear' };
  }
  return { name: '盤整整理 📊', desc: '多空均衡，等待方向選擇', color: 'neutral' };
}

function detectCandle(history) {
  if (history.length < 3) return '資料不足';
  const r0 = history[history.length - 3];
  const r1 = history[history.length - 2];
  const r2 = history[history.length - 1];
  const body2 = Math.abs(r2.close - r2.open);
  const range2 = r2.high - r2.low || 0.001;
  const upper2 = r2.high - Math.max(r2.open, r2.close);
  const lower2 = Math.min(r2.open, r2.close) - r2.low;
  if (body2 < range2 * 0.1) return '十字線 — 多空轉折訊號';
  if (upper2 > body2 * 2 && r2.close < r2.open) return '長上影線 — 上方壓力大';
  if (lower2 > body2 * 2 && r2.close > r2.open) return '錘子線 — 底部反轉訊號';
  if (r0.close > r0.open && r1.close > r1.open && r2.close > r2.open &&
      r1.close > r0.close && r2.close > r1.close) return '紅三兵 🔴 — 多頭強勢';
  if (r0.close < r0.open && r1.close < r1.open && r2.close < r2.open &&
      r1.close < r0.close && r2.close < r1.close) return '三烏鴉 ⚫ — 空頭強勢';
  const b0 = Math.abs(r0.close - r0.open);
  const b1 = Math.abs(r1.close - r1.open);
  if (r0.close < r0.open && b1 < b0 * 0.3 && r2.close > r2.open && r2.close > (r0.open + r0.close) / 2)
    return '晨星 🌟 — 底部反轉';
  if (r0.close > r0.open && b1 < b0 * 0.3 && r2.close < r2.open && r2.close < (r0.open + r0.close) / 2)
    return '夜星 ⭐ — 頂部反轉';
  return r2.close >= r2.open ? '紅K — 多方主導' : '黑K — 空方主導';
}

function generateSignals(latest, ind) {
  const signals = [];
  const close = latest.close;
  if (ind.ma5 && ind.ma20 && ind.ma60) {
    if (ind.ma5 > ind.ma20 && ind.ma20 > ind.ma60) signals.push({ name: '均線排列', value: '多頭排列', type: 'bull' });
    else if (ind.ma5 < ind.ma20 && ind.ma20 < ind.ma60) signals.push({ name: '均線排列', value: '空頭排列', type: 'bear' });
    else signals.push({ name: '均線排列', value: '糾結', type: 'neutral' });
  }
  if (ind.ma20) signals.push({ name: 'MA20', value: close > ind.ma20 ? '站上' : '跌破', type: close > ind.ma20 ? 'bull' : 'bear' });
  if (ind.kd_k != null) {
    if (ind.kd_k > 80) signals.push({ name: 'KD', value: '超買區', type: 'bear' });
    else if (ind.kd_k < 20) signals.push({ name: 'KD', value: '超賣區', type: 'bull' });
    else signals.push({ name: 'KD', value: ind.kd_k > ind.kd_d ? '黃金交叉' : '死亡交叉', type: ind.kd_k > ind.kd_d ? 'bull' : 'bear' });
  }
  if (ind.macd_osc != null) signals.push({ name: 'MACD', value: ind.macd_osc > 0 ? '多頭' : '空頭', type: ind.macd_osc > 0 ? 'bull' : 'bear' });
  if (ind.rsi14 != null) {
    if (ind.rsi14 > 70) signals.push({ name: 'RSI', value: `超買 ${ind.rsi14.toFixed(1)}`, type: 'bear' });
    else if (ind.rsi14 < 30) signals.push({ name: 'RSI', value: `超賣 ${ind.rsi14.toFixed(1)}`, type: 'bull' });
    else signals.push({ name: 'RSI', value: ind.rsi14.toFixed(1), type: 'neutral' });
  }
  if (ind.boll_upper && close > ind.boll_upper) signals.push({ name: '布林', value: '突破上軌', type: 'bear' });
  else if (ind.boll_lower && close < ind.boll_lower) signals.push({ name: '布林', value: '跌破下軌', type: 'bull' });
  else signals.push({ name: '布林', value: '通道內', type: 'neutral' });
  return signals;
}

function calcAIProbability(history, ind) {
  let bullScore = 50, bearScore = 50;
  if (ind.ma5 && ind.ma20 && ind.ma60) {
    if (ind.ma5 > ind.ma20 && ind.ma20 > ind.ma60) bullScore += 12;
    else if (ind.ma5 < ind.ma20 && ind.ma20 < ind.ma60) bearScore += 12;
  }
  if (ind.kd_k != null && ind.kd_d != null) {
    if (ind.kd_k > ind.kd_d && ind.kd_k < 80) bullScore += 8;
    else if (ind.kd_k < ind.kd_d && ind.kd_k > 20) bearScore += 8;
  }
  if (ind.macd_osc != null) {
    if (ind.macd_osc > 0) bullScore += 6;
    else bearScore += 6;
  }
  if (ind.rsi14 != null) {
    if (ind.rsi14 < 30) bullScore += 8;
    else if (ind.rsi14 > 70) bearScore += 8;
    else if (ind.rsi14 > 50 && ind.rsi14 < 65) bullScore += 4;
    else if (ind.rsi14 < 50 && ind.rsi14 > 35) bearScore += 4;
  }
  if (history.length >= 5) {
    const recent5 = history.slice(-5);
    const avgChange = (recent5[4].close - recent5[0].close) / recent5[0].close;
    if (avgChange > 0.03) bullScore += 5;
    else if (avgChange < -0.03) bearScore += 5;
  }
  const total = bullScore + bearScore;
  return {
    bull: Math.round(bullScore / total * 100),
    bear: Math.round(bearScore / total * 100),
  };
}


// ─── FinMind 籌碼資料（瀏覽器端 Token）────────────────────────────
function getFinMindToken() {
  return (localStorage.getItem('finmindToken') || '').trim();
}

function getRecentStartDate(history, fallbackDays = 45) {
  if (history && history.length > 20) {
    return history[Math.max(0, history.length - fallbackDays)]?.date || history[0].date;
  }
  const d = new Date();
  d.setDate(d.getDate() - fallbackDays);
  return d.toISOString().slice(0, 10);
}

async function fetchFinMindData(dataset, params = {}) {
  const token = getFinMindToken();
  if (!token) return [];
  const url = new URL('https://api.finmindtrade.com/api/v4/data');
  url.searchParams.set('dataset', dataset);
  url.searchParams.set('token', token);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
  });
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok) throw new Error(`FinMind ${dataset} HTTP ${res.status}`);
  const json = await res.json();
  if (json.status && json.status !== 200) throw new Error(json.msg || `FinMind ${dataset} failed`);
  return Array.isArray(json.data) ? json.data : [];
}

async function fetchFinMindBrokerData(code, startDate, endDate) {
  const token = getFinMindToken();
  if (!token) return [];
  const url = new URL('https://api.finmindtrade.com/api/v4/taiwan_stock_trading_daily_report');
  url.searchParams.set('data_id', code);
  url.searchParams.set('start_date', startDate);
  if (endDate) url.searchParams.set('end_date', endDate);
  url.searchParams.set('token', token);
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok) throw new Error(`FinMind broker HTTP ${res.status}`);
  const json = await res.json();
  if (json.status && json.status !== 200) throw new Error(json.msg || 'FinMind broker failed');
  return Array.isArray(json.data) ? json.data : [];
}

async function fetchChipData(code, history) {
  if (!getFinMindToken()) {
    return { enabled: false, status: '未設定 FinMind Token' };
  }

  const startDate = getRecentStartDate(history, 45);
  const endDate = history?.[history.length - 1]?.date;
  const requests = {
    institutional: fetchFinMindData('TaiwanStockInstitutionalInvestorsBuySell', { data_id: code, start_date: startDate, end_date: endDate }),
    shareholding: fetchFinMindData('TaiwanStockShareholding', { data_id: code, start_date: startDate, end_date: endDate }),
    governmentBank: fetchFinMindData('TaiwanStockGovernmentBankBuySell', { data_id: code, start_date: startDate, end_date: endDate }),
    margin: fetchFinMindData('TaiwanStockMarginPurchaseShortSale', { data_id: code, start_date: startDate, end_date: endDate }),
    brokers: fetchFinMindBrokerData(code, startDate, endDate),
  };

  const entries = await Promise.all(Object.entries(requests).map(async ([key, promise]) => {
    try {
      return [key, await promise, null];
    } catch (err) {
      return [key, [], err.message];
    }
  }));

  const raw = Object.fromEntries(entries.map(([key, data]) => [key, data]));
  const errors = Object.fromEntries(entries.filter(([, , err]) => err).map(([key, , err]) => [key, err]));

  return {
    enabled: true,
    status: Object.keys(errors).length ? '部分籌碼資料無法取得' : '籌碼資料已載入',
    errors,
    startDate,
    endDate,
    institutional: summarizeInstitutional(raw.institutional),
    shareholding: summarizeShareholding(raw.shareholding),
    governmentBank: summarizeGovernmentBank(raw.governmentBank),
    margin: summarizeMargin(raw.margin),
    brokers: summarizeBrokers(raw.brokers),
  };
}

function toNumber(value) {
  if (value === null || value === undefined || value === '') return 0;
  if (typeof value === 'number') return value;
  const n = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function getRowDate(row) {
  return row.date || row.Date || row.transaction_date || '';
}

function netValue(row) {
  const direct = row.buy_sell ?? row.buy_sell_amount ?? row.net_buy_sell ?? row.BuySell ?? row.net;
  if (direct !== undefined && direct !== null && direct !== '') return toNumber(direct);
  return toNumber(row.buy ?? row.Buy ?? row.buy_amount) - toNumber(row.sell ?? row.Sell ?? row.sell_amount);
}

function latestRows(rows) {
  if (!rows || !rows.length) return [];
  const dates = [...new Set(rows.map(getRowDate).filter(Boolean))].sort();
  const latestDate = dates[dates.length - 1];
  return rows.filter(r => getRowDate(r) === latestDate);
}

function sumLastNDays(rows, n, predicate = () => true) {
  if (!rows || !rows.length) return 0;
  const dates = [...new Set(rows.map(getRowDate).filter(Boolean))].sort().slice(-n);
  const dateSet = new Set(dates);
  return rows
    .filter(r => dateSet.has(getRowDate(r)) && predicate(r))
    .reduce((sum, row) => sum + netValue(row), 0);
}

function normalizeInstType(row) {
  const raw = String(row.name || row.type || row.investor || row.InstitutionalInvestors || '').toLowerCase();
  if (raw.includes('foreign') || raw.includes('外資')) return 'foreign';
  if (raw.includes('trust') || raw.includes('投信')) return 'trust';
  if (raw.includes('dealer') || raw.includes('自營')) return 'dealer';
  return raw || 'other';
}

function summarizeInstitutional(rows) {
  const labels = { foreign: '外資', trust: '投信', dealer: '自營商' };
  const out = {};
  for (const key of Object.keys(labels)) {
    const pred = row => normalizeInstType(row) === key;
    out[key] = {
      label: labels[key],
      d1: sumLastNDays(rows, 1, pred),
      d5: sumLastNDays(rows, 5, pred),
      d20: sumLastNDays(rows, 20, pred),
    };
  }
  out.total = {
    label: '三大法人合計',
    d1: sumLastNDays(rows, 1),
    d5: sumLastNDays(rows, 5),
    d20: sumLastNDays(rows, 20),
  };
  return out;
}

function summarizeShareholding(rows) {
  const latest = latestRows(rows)[0];
  if (!latest) return null;
  const ratio = latest.ForeignInvestmentSharesRatio ?? latest.foreign_investment_shares_ratio ?? latest.ratio;
  const shares = latest.ForeignInvestmentShares ?? latest.foreign_investment_shares ?? latest.shares;
  return {
    date: getRowDate(latest),
    ratio: ratio === undefined ? null : toNumber(ratio),
    shares: shares === undefined ? null : toNumber(shares),
  };
}

function summarizeGovernmentBank(rows) {
  return {
    d1: sumLastNDays(rows, 1),
    d5: sumLastNDays(rows, 5),
    d20: sumLastNDays(rows, 20),
  };
}

function summarizeMargin(rows) {
  const latest = latestRows(rows)[0];
  if (!latest) return null;
  return {
    date: getRowDate(latest),
    marginBalance: toNumber(latest.MarginPurchaseTodayBalance ?? latest.margin_purchase_today_balance ?? latest.MarginPurchaseLimit),
    shortBalance: toNumber(latest.ShortSaleTodayBalance ?? latest.short_sale_today_balance ?? latest.ShortSaleLimit),
  };
}

function summarizeBrokers(rows) {
  const latest = latestRows(rows);
  const mapped = latest.map(row => {
    const buy = toNumber(row.buy ?? row.Buy);
    const sell = toNumber(row.sell ?? row.Sell);
    const net = netValue(row);
    return {
      name: row.securities_trader_name || row.SecuritiesTraderName || row.broker_name || row.name || row.securities_trader_id || '券商',
      buy,
      sell,
      net,
    };
  }).filter(row => row.net !== 0);
  const buyTop = [...mapped].sort((a, b) => b.net - a.net).slice(0, 5);
  const sellTop = [...mapped].sort((a, b) => a.net - b.net).slice(0, 5);
  const totalAbs = mapped.reduce((sum, row) => sum + Math.abs(row.net), 0);
  const topAbs = buyTop.concat(sellTop).reduce((sum, row) => sum + Math.abs(row.net), 0);
  return {
    date: latest[0] ? getRowDate(latest[0]) : '',
    buyTop,
    sellTop,
    concentration: totalAbs ? Math.round(topAbs / totalAbs * 100) : 0,
  };
}

function formatLots(value) {
  const lots = toNumber(value) / 1000;
  const abs = Math.abs(lots);
  if (!Number.isFinite(lots)) return '--';
  const text = abs >= 1000 ? lots.toLocaleString('zh-TW', { maximumFractionDigits: 0 }) : lots.toLocaleString('zh-TW', { maximumFractionDigits: 1 });
  return `${lots > 0 ? '+' : ''}${text}張`;
}

function formatSignedNumber(value, suffix = '') {
  const n = toNumber(value);
  return `${n > 0 ? '+' : ''}${n.toLocaleString('zh-TW', { maximumFractionDigits: 2 })}${suffix}`;
}

function chipValueClass(value) {
  const n = toNumber(value);
  return n > 0 ? 'up' : n < 0 ? 'dn' : '';
}

function renderChipDataPanel(chip) {
  if (!chip || !chip.enabled) {
    return `
      <div class="strategy-box" style="grid-column:1/-1;">
        <div class="label">FinMind 籌碼資料</div>
        <div class="value" style="font-size:13px;">未設定 Token</div>
      </div>
      <div style="font-size:11px;color:var(--text-2);margin-top:10px;">
        到設定填入 FinMind Token 後，會自動加入三大法人、外資持股、券商分點、八大行庫與融資融券資料。
      </div>
    `;
  }

  const inst = chip.institutional || {};
  const instRows = ['foreign', 'trust', 'dealer', 'total'].map(key => {
    const row = inst[key] || { label: key, d1: 0, d5: 0, d20: 0 };
    return `
      <div class="indicator-row">
        <span class="label">${row.label}</span>
        <span class="value ${chipValueClass(row.d1)}">${formatLots(row.d1)}</span>
        <span class="value ${chipValueClass(row.d5)}">${formatLots(row.d5)}</span>
        <span class="value ${chipValueClass(row.d20)}">${formatLots(row.d20)}</span>
      </div>`;
  }).join('');

  const brokers = chip.brokers || {};
  const brokerLine = list => (list || []).map(row => `${row.name} ${formatLots(row.net)}`).join('、') || '無資料';
  const share = chip.shareholding;
  const margin = chip.margin;

  return `
    <div style="font-size:11px;color:var(--text-2);margin-bottom:10px;">
      區間：${chip.startDate || '--'} ~ ${chip.endDate || '--'}；${chip.status || ''}
    </div>
    <div class="indicator-table" style="grid-template-columns:1fr;">
      <div class="indicator-row" style="color:var(--text-2);font-size:11px;">
        <span></span><span>1日</span><span>5日</span><span>20日</span>
      </div>
      ${instRows}
    </div>
    <div class="strategy-grid" style="margin-top:12px;">
      <div class="strategy-box"><div class="label">外資持股比</div><div class="value">${share?.ratio != null ? share.ratio.toFixed(2) + '%' : '--'}</div></div>
      <div class="strategy-box"><div class="label">八大行庫 5日</div><div class="value ${chipValueClass(chip.governmentBank?.d5)}">${formatLots(chip.governmentBank?.d5 || 0)}</div></div>
      <div class="strategy-box"><div class="label">分點集中度</div><div class="value">${brokers.concentration || 0}%</div></div>
      <div class="strategy-box"><div class="label">融資 / 融券</div><div class="value" style="font-size:12px;">${margin ? `${formatSignedNumber(margin.marginBalance)} / ${formatSignedNumber(margin.shortBalance)}` : '--'}</div></div>
    </div>
    <div style="font-size:11px;color:var(--text-1);margin-top:10px;line-height:1.7;">
      <div><b style="color:var(--up);">買超分點</b>：${brokerLine(brokers.buyTop)}</div>
      <div><b style="color:var(--dn);">賣超分點</b>：${brokerLine(brokers.sellTop)}</div>
    </div>
  `;
}

function buildChipPrompt(chip) {
  if (!chip || !chip.enabled) return '- 籌碼資料：未設定 FinMind Token';
  const inst = chip.institutional || {};
  const brokers = chip.brokers || {};
  const topBuy = brokers.buyTop?.[0];
  const topSell = brokers.sellTop?.[0];
  return `
- 外資買賣超 1/5/20日：${formatLots(inst.foreign?.d1 || 0)} / ${formatLots(inst.foreign?.d5 || 0)} / ${formatLots(inst.foreign?.d20 || 0)}
- 投信買賣超 1/5/20日：${formatLots(inst.trust?.d1 || 0)} / ${formatLots(inst.trust?.d5 || 0)} / ${formatLots(inst.trust?.d20 || 0)}
- 自營商買賣超 1/5/20日：${formatLots(inst.dealer?.d1 || 0)} / ${formatLots(inst.dealer?.d5 || 0)} / ${formatLots(inst.dealer?.d20 || 0)}
- 外資持股比例：${chip.shareholding?.ratio != null ? chip.shareholding.ratio.toFixed(2) + '%' : '無資料'}
- 八大行庫 1/5/20日：${formatLots(chip.governmentBank?.d1 || 0)} / ${formatLots(chip.governmentBank?.d5 || 0)} / ${formatLots(chip.governmentBank?.d20 || 0)}
- 分點集中度：${brokers.concentration || 0}%；買超最大：${topBuy ? topBuy.name + ' ' + formatLots(topBuy.net) : '無'}；賣超最大：${topSell ? topSell.name + ' ' + formatLots(topSell.net) : '無'}`.trim();
}

async function loadStock(stock) {
  currentStock = stock;
  document.querySelectorAll('.stock-item').forEach(el => el.classList.remove('active'));
  const idx = WATCH_LIST.findIndex(s => s.code === stock.code);
  if (idx >= 0) document.querySelector(`.stock-item[data-index="${idx}"]`)?.classList.add('active');

  const main = document.getElementById('mainContent');
  main.innerHTML = `<div class="loading-state"><div class="spinner"></div>載入 ${stock.code} ${stock.name} 中...</div>`;

  try {
    let history = await fetchYahooHistory(stock.code, stock.type, '4mo');
    // 如果失敗，嘗試另一個市場類型
    if (!history || history.length < 20) {
      const altType = stock.type === 'TW' ? 'TWO' : 'TW';
      history = await fetchYahooHistory(stock.code, altType, '4mo');
      if (history && history.length >= 20) {
        stock.type = altType;
        // 如果在監控清單中，更新類型
        const watchIdx = WATCH_LIST.findIndex(s => s.code === stock.code);
        if (watchIdx >= 0) {
          WATCH_LIST[watchIdx].type = altType;
          saveWatchList();
        }
      }
    }
    if (!history || history.length < 20) {
      main.innerHTML = `<div class="error-banner">⚠ 無法取得 ${stock.code} 的資料，請確認代號是否正確</div>`;
      return;
    }
    if (!stock.name) stock.name = stock.code;
    const chip = await fetchChipData(stock.code, history);
    renderDashboard(stock, history, chip);
  } catch(e) {
    main.innerHTML = `<div class="error-banner">⚠ 載入失敗：${e.message}</div>`;
  }
}

function renderDashboard(stock, history, chip = null) {
  const closes = history.map(h => h.close);
  const highs  = history.map(h => h.high);
  const lows   = history.map(h => h.low);

  const last = history.length - 1;
  const ma5  = calcSMA(closes, 5);
  const ma10 = calcSMA(closes, 10);
  const ma20 = calcSMA(closes, 20);
  const ma60 = calcSMA(closes, 60);
  const macdArr = calcMACD(closes);
  const kdArr   = calcKD(highs, lows, closes);
  const rsiArr  = calcRSI(closes);
  const bollArr = calcBoll(closes);

  const macd = macdArr[last] || {};
  const kd   = kdArr[last]   || {};
  const boll = bollArr[last] || {};

  const indicators = {
    ma5: ma5[last], ma10: ma10[last], ma20: ma20[last], ma60: ma60[last],
    kd_k: kd.k, kd_d: kd.d,
    macd_dif: macd.dif, macd_macd: macd.macd, macd_osc: macd.osc,
    rsi14: rsiArr[last],
    boll_upper: boll.upper, boll_mid: boll.mid, boll_lower: boll.lower,
  };

  const latest = history[last];
  const prev = history[last - 1] || latest;
  const change = round2(latest.close - prev.close);
  const changePct = round2(change / prev.close * 100);
  const isUp = change >= 0;

  const pattern = detectPattern(history);
  const candle = detectCandle(history);
  const signals = generateSignals(latest, indicators);
  const aiProb = calcAIProbability(history, indicators);

  const amp = round2((latest.high - latest.low) / prev.close * 100);
  const upLimit = round2(prev.close * 1.10);
  const dnLimit = round2(prev.close * 0.90);

  const hasGemini = !!localStorage.getItem('geminiApiKey');
  const inWatchlist = WATCH_LIST.some(s => s.code === stock.code);

  const main = document.getElementById('mainContent');
  main.innerHTML = `
    <div class="stock-header">
      <div class="stock-title">
        <h2>${stock.name || stock.code} <span class="code">${stock.code}</span>
          ${inWatchlist
            ? `<button class="add-to-watchlist added" disabled>✓ 已在監控清單</button>`
            : `<button class="add-to-watchlist" onclick="addCurrentToWatchlist()">+ 加入監控</button>`
          }
        </h2>
        <p>更新時間：${new Date().toLocaleString('zh-TW')} · 資料來源：Yahoo Finance</p>
      </div>
      <div class="price-display ${isUp ? 'up' : 'dn'}">
        <span class="price">${latest.close.toFixed(2)}</span>
        <span class="change">${isUp ? '▲' : '▼'} ${Math.abs(change).toFixed(2)} (${isUp ? '+' : ''}${changePct.toFixed(2)}%)</span>
      </div>
    </div>

    <div class="stats-row">
      <div class="stat-card"><div class="stat-label">開盤</div><div class="stat-value">${latest.open.toFixed(2)}</div></div>
      <div class="stat-card"><div class="stat-label">最高</div><div class="stat-value up">${latest.high.toFixed(2)}</div></div>
      <div class="stat-card"><div class="stat-label">最低</div><div class="stat-value dn">${latest.low.toFixed(2)}</div></div>
      <div class="stat-card"><div class="stat-label">昨收</div><div class="stat-value">${prev.close.toFixed(2)}</div></div>
      <div class="stat-card"><div class="stat-label">成交量</div><div class="stat-value">${formatVolume(latest.volume)}</div></div>
      <div class="stat-card"><div class="stat-label">振幅</div><div class="stat-value gold">${amp.toFixed(2)}%</div></div>
      <div class="stat-card"><div class="stat-label">漲停價</div><div class="stat-value up">${upLimit.toFixed(2)}</div></div>
      <div class="stat-card"><div class="stat-label">跌停價</div><div class="stat-value dn">${dnLimit.toFixed(2)}</div></div>
    </div>

    <div class="grid-3">
      <div class="panel">
        <div class="panel-title">
          <span>📈 日K線圖</span>
          <span class="badge">${history.length} 個交易日</span>
        </div>
        <div class="chart-toolbar">
          <button data-range="1mo">1月</button>
          <button data-range="3mo">3月</button>
          <button data-range="4mo" class="active">4月</button>
          <button data-range="6mo">6月</button>
          <button data-range="1y">1年</button>
        </div>
        <div id="priceChart" class="chart-container"></div>
      </div>

      <div class="panel ai-panel">
        <div class="panel-title"><span>🤖 AI 漲跌機率</span></div>
        <div class="ai-gauge">
          <canvas id="aiGauge"></canvas>
          <div class="ai-gauge-center">
            <div class="ai-gauge-value" style="color: ${aiProb.bull >= 50 ? 'var(--up)' : 'var(--dn)'}">${aiProb.bull}%</div>
            <div class="ai-gauge-label">多頭機率</div>
          </div>
        </div>
        <div style="display:flex; justify-content:space-around; font-size:11px; margin-top:8px;">
          <div style="text-align:center;">
            <div style="color:var(--up); font-weight:600;">▲ ${aiProb.bull}%</div>
            <div style="color:var(--text-2);">看漲</div>
          </div>
          <div style="text-align:center;">
            <div style="color:var(--dn); font-weight:600;">▼ ${aiProb.bear}%</div>
            <div style="color:var(--text-2);">看跌</div>
          </div>
        </div>
      </div>

      <div class="panel">
        <div class="panel-title">📊 型態分析</div>
        <div class="pattern-card">
          <div class="name" style="color: var(--${pattern.color === 'bull' ? 'up' : pattern.color === 'bear' ? 'dn' : 'gold'})">
            ${pattern.name}
          </div>
          <div class="desc">${pattern.desc}</div>
        </div>
        <div class="pattern-card">
          <div class="name" style="color: var(--gold)">🕯️ K 線型態</div>
          <div class="desc">${candle}</div>
        </div>
      </div>
    </div>

    <div class="grid">
      <div class="panel">
        <div class="panel-title">📐 技術指標</div>
        <div class="indicator-table">
          <div class="indicator-row"><span class="label">MA5</span><span class="value" style="color:var(--gold)">${fmt(indicators.ma5)}</span></div>
          <div class="indicator-row"><span class="label">MA10</span><span class="value" style="color:var(--blue)">${fmt(indicators.ma10)}</span></div>
          <div class="indicator-row"><span class="label">MA20</span><span class="value" style="color:var(--purple)">${fmt(indicators.ma20)}</span></div>
          <div class="indicator-row"><span class="label">MA60</span><span class="value" style="color:var(--teal)">${fmt(indicators.ma60)}</span></div>
          <div class="indicator-row"><span class="label">KD-K</span><span class="value" style="color:var(--gold)">${fmt(indicators.kd_k, 1)}</span></div>
          <div class="indicator-row"><span class="label">KD-D</span><span class="value" style="color:var(--gold)">${fmt(indicators.kd_d, 1)}</span></div>
          <div class="indicator-row"><span class="label">DIF</span><span class="value">${fmt(indicators.macd_dif, 3)}</span></div>
          <div class="indicator-row"><span class="label">MACD</span><span class="value">${fmt(indicators.macd_macd, 3)}</span></div>
          <div class="indicator-row"><span class="label">OSC柱</span><span class="value ${indicators.macd_osc >= 0 ? 'up' : 'dn'}">${fmt(indicators.macd_osc, 3)}</span></div>
          <div class="indicator-row"><span class="label">RSI14</span><span class="value" style="color:var(--blue)">${fmt(indicators.rsi14, 1)}</span></div>
          <div class="indicator-row"><span class="label">布林上軌</span><span class="value" style="color:var(--dn)">${fmt(indicators.boll_upper)}</span></div>
          <div class="indicator-row"><span class="label">布林下軌</span><span class="value" style="color:var(--dn)">${fmt(indicators.boll_lower)}</span></div>
        </div>
      </div>

      <div class="panel">
        <div class="panel-title">🚦 綜合訊號</div>
        <div class="signals-list">
          ${signals.map(s => `
            <div class="signal-row">
              <span class="name">${s.name}</span>
              <span class="signal-badge signal-${s.type === 'bull' ? 'bull' : s.type === 'bear' ? 'bear' : 'neutral'}">${s.value}</span>
            </div>
          `).join('')}
        </div>
      </div>
    </div>

    <div class="panel">
      <div class="panel-title">
        <span>🧠 AI 深度分析</span>
        <span class="badge" id="aiBadge">${hasGemini ? 'Gemini AI' : '未設定 API'}</span>
      </div>
      <div id="aiAnalysis" class="ai-text loading">${hasGemini ? '🤖 AI 正在分析中...' : '💡 設定 Gemini API Key 即可啟用 AI 趨勢分析（免費）'}</div>
    </div>

    <div class="grid">
      <div class="panel">
        <div class="panel-title">🎯 操作策略</div>
        ${renderStrategy(latest, indicators, history)}
      </div>
      <div class="panel">
        <div class="panel-title">📊 量價概況</div>
        ${renderChipAnalysis(history, indicators)}
      </div>
      <div class="panel full-row">
        <div class="panel-title">
          <span>🏦 法人籌碼 / 分點</span>
          <span class="badge">${chip?.enabled ? 'FinMind' : '未設定 Token'}</span>
        </div>
        ${renderChipDataPanel(chip)}
      </div>
    </div>
  `;

  setTimeout(() => {
    renderPriceChart(history, ma5, ma10, ma20, ma60);
    renderAIGauge(aiProb.bull);
    bindChartToolbar(stock);
  }, 50);

  if (hasGemini) {
    runAIAnalysis(stock, latest, indicators, pattern, signals, history, chip);
  }
}

function addCurrentToWatchlist() {
  if (!currentStock) return;
  if (WATCH_LIST.some(s => s.code === currentStock.code)) {
    showToast(`${currentStock.code} 已在監控清單中`, 'error');
    return;
  }
  WATCH_LIST.push({
    code: currentStock.code,
    name: currentStock.name || currentStock.code,
    type: currentStock.type || 'TW',
  });
  saveWatchList();
  renderWatchlist();
  loadAllWatchlistPrices();
  showToast(`已加入 ${currentStock.code} 到監控清單`, 'success');
  // 重新渲染儀表板更新按鈕狀態
  loadStock(currentStock);
}

function fmt(v, digits = 2) {
  if (v === null || v === undefined || isNaN(v)) return '—';
  return v.toFixed(digits);
}
function formatVolume(v) {
  if (v >= 100000000) return (v / 100000000).toFixed(1) + '億';
  if (v >= 10000) return (v / 10000).toFixed(0) + '萬';
  return v.toString();
}

function renderStrategy(latest, ind, history) {
  const close = latest.close;
  let support = ind.ma20 || close * 0.95;
  let resistance = ind.boll_upper || close * 1.05;
  const recent = history.slice(-20);
  const lows = recent.map(h => h.low);
  const highs = recent.map(h => h.high);
  const recentLow = Math.min(...lows);
  const recentHigh = Math.max(...highs);
  support = round2(Math.max(support, recentLow * 1.005));
  resistance = round2(Math.min(resistance, recentHigh * 0.995));
  const stopLoss = round2(close * 0.95);
  const target = round2(close * 1.08);
  const risk = round2(close - stopLoss);
  const reward = round2(target - close);
  const rr = (reward / risk).toFixed(1);

  return `
    <div class="strategy-grid">
      <div class="strategy-box"><div class="label">支撐價</div><div class="value" style="color:var(--dn)">${support.toFixed(2)}</div></div>
      <div class="strategy-box"><div class="label">壓力價</div><div class="value" style="color:var(--up)">${resistance.toFixed(2)}</div></div>
      <div class="strategy-box"><div class="label">建議停損</div><div class="value" style="color:var(--dn)">${stopLoss.toFixed(2)}</div></div>
      <div class="strategy-box"><div class="label">目標價</div><div class="value" style="color:var(--up)">${target.toFixed(2)}</div></div>
      <div class="strategy-box"><div class="label">風險報酬比</div><div class="value" style="color:var(--gold)">1 : ${rr}</div></div>
      <div class="strategy-box"><div class="label">建議部位</div><div class="value">${rr >= 2 ? '可進場' : '觀望'}</div></div>
    </div>
  `;
}

function renderChipAnalysis(history, ind) {
  const recent = history.slice(-5);
  let buyVol = 0, sellVol = 0;
  for (const r of recent) {
    const ratio = r.high - r.low > 0 ? (r.close - r.low) / (r.high - r.low) : 0.5;
    buyVol += r.volume * ratio;
    sellVol += r.volume * (1 - ratio);
  }
  const total = buyVol + sellVol;
  const buyPct = total > 0 ? Math.round(buyVol / total * 100) : 50;
  const avg5Vol = recent.reduce((a, b) => a + b.volume, 0) / 5;
  const todayVol = history[history.length - 1].volume;
  const volRatio = avg5Vol > 0 ? Math.round(todayVol / avg5Vol * 100) : 100;

  return `
    <div style="margin-bottom:12px;">
      <div style="display:flex; justify-content:space-between; font-size:11px; color:var(--text-2); margin-bottom:5px;">
        <span>近5日買賣力道</span><span>${buyPct}% / ${100 - buyPct}%</span>
      </div>
      <div style="display:flex; height:10px; border-radius:5px; overflow:hidden; background:var(--bg-3);">
        <div style="width:${buyPct}%; background:var(--up);"></div>
        <div style="width:${100 - buyPct}%; background:var(--dn);"></div>
      </div>
    </div>
    <div class="strategy-grid">
      <div class="strategy-box"><div class="label">今日量能</div><div class="value">${formatVolume(todayVol)}</div></div>
      <div class="strategy-box"><div class="label">5日均量</div><div class="value">${formatVolume(avg5Vol)}</div></div>
      <div class="strategy-box"><div class="label">量比</div><div class="value ${volRatio > 120 ? 'up' : volRatio < 80 ? 'dn' : ''}">${volRatio}%</div></div>
      <div class="strategy-box"><div class="label">量價狀態</div><div class="value" style="font-size:13px;">${getVolumePriceStatus(history)}</div></div>
    </div>
    <div style="font-size:11px; color:var(--text-2); margin-top:10px; padding-top:10px; border-top:1px solid var(--border);">
      💡 註：完整三大法人 / 主力分點資料需付費 API。本面板使用價量推估買賣力道。
    </div>
  `;
}

function getVolumePriceStatus(history) {
  if (history.length < 2) return '—';
  const last = history[history.length - 1];
  const prev = history[history.length - 2];
  const priceUp = last.close > prev.close;
  const volUp = last.volume > prev.volume;
  if (priceUp && volUp) return '量增價漲 📈';
  if (priceUp && !volUp) return '量縮價漲 ⚠️';
  if (!priceUp && volUp) return '量增價跌 📉';
  return '量縮價跌';
}

function renderPriceChart(history, ma5arr, ma10arr, ma20arr, ma60arr) {
  const container = document.getElementById('priceChart');
  if (!container) return;
  container.innerHTML = '';

  if (priceChart) {
    try { priceChart.remove(); } catch(e) {}
    priceChart = null;
  }

  priceChart = LightweightCharts.createChart(container, {
    width: container.clientWidth,
    height: 360,
    layout: { background: { type: 'solid', color: '#0f1419' }, textColor: '#9ca3af' },
    grid: { vertLines: { color: '#1f2937' }, horzLines: { color: '#1f2937' } },
    rightPriceScale: { borderColor: '#1f2937' },
    timeScale: { borderColor: '#1f2937', timeVisible: false },
    crosshair: { mode: 1 },
  });

  const candleSeries = priceChart.addCandlestickSeries({
    upColor: '#ef4444', downColor: '#10b981',
    borderUpColor: '#ef4444', borderDownColor: '#10b981',
    wickUpColor: '#ef4444', wickDownColor: '#10b981',
  });
  candleSeries.setData(history.map(h => ({
    time: h.date, open: h.open, high: h.high, low: h.low, close: h.close
  })));

  const volumeSeries = priceChart.addHistogramSeries({
    priceFormat: { type: 'volume' },
    priceScaleId: '',
    scaleMargins: { top: 0.8, bottom: 0 },
  });
  volumeSeries.setData(history.map((h, i) => {
    const prev = i > 0 ? history[i-1].close : h.close;
    return {
      time: h.date, value: h.volume,
      color: h.close >= prev ? 'rgba(239,68,68,0.5)' : 'rgba(16,185,129,0.5)'
    };
  }));

  const addMA = (arr, color, name) => {
    const series = priceChart.addLineSeries({
      color, lineWidth: 1.5, priceLineVisible: false, lastValueVisible: false, title: name,
    });
    series.setData(history.map((h, i) => arr[i] !== null ? { time: h.date, value: arr[i] } : null).filter(Boolean));
  };
  addMA(ma5arr,  '#fbbf24', 'MA5');
  addMA(ma10arr, '#3b82f6', 'MA10');
  addMA(ma20arr, '#a78bfa', 'MA20');
  addMA(ma60arr, '#14b8a6', 'MA60');

  priceChart.timeScale().fitContent();

  const ro = new ResizeObserver(() => {
    if (priceChart && container) priceChart.applyOptions({ width: container.clientWidth });
  });
  ro.observe(container);
}

function renderAIGauge(bullPct) {
  const canvas = document.getElementById('aiGauge');
  if (!canvas) return;
  new Chart(canvas, {
    type: 'doughnut',
    data: {
      datasets: [{
        data: [bullPct, 100 - bullPct],
        backgroundColor: [bullPct >= 50 ? '#ef4444' : '#10b981', '#1f2937'],
        borderWidth: 0, circumference: 180, rotation: 270, cutout: '75%',
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
    }
  });
}

function bindChartToolbar(stock) {
  document.querySelectorAll('.chart-toolbar button').forEach(btn => {
    btn.addEventListener('click', async () => {
      document.querySelectorAll('.chart-toolbar button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const range = btn.getAttribute('data-range');
      const newHistory = await fetchYahooHistory(stock.code, stock.type, range);
      if (newHistory && newHistory.length > 5) {
        const closes = newHistory.map(h => h.close);
        renderPriceChart(newHistory, calcSMA(closes, 5), calcSMA(closes, 10), calcSMA(closes, 20), calcSMA(closes, 60));
      }
    });
  });
}

async function runAIAnalysis(stock, latest, ind, pattern, signals, history, chip = null) {
  const apiKey = localStorage.getItem('geminiApiKey');
  if (!apiKey) return;
  const el = document.getElementById('aiAnalysis');
  if (!el) return;

  const recent10 = history.slice(-10).map(h => `${h.date} ${h.close.toFixed(2)}`).join(', ');

  const prompt = `你是專業台股技術分析師。請針對「${stock.code} ${stock.name}」做簡潔的技術面分析（中文繁體，約 150 字內）。

最新資料：
- 收盤 ${latest.close}，當日 ${latest.high}/${latest.low}
- MA5/MA20/MA60: ${fmt(ind.ma5)}/${fmt(ind.ma20)}/${fmt(ind.ma60)}
- KD: ${fmt(ind.kd_k, 1)}/${fmt(ind.kd_d, 1)}
- RSI14: ${fmt(ind.rsi14, 1)}
- MACD OSC: ${fmt(ind.macd_osc, 3)}
- 趨勢型態: ${pattern.name}
- 近10日收盤: ${recent10}

籌碼面：
${buildChipPrompt(chip)}

請以四段呈現（用兩個換行分隔，不用標題符號）：
1. 趨勢判斷
2. 關鍵技術訊號
3. 風險提醒
4. 操作建議

直接輸出分析內容，不要前言。`;

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${apiKey}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.7, maxOutputTokens: 600 }
      })
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '無回應';
    el.classList.remove('loading');
    el.textContent = text;
  } catch(e) {
    el.classList.remove('loading');
    el.style.color = 'var(--up)';
    el.textContent = `❌ AI 分析失敗：${e.message}`;
  }
}

function showApiKeyModal() {
  document.getElementById('apiKeyModal').classList.add('show');
  document.getElementById('apiKeyInput').value = localStorage.getItem('geminiApiKey') || '';
  const finmindInput = document.getElementById('finmindTokenInput');
  if (finmindInput) finmindInput.value = localStorage.getItem('finmindToken') || '';
  setTimeout(() => document.getElementById('apiKeyInput').focus(), 100);
}
function hideApiKeyModal() {
  document.getElementById('apiKeyModal').classList.remove('show');
}
function saveApiKey() {
  const key = document.getElementById('apiKeyInput').value.trim();
  const finmindKey = document.getElementById('finmindTokenInput')?.value.trim() || '';
  if (key) {
    localStorage.setItem('geminiApiKey', key);
    localStorage.removeItem('apiKeyDismissed');
  } else {
    localStorage.removeItem('geminiApiKey');
  }
  if (finmindKey) {
    localStorage.setItem('finmindToken', finmindKey);
  } else {
    localStorage.removeItem('finmindToken');
  }
  hideApiKeyModal();
  if (currentStock) loadStock(currentStock);
}
