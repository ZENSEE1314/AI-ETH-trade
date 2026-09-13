// "Touch-zone reversal" — the TAD method as taught on the coaching calls:
// horizontal S/R zones + an RSI trigger, fading price off a zone toward the
// next one. (Not the Donchian breakout the other scripts test.)
//
//   npx tsx src/backtest/runTouchZone.ts [--tf 1h] [--zones grid|pivot] [--grid] [--monthly]
//
// Zones:
//   grid  — evenly spaced levels every `gridPct`% of price (matches the coach's
//           chart, which looks like a fixed grid / quarter levels).
//   pivot — cluster confirmed fractal pivots (L bars each side) within `tol`;
//           keep clusters with >= minTouches, no lookahead.
// Entry: a bar's wick pierces INTO a zone and the bar CLOSES back out of it
//        (rejection), with RSI stretched the right way:
//          into resistance from below + RSI >= rsiHi -> SHORT
//          into support     from above + RSI <= rsiLo -> LONG
//        Per-zone cooldown so one level isn't hammered repeatedly.
// Stop:  beyond the zone (>= minStopPct, <= maxStopPct from entry).
// Target: the next zone in the profit direction (>= 1R), else fixed targetR.
//         Optional breakeven after +1R.
//
// Data: Binance spot mirror. PAXG ~ tokenised gold (tracks XAUUSD).

import type { Candle } from '../types.js';

const MIRROR = 'https://data-api.binance.vision/api/v3/klines';
const SYMBOLS = ['PAXGUSDT', 'BTCUSDT', 'ETHUSDT', 'BNBUSDT'];
const COST = 7 / 10_000;

