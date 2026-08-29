// Dashboard client: renders engine state and streams live updates via SSE.

const $ = (id) => document.getElementById(id);
const token = new URLSearchParams(location.search).get('token');
const authHeaders = token ? { 'x-dashboard-token': token } : {};
const qs = token ? `?token=${encodeURIComponent(token)}` : '';

const fmt = (n, dp = 2) =>
  n === null || n === undefined || Number.isNaN(n) ? '—' : Number(n).toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp });
const signed = (n) => (n > 0 ? '+' : '') + fmt(n);
const pnlClass = (n) => (n > 0 ? 'pos-pnl' : n < 0 ? 'neg-pnl' : '');

// --- Tabs -----------------------------------------------------------------
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.tabpane').forEach((p) => p.classList.remove('active'));
    tab.classList.add('active');
    $(`tab-${tab.dataset.tab}`).classList.add('active');
  });
});

// --- Render state ---------------------------------------------------------
function renderState(s) {
  if (!s) return;
  $('equity').textContent = '$' + fmt(s.equity);
  const net = s.stats.netPnlUsdt;
  $('netPnl').textContent = signed(net);
  $('netPnl').className = 'value ' + pnlClass(net);
  $('dayPnl').textContent = signed(s.stats.dayPnlUsdt);
  $('dayPnl').className = 'value ' + pnlClass(s.stats.dayPnlUsdt);
  $('bias').textContent = (s.bias || 'neutral').toUpperCase();
  $('price').textContent = s.lastPrice ? '$' + fmt(s.lastPrice) : '—';
  $('winRate').textContent = fmt(s.stats.winRatePct, 1) + '%';
  $('expectancy').textContent = fmt(s.stats.expectancyR, 2) + 'R';
  $('profitFactor').textContent = s.stats.profitFactor === null || s.stats.profitFactor === Infinity ? '∞' : fmt(s.stats.profitFactor, 2);

  const modeBadge = $('modeBadge');
  modeBadge.textContent = s.mode; modeBadge.className = 'badge ' + (s.mode === 'paper' ? 'paper' : 'live-on');
  const liveBadge = $('liveBadge');
  liveBadge.textContent = s.liveEnabled ? 'LIVE ON' : 'live off';
  liveBadge.className = 'badge ' + (s.liveEnabled ? 'live-on' : '');

  const kb = $('killBanner');
  if (s.killSwitch.daily || s.killSwitch.weekly) {
    kb.classList.remove('hidden');
    kb.textContent = '🛑 KILL SWITCH ACTIVE — ' + s.killSwitch.reason + '. No new trades will be opened.';
  } else kb.classList.add('hidden');

  renderPositions(s.openPositions);
  renderSignals(s.recentSignals);
  renderLiquidity(s.liquidity, s.lastPrice);
  renderLearned(s.learned);
}

function renderLiquidity(liq, price) {
  const el = $('liquidity');
  if (!el) return;
  if (!liq) { el.innerHTML = '<p class="muted">Waiting for data…</p>'; return; }
  const pool = (p, label, cls) => !p ? '' : `
    <div class="liq-row ${cls}">
      <span class="liq-tag">${label}</span>
      <b>$${fmt(p.price)}</b>
      <span class="muted">${p.distancePct}% away${p.touches > 1 ? ' · ×' + p.touches : ''}</span>
    </div>`;
  // Buy-side above (sell / long target), sell-side below (buy / short target).
  const above = (liq.buySide || []).slice(0, 3).map((p, i) =>
    pool(p, i === 0 ? 'SELL ▲ nearest' : 'buy-side ▲', 'sell')).join('');
  const below = (liq.sellSide || []).slice(0, 3).map((p, i) =>
    pool(p, i === 0 ? 'BUY ▼ nearest' : 'sell-side ▼', 'buy')).join('');
  el.innerHTML = above +
    `<div class="liq-price">price $${fmt(price)}</div>` + below ||
    '<p class="muted">No clear pools yet.</p>';
}

