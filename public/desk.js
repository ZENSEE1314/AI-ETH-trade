// Desk tab: dense trading-terminal view. app.js feeds it engine state, the
// trade journal and Polymarket updates through window.desk.

(() => {
  const $ = (id) => document.getElementById(id);
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const money = (n) => (n === null || n === undefined || Number.isNaN(n) ? '—'
    : (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  const sMoney = (n) => (n > 0 ? '+' : '') + money(n);
  const cents = (x) => (x * 100).toFixed(1) + '¢';
  const cls = (n) => (n > 0 ? 'pos-pnl' : n < 0 ? 'neg-pnl' : '');
  const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  let engine = null; let poly = null; let journal = []; let candles = [];
  const qs = window.deskQs || ''; const headers = window.deskHeaders || {};

  // --- Canvas helpers -------------------------------------------------------
  function sized(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth; const h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w, h };
  }
  function axisText(ctx, text, x, y, align = 'left') {
    ctx.fillStyle = css('--muted'); ctx.font = '10px ui-monospace, monospace';
    ctx.textAlign = align; ctx.textBaseline = 'middle'; ctx.fillText(text, x, y);
  }

  // --- Clock + ticker -------------------------------------------------------
  setInterval(() => { $('tkClock').textContent = new Date().toISOString().slice(11, 19); }, 1000);

  function renderTicker() {
    if (engine) $('tkEth').textContent = engine.lastPrice ? '$' + Number(engine.lastPrice).toFixed(2) : '—';
    const q = (a) => poly?.quotes?.find((x) => x.asset === a);
    const setTxt = (a) => { const x = q(a); return x ? `${x.cost.toFixed(3)} (${x.edge >= 0 ? '+' : ''}${cents(x.edge)})` : '—'; };
    $('tkBtcSet').textContent = setTxt('btc');
    $('tkEthSet').textContent = setTxt('eth');
    if (poly) { const t = poly.realizedPnl + poly.lockedPnl; $('tkPoly').textContent = sMoney(t); $('tkPoly').className = cls(t); }
  }

  function renderFeed() {
    const parts = [];
    for (const s of (engine?.recentSignals || []).slice(0, 6)) {
      parts.push(`${(s.symbol || '').replace('USDT', '')} ${s.side.toUpperCase()} @ ${s.entry}${s.rejectReason ? ' · rejected' : ''}`);
    }
    for (const q of poly?.quotes || []) parts.push(`${q.asset.toUpperCase()} set ${q.cost.toFixed(3)} · edge ${cents(q.edge)}`);
    for (const p of (poly?.recent || []).slice(0, 4)) parts.push(`SETTLED ${p.asset.toUpperCase()} ${p.sets} sets +$${(p.pnl ?? 0).toFixed(2)}`);
    $('feedText').textContent = parts.length ? parts.join('   •   ') : 'Waiting for market data…';
  }

  // --- Wallet ---------------------------------------------------------------
  function renderWallet() {
    const perp = engine?.stats?.netPnlUsdt ?? 0;
    const pp = poly ? poly.realizedPnl : 0;
    const total = perp + pp;
    $('wHero').textContent = sMoney(total); $('wHero').className = 'hero ' + cls(total);
    $('wMode').textContent = engine?.mode || 'paper';
    $('wPerp').textContent = sMoney(perp); $('wPerp').className = cls(perp);
    $('wPoly').textContent = poly ? sMoney(pp) + (poly.lockedPnl ? ` (+${poly.lockedPnl.toFixed(2)} locked)` : '') : '—';
    $('wPoly').className = cls(pp);
    $('wFills').textContent = engine ? String(engine.stats.totalTrades ?? journal.length) : '—';
    $('wWin').textContent = engine ? Number(engine.stats.winRatePct || 0).toFixed(1) + '%' : '—';
    $('wSets').textContent = poly ? String(Math.round(poly.setsBought)) : '—';
    $('wCash').textContent = poly ? money(poly.cash) : '—';
    drawEquity();
  }

  function drawEquity() {
    const c = $('equityCanvas'); const { ctx, w, h } = sized(c);
    ctx.clearRect(0, 0, w, h);
    const rows = [...journal].sort((a, b) => a.closedAt - b.closedAt);
    if (rows.length < 2) { axisText(ctx, 'No closed trades yet', w / 2, h / 2, 'center'); return; }
    let cum = 0; const pts = [0, ...rows.map((t) => (cum += t.pnlUsdt))];
    const min = Math.min(...pts); const max = Math.max(...pts); const span = max - min || 1;
    const X = (i) => (i / (pts.length - 1)) * (w - 4) + 2; const Y = (v) => h - 4 - ((v - min) / span) * (h - 8);
    ctx.strokeStyle = css('--grid'); ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(0, Y(0)); ctx.lineTo(w, Y(0)); ctx.stroke();
    ctx.strokeStyle = cum >= 0 ? css('--green') : css('--red'); ctx.lineWidth = 2; ctx.lineJoin = 'round';
    ctx.beginPath(); pts.forEach((v, i) => (i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v)))); ctx.stroke();
  }

  // --- Price chart (candles + open-position lines, hover tooltip) -----------
  let priceGeom = null;
  function drawPrice() {
    const c = $('priceCanvas'); const { ctx, w, h } = sized(c);
    ctx.clearRect(0, 0, w, h);
    const bars = candles.slice(-80);
    if (!bars.length) { axisText(ctx, 'Waiting for candles…', w / 2, h / 2, 'center'); priceGeom = null; return; }
    const pos = (engine?.openPositions || []).filter((p) => p.symbol === engine.symbol);
    const levels = pos.flatMap((p) => [p.entry, p.stopLoss].filter((v) => v > 0));
    let lo = Math.min(...bars.map((b) => b.low)); let hi = Math.max(...bars.map((b) => b.high));
    for (const v of levels) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    const pad = (hi - lo) * 0.05 || 1; lo -= pad; hi += pad;
    const right = 56; const plotW = w - right; const step = plotW / bars.length; const bw = Math.max(1, step * 0.6);
    const Y = (v) => 6 + (1 - (v - lo) / (hi - lo)) * (h - 18);
    // recessive grid + right axis
    for (let i = 0; i <= 4; i++) {
      const v = lo + ((hi - lo) * i) / 4; const y = Y(v);
      ctx.strokeStyle = css('--grid'); ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(plotW, y); ctx.stroke();
      axisText(ctx, v.toFixed(v > 1000 ? 0 : 2), w - 2, y, 'right');
    }
    bars.forEach((b, i) => {
      const x = i * step + step / 2; const up = b.close >= b.open;
      ctx.strokeStyle = ctx.fillStyle = up ? css('--green') : css('--red');
      ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x, Y(b.high)); ctx.lineTo(x, Y(b.low)); ctx.stroke();
      const y1 = Y(Math.max(b.open, b.close)); const y2 = Y(Math.min(b.open, b.close));
      ctx.fillRect(x - bw / 2, y1, bw, Math.max(1, y2 - y1));
    });
    for (const p of pos) {
      for (const [v, label, color] of [[p.entry, `${p.side} entry`, css('--accent')], [p.stopLoss, 'stop', css('--amber')]]) {
        if (!(v > 0)) continue;
        ctx.strokeStyle = color; ctx.setLineDash([4, 3]); ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(0, Y(v)); ctx.lineTo(plotW, Y(v)); ctx.stroke(); ctx.setLineDash([]);
        axisText(ctx, label, 4, Y(v) - 7);
      }
    }
    const last = bars[bars.length - 1];
    $('chartLast').textContent = `last ${last.close}`;
    $('chartSym').textContent = (engine?.symbol || 'ETHUSDT').replace('USDT', '');
    priceGeom = { bars, step, plotW, Y, h };
  }
  $('priceCanvas').addEventListener('mousemove', (e) => {
    if (!priceGeom) return;
    const r = e.currentTarget.getBoundingClientRect(); const x = e.clientX - r.left;
    const i = Math.floor(x / priceGeom.step); const b = priceGeom.bars[i]; const tip = $('priceTip');
    if (!b || x > priceGeom.plotW) { tip.classList.add('hidden'); return; }
    tip.innerHTML = `${new Date(b.time).toISOString().slice(5, 16).replace('T', ' ')} UTC<br>O ${b.open} H ${b.high}<br>L ${b.low} C ${b.close}`;
    tip.style.left = Math.min(x + 18, r.width - 150) + 'px'; tip.style.top = '40px'; tip.classList.remove('hidden');
  });
  $('priceCanvas').addEventListener('mouseleave', () => $('priceTip').classList.add('hidden'));

  // --- Polymarket quotes / open sets / resolution grid ----------------------
  function renderPoly() {
    if (!poly) return;
    const st = $('polyStatus');
    if (!poly.enabled) st.textContent = 'disabled (POLY_ENABLED=false)';
    else if (poly.lastError) st.textContent = 'error: ' + poly.lastError;
    else st.textContent = `${poly.windowMin}m windows · fee ${poly.feePct}% · min edge ${cents(poly.minEdge)}`;

    $('polyQuotes').innerHTML = poly.quotes.length ? poly.quotes.map((q) => {
      const left = Math.max(0, Math.round((q.endMs - Date.now()) / 1000));
      return `<div class="quote">
        <div class="qh"><span>${esc(q.asset)} · ${poly.windowMin}m</span><span>${left}s left</span></div>
        <div class="legs"><span>UP ${cents(q.upAsk)}</span><span>DOWN ${cents(q.downAsk)}</span></div>
        <div class="legs"><span>set ${q.cost.toFixed(3)}</span><span>depth ${Math.floor(q.maxSets)}</span></div>
        <div class="edge ${q.edge >= poly.minEdge ? 'pos-pnl' : 'muted-s'}">edge ${q.edge >= 0 ? '+' : ''}${cents(q.edge)} ${q.edge >= poly.minEdge ? '· BUY' : '· wait'}</div>
      </div>`;
    }).join('') : '<p class="muted-s">No live quotes yet.</p>';

    $('polyOpen').innerHTML = poly.open.length ? poly.open.map((p) =>
      `<div><span>${esc(p.asset.toUpperCase())} ${p.sets} sets @ ${p.costPerSet.toFixed(3)}</span><b class="pos-pnl">+$${(p.sets * (1 - p.costPerSet)).toFixed(2)}</b></div>`).join('')
      : '<p class="muted-s">None.</p>';

    const settled = poly.recent;
    if (!settled.length) { $('resGrid').innerHTML = '<p class="muted-s">No settled sets yet.</p>'; }
    else {
      const per = settled.map((p) => 1 - p.costPerSet);
      const maxE = Math.max(...per.map(Math.abs), 0.01);
      $('resGrid').innerHTML = settled.map((p, i) => {
        const e = per[i]; const a = 0.35 + 0.65 * Math.min(1, Math.abs(e) / maxE);
        const bg = e >= 0 ? `rgba(18,138,82,${a.toFixed(2)})` : `rgba(192,57,43,${a.toFixed(2)})`;
        const t = `${p.asset.toUpperCase()} ${p.sets} sets · ${p.winner || '?'} won · +$${(p.pnl ?? 0).toFixed(2)}`;
        return `<div class="res-tile" style="background:${bg}" title="${esc(t)}">${(e * 100).toFixed(1)}¢<small>${esc(p.asset)} ${esc((p.winner || '').slice(0, 4))}</small></div>`;
      }).join('');
    }
    drawEdge();
  }

  // --- Edge history: set cost per asset over time, $1 reference ------------
  let edgeGeom = null;
  function drawEdge() {
    const c = $('edgeCanvas'); const { ctx, w, h } = sized(c);
    ctx.clearRect(0, 0, w, h);
    const pts = poly?.edgeHistory || [];
    const colors = { btc: css('--series-btc'), eth: css('--series-eth') };
    const assets = [...new Set(pts.map((p) => p.asset))];
    $('edgeLegend').innerHTML = assets.map((a) => `<span><i style="background:${colors[a] || css('--muted')}"></i>${a.toUpperCase()} set cost</span>`).join('') +
      `<span><i style="background:${css('--muted')}"></i>$1 payout</span>`;
    if (pts.length < 2) { axisText(ctx, 'Collecting quotes…', w / 2, h / 2, 'center'); edgeGeom = null; return; }
    const t0 = pts[0].t; const t1 = pts[pts.length - 1].t || t0 + 1;
    let lo = Math.min(...pts.map((p) => p.cost), 0.98); let hi = Math.max(...pts.map((p) => p.cost), 1.02);
    const right = 44; const plotW = w - right;
    const X = (t) => ((t - t0) / (t1 - t0 || 1)) * plotW; const Y = (v) => 6 + (1 - (v - lo) / (hi - lo)) * (h - 18);
    for (const v of [lo, (lo + hi) / 2, hi]) {
      ctx.strokeStyle = css('--grid'); ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(0, Y(v)); ctx.lineTo(plotW, Y(v)); ctx.stroke();
      axisText(ctx, v.toFixed(3), w - 2, Y(v), 'right');
    }
    ctx.strokeStyle = css('--muted'); ctx.setLineDash([5, 4]); ctx.beginPath(); ctx.moveTo(0, Y(1)); ctx.lineTo(plotW, Y(1)); ctx.stroke(); ctx.setLineDash([]);
    for (const a of assets) {
      const s = pts.filter((p) => p.asset === a);
      ctx.strokeStyle = colors[a] || css('--muted'); ctx.lineWidth = 2; ctx.lineJoin = 'round';
      ctx.beginPath(); s.forEach((p, i) => (i ? ctx.lineTo(X(p.t), Y(p.cost)) : ctx.moveTo(X(p.t), Y(p.cost)))); ctx.stroke();
      const last = s[s.length - 1];
      axisText(ctx, a.toUpperCase(), Math.min(X(last.t) + 4, plotW - 24), Y(last.cost) - 8);
    }
    edgeGeom = { pts, X, Y, plotW, assets };
  }
  $('edgeCanvas').addEventListener('mousemove', (e) => {
    if (!edgeGeom) return;
    const r = e.currentTarget.getBoundingClientRect(); const x = e.clientX - r.left; const tip = $('edgeTip');
    if (x > edgeGeom.plotW) { tip.classList.add('hidden'); return; }
    const near = edgeGeom.assets.map((a) => edgeGeom.pts.filter((p) => p.asset === a)
      .reduce((b, p) => (Math.abs(edgeGeom.X(p.t) - x) < Math.abs(edgeGeom.X(b.t) - x) ? p : b))).filter(Boolean);
    if (!near.length) return;
    tip.innerHTML = new Date(near[0].t).toISOString().slice(11, 19) + ' UTC<br>' +
      near.map((p) => `${p.asset.toUpperCase()} ${p.cost.toFixed(3)} · edge ${cents(p.edge)}`).join('<br>');
    tip.style.left = Math.min(x + 18, r.width - 190) + 'px'; tip.style.top = '40px'; tip.classList.remove('hidden');
  });
  $('edgeCanvas').addEventListener('mouseleave', () => $('edgeTip').classList.add('hidden'));

  // --- Signal feed ----------------------------------------------------------
  function renderSignals() {
    const sigs = (engine?.recentSignals || []).slice(0, 12);
    $('deskSignals').innerHTML = sigs.length ? sigs.map((s) => `
      <div class="row ${s.side}">
        <b>${esc((s.symbol || '').replace('USDT', ''))} ${s.side.toUpperCase()}</b> @ ${s.entry} · stop ${s.stopLoss} · ${s.trailingExit || !(s.takeProfit > 0) ? 'trailing' : 'tp ' + s.takeProfit}
        <div class="why">${esc((s.reasons || [])[0] || '')}</div>
        ${s.rejectReason ? `<div class="rej">✗ ${esc(s.rejectReason)}</div>` : ''}
      </div>`).join('') : '<p class="muted-s">Waiting for setups…</p>';
  }

  // --- Neural shell (decorative; driven by real inputs) ---------------------
  const shell = { nodes: [], particles: [], inputs: [] };
  function shellInputs() {
    const bars = candles.slice(-20);
    const mom = bars.length > 1 ? (bars[bars.length - 1].close - bars[0].close) / bars[0].close : 0;
    const vol = bars.length > 1 ? bars.reduce((s, b) => s + (b.high - b.low) / b.close, 0) / bars.length : 0;
    const q = (a) => poly?.quotes?.find((x) => x.asset === a);
    return [
      ['momentum', Math.tanh(mom * 50)],
      ['volatility', Math.min(1, vol * 100)],
      ['bias', engine?.bias === 'long' ? 1 : engine?.bias === 'short' ? -1 : 0],
      ['BTC set edge', q('btc') ? Math.tanh(q('btc').edge * 20) : 0],
      ['ETH set edge', q('eth') ? Math.tanh(q('eth').edge * 20) : 0],
      ['open sets', Math.min(1, (poly?.open?.length || 0) / 4)],
      ['signals', Math.min(1, (engine?.recentSignals?.length || 0) / 10)],
    ];
  }
  function initShell(w, h) {
    shell.nodes = [];
    const cx = w * 0.72; const cy = h / 2; const R = Math.min(h * 0.45, w * 0.24);
    for (let i = 0; i < 320; i++) {
      const u = Math.random() * 2 - 1; const th = Math.random() * Math.PI * 2; const r = Math.cbrt(Math.random());
      const core = r < 0.55;
      shell.nodes.push({ x: Math.sqrt(1 - u * u) * Math.cos(th) * r, y: u * r, z: Math.sqrt(1 - u * u) * Math.sin(th) * r, core, cx, cy, R });
    }
  }
  let shellAngle = 0; let lastW = 0;
  function drawShell() {
    const c = $('shellCanvas');
    if (!c.offsetParent) return; // tab hidden
    const { ctx, w, h } = sized(c);
    if (w !== lastW) { initShell(w, h); lastW = w; }
    shell.inputs = shellInputs();
    ctx.clearRect(0, 0, w, h);
    const n = shell.inputs.length; const inX = 90; const colX = w * 0.38;
    const blue = css('--series-eth'); const orange = css('--series-btc');
    shell.inputs.forEach(([name, v], i) => {
      const y = 20 + (i * (h - 40)) / (n - 1);
      axisText(ctx, name, 4, y);
      ctx.fillStyle = v >= 0 ? blue : orange; ctx.fillRect(inX, y - 3, Math.abs(v) * 40 + 2, 6);
      // curve to the feature column
      ctx.strokeStyle = (v >= 0 ? blue : orange) + '66'; ctx.lineWidth = 1 + Math.abs(v) * 2;
      ctx.beginPath(); ctx.moveTo(inX + 44, y); ctx.bezierCurveTo(colX - 60, y, colX - 60, h / 2, colX, h / 2 + (i - n / 2) * 8); ctx.stroke();
      if (Math.random() < 0.08 + Math.abs(v) * 0.2) shell.particles.push({ t: 0, i, y, v });
    });
    // particles travelling input → shell core
    shell.particles = shell.particles.filter((p) => (p.t += 0.012) < 1);
    const node0 = shell.nodes[0];
    for (const p of shell.particles) {
      const x = inX + 44 + (node0.cx - inX - 44) * p.t; const y = p.y + (h / 2 - p.y) * p.t;
      ctx.fillStyle = p.v >= 0 ? blue : orange; ctx.globalAlpha = 1 - p.t * 0.6;
      ctx.beginPath(); ctx.arc(x, y, 2, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
    // rotating sphere
    const energy = shell.inputs.reduce((s, [, v]) => s + Math.abs(v), 0) / n;
    shellAngle += 0.003 + energy * 0.01;
    const ca = Math.cos(shellAngle); const sa = Math.sin(shellAngle);
    const proj = shell.nodes.map((nd) => {
      const x = nd.x * ca - nd.z * sa; const z = nd.x * sa + nd.z * ca;
      return { sx: nd.cx + x * nd.R, sy: nd.cy + nd.y * nd.R, z, core: nd.core };
    }).sort((a, b) => a.z - b.z);
    for (const p of proj) {
      ctx.globalAlpha = 0.35 + (p.z + 1) * 0.3;
      ctx.fillStyle = p.core ? orange : blue;
      ctx.beginPath(); ctx.arc(p.sx, p.sy, p.core ? 2.6 : 1.6, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  (function loop() { drawShell(); if (!reduceMotion) requestAnimationFrame(loop); })();

  // --- Data plumbing --------------------------------------------------------
  async function loadCandles() {
    try { candles = await fetch(`/api/candles${qs}`, { headers }).then((r) => r.json()); drawPrice(); renderTicker(); } catch { /* ignore */ }
  }
  async function loadPoly() {
    try { poly = await fetch(`/api/polymarket${qs}`, { headers }).then((r) => r.json()); renderPoly(); renderTicker(); renderWallet(); renderFeed(); } catch { /* ignore */ }
  }
  window.addEventListener('resize', () => { drawPrice(); drawEdge(); drawEquity(); });
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => setTimeout(() => { drawPrice(); drawEdge(); drawEquity(); }, 0)));

  window.desk = {
    state(s) { engine = s; renderTicker(); renderWallet(); renderSignals(); renderFeed(); loadCandles(); },
    poly(p) { poly = p; renderPoly(); renderTicker(); renderWallet(); renderFeed(); },
    journal(rows) { journal = rows || []; renderWallet(); },
  };
  // app.js may have fetched state/journal before this script loaded; fetch our own copy.
  fetch(`/api/state${qs}`, { headers }).then((r) => r.json()).then((s) => s && window.desk.state(s)).catch(() => {});
  fetch(`/api/journal${qs}`, { headers }).then((r) => r.json()).then((j) => window.desk.journal(j)).catch(() => {});
  loadPoly();
})();