const arg = (n: string, d: string) => {
  const h = process.argv.find((a) => a.startsWith(`--${n}=`));
  if (h) return h.split('=')[1];
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const TF = arg('tf', '1h');
const ZONES = arg('zones', 'grid') as 'grid' | 'pivot';
const GRID = process.argv.includes('--grid');
const MONTHLY = process.argv.includes('--monthly');

const TF_MS: Record<string, number> = { '15m': 900_000, '30m': 1_800_000, '1h': 3_600_000, '2h': 7_200_000, '4h': 14_400_000 };
const CAP_DAYS: Record<string, number> = { '15m': 540, '30m': 900, '1h': 1460, '2h': 1460, '4h': 2200 };

interface Params {
  gridPct: number; // grid spacing, % of price
  pivotL: number;
  tolPct: number;
  minTouches: number;
  rsiPeriod: number;
  rsiHi: number;
  rsiLo: number;
  pierceMinPct: number; // wick must pierce the zone edge by at least this % of price
  minStopPct: number;
  maxStopPct: number;
  beAtR: number;
  maxBars: number;
  targetR: number;
  cooldownBars: number; // bars before the same zone can be traded again
  trend: 'off' | 'with' | 'against'; // 'with': only buy support in uptrend / sell res in downtrend (EMA200)
  emaLen: number;
}
const BASE: Params = {
  gridPct: 0.5, pivotL: 8, tolPct: 0.4, minTouches: 3, rsiPeriod: 14,
  rsiHi: 68, rsiLo: 32, pierceMinPct: 0.05, minStopPct: 0.6, maxStopPct: 2,
  beAtR: 99, maxBars: 60, targetR: 2, cooldownBars: 24, trend: 'off', emaLen: 200,
};

function emaSeries(v: number[], len: number): number[] {
  const k = 2 / (len + 1);
  const o: number[] = [];
  let p = v[0];
  for (let i = 0; i < v.length; i++) { p = i === 0 ? v[0] : v[i] * k + p * (1 - k); o.push(p); }
  return o;
}

async function fetchAll(symbol: string, tf: string): Promise<Candle[]> {
  const step = TF_MS[tf];
  const byTime = new Map<number, Candle>();
  let cursor = Date.now() - (CAP_DAYS[tf] ?? 365) * 86_400_000;
  const end = Date.now();
  while (cursor < end) {
    const url = `${MIRROR}?symbol=${symbol}&interval=${tf}&startTime=${cursor}&limit=1000`;
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${symbol}`);
    const rows = (await res.json()) as unknown[][];
    if (!rows.length) break;
    for (const r of rows) {
      const t = Number(r[0]);
      byTime.set(t, { time: t, open: +(r[1] as string), high: +(r[2] as string), low: +(r[3] as string), close: +(r[4] as string), volume: +(r[5] as string) || 0 });
    }
    const newest = Number(rows[rows.length - 1][0]);
    if (newest <= cursor) break;
    cursor = newest + step;
    if (rows.length < 1000) break;
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

function rsiSeries(closes: number[], period: number): number[] {
  const out = new Array(closes.length).fill(50);
  if (closes.length < period + 1) return out;
  let g = 0, l = 0;
  for (let i = 1; i <= period; i++) { const d = closes[i] - closes[i - 1]; if (d >= 0) g += d; else l -= d; }
  g /= period; l /= period;
  out[period] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    g = (g * (period - 1) + (d > 0 ? d : 0)) / period;
    l = (l * (period - 1) + (d < 0 ? -d : 0)) / period;
    out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return out;
}

interface Pivot { price: number; bar: number }
function findPivots(c: Candle[], L: number): Pivot[] {
  const out: Pivot[] = [];
  for (let i = L; i < c.length - L; i++) {
    let ph = true, pl = true;
    for (let j = i - L; j <= i + L; j++) {
      if (j === i) continue;
      if (c[j].high >= c[i].high) ph = false;
      if (c[j].low <= c[i].low) pl = false;
    }
    if (ph) out.push({ price: c[i].high, bar: i });
    if (pl) out.push({ price: c[i].low, bar: i });
  }
  return out;
}

interface Zone { lo: number; hi: number; center: number }
function pivotZonesAt(all: Pivot[], beforeBar: number, L: number, tolPct: number, minTouches: number): Zone[] {
  const live = all.filter((p) => p.bar + L < beforeBar).map((p) => p.price).sort((a, b) => a - b);
  if (!live.length) return [];
  const zones: Zone[] = [];
  let grp = [live[0]];
  const flush = () => {
    if (grp.length >= minTouches) {
      const center = grp.reduce((s, x) => s + x, 0) / grp.length;
      const half = Math.max((tolPct / 100) * center, (grp[grp.length - 1] - grp[0]) / 2);
      zones.push({ lo: center - half, hi: center + half, center });
    }
  };
  for (let i = 1; i < live.length; i++) {
    const mean = grp.reduce((s, x) => s + x, 0) / grp.length;
    if (Math.abs(live[i] - mean) / mean <= tolPct / 100) grp.push(live[i]);
    else { flush(); grp = [live[i]]; }
  }
  flush();
  return zones;
}
function gridZonesAt(px: number, gridPct: number, tolPct: number): Zone[] {
  const step = px * (gridPct / 100);
  const half = px * (tolPct / 100);
  const out: Zone[] = [];
  const base = Math.round(px / step) * step;
  for (let k = -6; k <= 6; k++) {
    const c = base + k * step;
    if (c > 0) out.push({ lo: c - half, hi: c + half, center: c });
  }
  return out;
}

interface Trade { side: 'long' | 'short'; entryTime: number; entry: number; exit: number; rMultiple: number; pctReturn: number; bars: number; reason: string }

function backtest(c: Candle[], p: Params): Trade[] {
  const closes = c.map((x) => x.close);
  const rsi = rsiSeries(closes, p.rsiPeriod);
  const ema = p.trend === 'off' ? [] : emaSeries(closes, p.emaLen);
  const upTrend = (i: number) => p.trend === 'off' || (p.trend === 'with' ? closes[i] > ema[i] : closes[i] < ema[i]);
  const downTrend = (i: number) => p.trend === 'off' || (p.trend === 'with' ? closes[i] < ema[i] : closes[i] > ema[i]);
  const allPivots = ZONES === 'pivot' ? findPivots(c, p.pivotL) : [];
  const trades: Trade[] = [];
  let pos: null | { side: 'long' | 'short'; entry: number; i: number; stop: number; init: number; target: number; be: boolean } = null;
  const zoneCooldown = new Map<number, number>(); // rounded center -> bar until which it's on cooldown

  let zones: Zone[] = [];
  let lastBuild = -1;

  for (let i = 100; i < c.length; i++) {
    const bar = c[i];
    if (pos) {
      const r0 = Math.abs(pos.entry - pos.init);
      const rNow = pos.side === 'long' ? (bar.high - pos.entry) / r0 : (pos.entry - bar.low) / r0;
      if (!pos.be && rNow >= p.beAtR) { pos.stop = pos.entry; pos.be = true; }
      const hitStop = pos.side === 'long' ? bar.low <= pos.stop : bar.high >= pos.stop;
      const hitTgt = pos.side === 'long' ? bar.high >= pos.target : bar.low <= pos.target;
      const timeout = i - pos.i >= p.maxBars;
      if (hitStop || hitTgt || timeout) {
        const exit = hitStop ? pos.stop : hitTgt ? pos.target : bar.close;
        const dir = pos.side === 'long' ? 1 : -1;
        const net = dir * (exit - pos.entry) / pos.entry - 2 * COST;
        const risk = Math.abs(pos.entry - pos.init) / pos.entry || 0.01;
        trades.push({ side: pos.side, entryTime: c[pos.i].time, entry: pos.entry, exit, rMultiple: net / risk, pctReturn: net, bars: i - pos.i, reason: hitStop ? (pos.be ? 'be' : 'sl') : hitTgt ? 'tp' : 'time' });
        pos = null;
      } else continue;
    }

    if (i - lastBuild >= 6) {
      zones = ZONES === 'pivot'
        ? pivotZonesAt(allPivots, i, p.pivotL, p.tolPct, p.minTouches)
        : gridZonesAt(bar.close, p.gridPct, p.tolPct);
      lastBuild = i;
    }
    if (!zones.length) continue;
    if (rsi[i] === 50) continue;

    const px = bar.close;
    const pierce = px * (p.pierceMinPct / 100);

    // SHORT: this bar's HIGH pushed above a resistance-zone lower edge, but the
    // CLOSE is back below the zone (rejection), and RSI is hot.
    let resZone: Zone | null = null;
    for (const z of zones) {
      if (z.center <= px) continue; // must be above price
      if (bar.high >= z.lo + pierce && bar.close < z.lo && (!resZone || z.center < resZone.center)) resZone = z;
    }
    if (resZone && rsi[i] >= p.rsiHi && downTrend(i)) {
      const key = Math.round(resZone.center);
      if ((zoneCooldown.get(key) ?? 0) <= i) {
        const entry = px;
        let stop = resZone.hi;
        const dPct = (stop - entry) / entry;
        if (dPct < p.minStopPct / 100) stop = entry * (1 + p.minStopPct / 100);
        if (dPct > p.maxStopPct / 100) stop = entry * (1 + p.maxStopPct / 100);
        const r = stop - entry;
        // target: nearest support zone below, else fixed
        let sup: Zone | null = null;
        for (const z of zones) if (z.center < entry - r && (!sup || z.center > sup.center)) sup = z;
        const target = sup ? Math.min(sup.hi, entry - p.targetR * r) : entry - p.targetR * r;
        pos = { side: 'short', entry, i, stop, init: stop, target, be: false };
        zoneCooldown.set(key, i + p.cooldownBars);
        continue;
      }
    }

    // LONG: mirror
    let supZone: Zone | null = null;
    for (const z of zones) {
      if (z.center >= px) continue;
      if (bar.low <= z.hi - pierce && bar.close > z.hi && (!supZone || z.center > supZone.center)) supZone = z;
    }
    if (supZone && rsi[i] <= p.rsiLo && upTrend(i)) {
      const key = Math.round(supZone.center);
      if ((zoneCooldown.get(key) ?? 0) <= i) {
        const entry = px;
        let stop = supZone.lo;
        const dPct = (entry - stop) / entry;
        if (dPct < p.minStopPct / 100) stop = entry * (1 - p.minStopPct / 100);
        if (dPct > p.maxStopPct / 100) stop = entry * (1 - p.maxStopPct / 100);
        const r = entry - stop;
        let res: Zone | null = null;
        for (const z of zones) if (z.center > entry + r && (!res || z.center < res.center)) res = z;
        const target = res ? Math.max(res.lo, entry + p.targetR * r) : entry + p.targetR * r;
        pos = { side: 'long', entry, i, stop, init: stop, target, be: false };
        zoneCooldown.set(key, i + p.cooldownBars);
      }
    }
  }
  return trades;
}

function stats(trades: Trade[]) {
  const n = trades.length;
  const w = trades.filter((t) => t.pctReturn > 0).length;
  const gW = trades.filter((t) => t.rMultiple > 0).reduce((s, t) => s + t.rMultiple, 0);
  const gL = -trades.filter((t) => t.rMultiple < 0).reduce((s, t) => s + t.rMultiple, 0);
  const totR = trades.reduce((s, t) => s + t.rMultiple, 0);
  let peak = 0, cum = 0, dd = 0;
  for (const t of trades) { cum += t.rMultiple; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum); }
  const aw = trades.filter((t) => t.pctReturn > 0).reduce((s, t) => s + t.pctReturn, 0) / (w || 1) * 100;
  const al = trades.filter((t) => t.pctReturn <= 0).reduce((s, t) => s + t.pctReturn, 0) / ((n - w) || 1) * 100;
  let eqSpot = 1000, eqLev = 1000;
  for (const t of trades) { eqSpot += eqSpot * t.pctReturn; eqLev += eqLev * 0.1 * 10 * t.pctReturn; if (eqLev < 0) eqLev = 0; }
  return { n, wr: n ? w / n * 100 : 0, pf: gL > 0 ? gW / gL : n ? 99 : 0, totR, ddR: dd, aw, al, eqSpot, eqLev };
}
function line(label: string, s: ReturnType<typeof stats>) {
  return `  ${label.padEnd(11)} ${String(s.n).padStart(4)}  WR ${s.wr.toFixed(0).padStart(3)}%  PF ${s.pf.toFixed(2).padStart(5)}  totR ${s.totR.toFixed(0).padStart(5)}  ddR ${s.ddR.toFixed(0).padStart(4)}  aw+${s.aw.toFixed(1)}% al${s.al.toFixed(1)}%  $1k→ ${s.eqSpot.toFixed(0).padStart(6)} spot / ${s.eqLev.toFixed(0).padStart(6)} 10x`;
}

async function main() {
  console.log(`\nTOUCH-ZONE REVERSAL — ${TF} · zones=${ZONES} · RSI ${BASE.rsiLo}/${BASE.rsiHi} fade · 7bps/side`);
  console.log(ZONES === 'grid' ? `grid ${BASE.gridPct}% spacing, ±${BASE.tolPct}% band` : `pivot L${BASE.pivotL}, tol ${BASE.tolPct}%, ≥${BASE.minTouches} touches`);
  console.log(`stop ${BASE.minStopPct}–${BASE.maxStopPct}% · target ${BASE.targetR}R or next zone · cooldown ${BASE.cooldownBars} bars · BE ${BASE.beAtR === 99 ? 'off' : '+' + BASE.beAtR + 'R'}\n`);

  const data: Record<string, Candle[]> = {};
  for (const s of SYMBOLS) {
    process.stdout.write(`  ${s} …`);
    try { data[s] = await fetchAll(s, TF); console.log(` ${data[s].length} bars`); }
    catch (e) { console.log(` skip (${(e as Error).message})`); }
  }

  const variants: { name: string; p: Params }[] = GRID
    ? [
        { name: 'base', p: BASE },
        { name: 'RSI 72/28', p: { ...BASE, rsiHi: 72, rsiLo: 28 } },
        { name: 'RSI 75/25', p: { ...BASE, rsiHi: 75, rsiLo: 25 } },
        { name: 'grid 1%', p: { ...BASE, gridPct: 1 } },
        { name: 'grid 0.35%', p: { ...BASE, gridPct: 0.35 } },
        { name: 'stop ≤3%', p: { ...BASE, maxStopPct: 3 } },
        { name: 'target 3R', p: { ...BASE, targetR: 3 } },
        { name: 'target 1.5R', p: { ...BASE, targetR: 1.5 } },
        { name: 'BE +1R', p: { ...BASE, beAtR: 1 } },
        { name: 'cooldown 48', p: { ...BASE, cooldownBars: 48 } },
        { name: 'pierce 0.15%', p: { ...BASE, pierceMinPct: 0.15 } },
        { name: 'WITH-trend EMA200', p: { ...BASE, trend: 'with' } },
        { name: 'WITH-trend EMA50', p: { ...BASE, trend: 'with', emaLen: 50 } },
        { name: 'AGAINST-trend', p: { ...BASE, trend: 'against' } },
        { name: 'with-trend + BE1R', p: { ...BASE, trend: 'with', beAtR: 1 } },
        { name: 'with-trend RSI75/25', p: { ...BASE, trend: 'with', rsiHi: 75, rsiLo: 25 } },
      ]
    : [{ name: 'base', p: BASE }];

  for (const v of variants) {
    console.log(`\n── ${v.name} ${'─'.repeat(46)}`);
    const portfolio: Trade[] = [];
    for (const s of SYMBOLS) {
      if (!data[s]) continue;
      const tr = backtest(data[s], v.p);
      portfolio.push(...tr);
      console.log(line(s.replace('USDT', ''), stats(tr)));
      if (MONTHLY && !GRID) {
        const byM = new Map<string, Trade[]>();
        for (const t of tr) {
          const k = new Date(t.entryTime).toISOString().slice(2, 7);
          if (!byM.has(k)) byM.set(k, []);
          byM.get(k)!.push(t);
        }
        console.log('     ' + [...byM.keys()].sort().map((k) => { const st = stats(byM.get(k)!); return `${k}:${st.wr.toFixed(0)}%/${st.totR.toFixed(0)}`; }).join('  '));
      }
    }
    portfolio.sort((a, b) => a.entryTime - b.entryTime);
    console.log(line('PORTFOLIO', stats(portfolio)));
  }
  console.log();
}

main().catch((e) => { console.error(e); process.exit(1); });