function renderLearned(l) {
  const el = $('learned');
  if (!el) return;
  if (!l) { el.innerHTML = '<p class="muted">Loading…</p>'; return; }
  const when = l.trainedAt ? new Date(l.trainedAt).toLocaleString() : 'shipping default (not yet trained)';
  el.innerHTML = `
    <div class="kv">
      <div><span>Target</span> <b>${l.targetMode}</b></div>
      <div><span>Stop</span> <b>${l.stopMode}</b></div>
      <div><span>Exit</span> <b>${l.exit}</b></div>
      <div><span>Min conf</span> <b>${l.minConfluence}</b></div>
      <div><span>Min R:R</span> <b>${l.minRiskReward}</b></div>
      <div><span>Liq gate</span> <b>${l.liqProximityPct > 0 ? '≤' + l.liqProximityPct + '%' : 'off'}</b></div>
      <div><span>Channel</span> <b>${l.channelFilter ? 'filter' : 'off'}</b></div>
    </div>
    <div class="reasons"><div>trained: ${when}</div></div>`;
}

function renderPositions(positions) {
  const el = $('positions');
  if (!positions || positions.length === 0) { el.innerHTML = '<p class="muted">No open positions.</p>'; return; }
  el.innerHTML = positions.map((p) => `
    <div class="pos">
      <div class="pos-head">
        <span class="dir ${p.side}">${p.side.toUpperCase()}</span>
        <button class="btn-close" data-id="${p.id}">Close</button>
      </div>
      <div class="kv">
        <div><span>Entry</span> <b>${fmt(p.entry)}</b></div>
        <div><span>Size</span> <b>${fmt(p.sizeContracts, 4)} ETH</b></div>
        <div><span>Stop</span> <b>${fmt(p.stopLoss)}</b></div>
        <div><span>Target</span> <b>${fmt(p.takeProfit)}</b></div>
        <div><span>Liq.</span> <b>${fmt(p.liquidationPrice)}</b></div>
        <div><span>Lev</span> <b>${p.leverage}x · ${p.mode}</b></div>
      </div>
    </div>`).join('');
  el.querySelectorAll('.btn-close').forEach((b) =>
    b.addEventListener('click', () => fetch(`/api/close/${b.dataset.id}${qs}`, { method: 'POST', headers: authHeaders })));
}

function renderSignals(signals) {
  const el = $('signals');
  if (!signals || signals.length === 0) { el.innerHTML = '<p class="muted">Waiting for setups…</p>'; return; }
  el.innerHTML = signals.map((sig) => `
    <div class="sig">
      <div class="sig-head">
        <span class="dir ${sig.side}">${sig.side.toUpperCase()} · ${sig.source}</span>
        <b>${fmt(sig.confluence, 0)}%</b>
      </div>
      <div class="kv">
        <div><span>Entry</span> <b>${fmt(sig.entry)}</b></div>
        <div><span>R:R</span> <b>${fmt(sig.riskReward, 2)}</b></div>
        <div><span>Stop</span> <b>${fmt(sig.stopLoss)}</b></div>
        <div><span>Target</span> <b>${fmt(sig.takeProfit)}</b></div>
      </div>
      ${sig.drawTarget != null ? `
      <div class="draw">
        <span class="tag">${sig.drawTimeframe || ''} DRAW</span>
        ${sig.sweepSide || ''} swept @ <b>${fmt(sig.sweptLevel)}</b>
        → drawn to <b>${fmt(sig.drawTarget)}</b>
      </div>` : ''}
      <div class="conf-bar"><div class="conf-fill" style="width:${Math.min(100, sig.confluence)}%"></div></div>
      <div class="reasons">${(sig.reasons || []).map((r) => `<div>› ${r}</div>`).join('')}</div>
    </div>`).join('');
}

async function loadJournal() {
  const rows = await fetch(`/api/journal${qs}`, { headers: authHeaders }).then((r) => r.json());
  const tb = document.querySelector('#journalTable tbody');
  if (!rows.length) { tb.innerHTML = '<tr><td colspan="8" class="muted">No trades yet.</td></tr>'; return; }
  tb.innerHTML = rows.map((t) => `
    <tr>
      <td>${new Date(t.closedAt).toLocaleString()}</td>
      <td class="dir ${t.side}">${t.side}</td>
      <td>${fmt(t.entry)}</td><td>${fmt(t.exit)}</td>
      <td>${fmt(t.rMultiple, 2)}</td>
      <td class="${pnlClass(t.pnlUsdt)}">${signed(t.pnlUsdt)}</td>
      <td>${t.reason}</td><td>${t.mode}</td>
    </tr>`).join('');
}

async function loadCurriculum() {
  const data = await fetch(`/api/curriculum${qs}`, { headers: authHeaders }).then((r) => r.json());
  $('philosophy').textContent = data.philosophy;
  $('curriculum').innerHTML = data.modules.map((m) => `
    <div class="module">
      <h3>${m.title}</h3>
      ${m.lessons.map((l) => `
        <div class="lesson">
          <div class="topic">${l.topic}</div>
          <div class="sum">${l.summary}</div>
          <div class="applied">↳ ${l.appliedIn}</div>
        </div>`).join('')}
    </div>`).join('');
}

async function loadLogs() {
  const logs = await fetch(`/api/logs${qs}`, { headers: authHeaders }).then((r) => r.json());
  $('logs').innerHTML = logs.map((l) =>
    `<div class="logline ${l.level}"><span class="t">${new Date(l.time).toLocaleTimeString()}</span> ${l.msg}</div>`).join('');
}

// --- Live stream ----------------------------------------------------------
function connect() {
  const es = new EventSource(`/api/stream${qs}`);
  es.addEventListener('open', () => { $('connBadge').textContent = 'live'; $('connBadge').className = 'badge ok'; });
  es.addEventListener('update', (e) => { renderState(JSON.parse(e.data)); loadJournal(); loadLogs(); });
  es.addEventListener('trade', () => loadJournal());
  es.onerror = () => { $('connBadge').textContent = 'reconnecting…'; $('connBadge').className = 'badge off'; };
}

// --- Auth: user chip, logout, 401 handling --------------------------------
function onUnauthorized(res) {
  if (res && res.status === 401) { location.href = '/login.html'; return true; }
  return false;
}

async function loadUser() {
  try {
    const me = await fetch('/auth/me').then((r) => r.json());
    if (!me.user) { location.href = '/login.html'; return; }
    $('userChip').textContent = me.user.username;
  } catch { /* ignore */ }
}

$('logoutBtn').addEventListener('click', async () => {
  await fetch('/auth/logout', { method: 'POST' });
  location.href = '/login.html';
});

// --- Settings -------------------------------------------------------------
const settingsFields = ['tradingMode', 'accountEquityUsdt', 'leverage', 'riskPerTradePct', 'maxDailyLossPct', 'minConfluence'];

async function loadSettings() {
  const res = await fetch(`/api/settings${qs}`, { headers: authHeaders });
  if (onUnauthorized(res)) return;
  const s = await res.json();
  settingsFields.forEach((k) => { if ($(k) && s[k] !== undefined) $(k).value = s[k]; });
  $('apiKey').value = '';
  $('apiKey').placeholder = s.apiKeyMasked ? `current: ${s.apiKeyMasked}` : 'paste your API key';
  $('apiKeyHint').textContent = s.apiKeyMasked ? 'A key is set. Leave blank to keep it.' : 'No API key set yet.';
  $('apiSecretHint').textContent = s.apiSecretSet
    ? 'A secret is set (encrypted). Leave blank to keep it.'
    : 'No secret set. Required for live trading.';
}

$('settingsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('settingsMsg');
  const payload = {};
  settingsFields.forEach((k) => { const v = $(k).value; if (v !== '') payload[k] = k === 'tradingMode' ? v : Number(v); });
  if ($('apiKey').value.trim() !== '') payload.apiKey = $('apiKey').value.trim();
  if ($('apiSecret').value !== '') payload.apiSecret = $('apiSecret').value;

  if (payload.tradingMode === 'live') {
    if (!confirm('Enable LIVE trading? Real leveraged orders will be placed on Bitunix. Continue?')) return;
  }
  msg.textContent = 'Saving…'; msg.className = 'muted';
  const res = await fetch(`/api/settings${qs}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders },
    body: JSON.stringify(payload),
  });
  if (onUnauthorized(res)) return;
  const data = await res.json();
  if (data.ok) { msg.textContent = 'Saved ✓'; msg.className = 'pos-pnl'; $('apiSecret').value = ''; loadSettings(); }
  else { msg.textContent = data.error || 'Save failed'; msg.className = 'neg-pnl'; }
});

// --- Init -----------------------------------------------------------------
loadUser();
fetch(`/api/state${qs}`, { headers: authHeaders }).then((r) => { if (onUnauthorized(r)) return; return r.json(); }).then((s) => s && renderState(s)).catch(() => {});
loadJournal(); loadCurriculum(); loadLogs(); loadSettings(); connect();
setInterval(loadLogs, 15000);
