// Nadaraya-Watson envelope + RSI-cross reversal — backtest of the chart setup
// (NW Envelope + NW Smoothers + RSI 14). Buy the LOWER band on an RSI cross up,
// sell the UPPER band on an RSI cross down; target the midline / opposite band.
//
//   npx tsx src/backtest/runNwBandRsi.ts [--tf 1h,2h,4h,1d] [--hours] [--grid]
//
// IMPORTANT: the LuxAlgo NW indicator on the chart REPAINTS (it redraws the last
// bars as new candles form). Backtesting that is meaningless. This uses a CAUSAL
// (endpoint, non-repainting) NW estimate — each bar's band uses only past bars —
// so the result reflects what you could actually have traded live.
//
// Buckets trades by UTC entry hour ("all time zones") and runs every timeframe.
// Data: Binance spot mirror. PAXG ~ tokenised gold.

import type { Candle } from '../types.js';

const MIRROR = 'https://data-api.binance.vision/api/v3/klines';
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT'];
const COST = 7 / 10_000;

const arg = (n: string, d: string) => {
  const h = process.argv.find((a) => a.startsWith(`--${n}=`));
  if (h) return h.split('=')[1];
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const TFS = arg('tf', '1h,2h,4h,1d').split(',');
const HOURS = process.argv.includes('--hours');
const GRID = process.argv.includes('--grid');

const TF_MS: Record<string, number> = { '15m': 900_000, '30m': 1_800_000, '1h': 3_600_000, '2h': 7_200_000, '4h': 14_400_000, '1d': 86_400_000 };
const CAP_DAYS: Record<string, number> = { '15m': 540, '30m': 900, '1h': 1460, '2h': 1825, '4h': 2555, '1d': 3200 };

interface Params {
  h: number; // NW bandwidth (LuxAlgo default 8)
  mult: number; // envelope width = mult * mean abs error (LuxAlgo default 3)
  maeLen: number; // window for the mean abs error
  rsiPeriod: number;
  rsiLo: number; // long when RSI crosses UP through this at the lower band
  rsiHi: number; // short when RSI crosses DOWN through this at the upper band
  rsiTrigger: 'level' | 'maCross'; // cross a fixed level, or cross the RSI's own MA
  rsiMaLen: number; // RSI-MA length for the maCross trigger (chart uses 14)
  armBars: number; // bars the band-tag stays valid waiting for the RSI cross
  stopPct: number; // initial hard stop from entry
  targetMode: 'mid' | 'opp' | 'tp1tp2';
  // tp1tp2 exit: TP1 = NW midline (bank `scaleFrac`), then trail the runner stop
  // to entry + `tp1LockFrac`*(TP1-entry) — i.e. give back (1-tp1LockFrac) of the
  // TP1 gain. TP2 = opposite band closes the rest.
  scaleFrac: number;
  tp1LockFrac: number;
  beAtR: number;
  maxBars: number;
  // SIDEWAYS filter: only enter when the NW midline slope over `rangeLookback`
  // bars is flatter than `rangeMaxSlopePct`% of price AND ADX < `rangeAdxMax`.
  rangeFilter: boolean;
  rangeLookback: number;
  rangeMaxSlopePct: number;
  rangeAdxMax: number;
}
const BASE: Params = {
  h: 8, mult: 3, maeLen: 100, rsiPeriod: 14, rsiLo: 30, rsiHi: 70,
  rsiTrigger: 'maCross', rsiMaLen: 14,
  armBars: 6, stopPct: 2, targetMode: 'tp1tp2', scaleFrac: 0.5, tp1LockFrac: 0.75,
  beAtR: 99, maxBars: 48,
  rangeFilter: false, rangeLookback: 20, rangeMaxSlopePct: 1.2, rangeAdxMax: 25,
};

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

/** Causal (endpoint) Nadaraya-Watson estimate — bar i uses only bars <= i. */
function nwCausal(closes: number[], h: number): number[] {
  const out = new Array(closes.length).fill(0);
  const span = Math.ceil(h * 3); // gaussian weight negligible beyond ~3h
  for (let i = 0; i < closes.length; i++) {
    let num = 0, den = 0;
    for (let j = Math.max(0, i - span); j <= i; j++) {
      const w = Math.exp(-((i - j) * (i - j)) / (2 * h * h));
      num += closes[j] * w;
      den += w;
    }
    out[i] = num / den;
  }
  return out;
}

/** ohlc4 = (open+high+low+close)/4 — the RSI source Coach Jaz uses. */
function ohlc4(c: Candle[]): number[] {
  return c.map((b) => (b.open + b.high + b.low + b.close) / 4);
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

/** Wilder ADX. */
function adxSeries(c: Candle[], period = 14): number[] {
  const n = c.length;
  const adx = new Array(n).fill(0);
  if (n < period * 2) return adx;
  let tr14 = 0, plus14 = 0, minus14 = 0;
  const dx: number[] = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const up = c[i].high - c[i - 1].high;
    const dn = c[i - 1].low - c[i].low;
    const plusDM = up > dn && up > 0 ? up : 0;
    const minusDM = dn > up && dn > 0 ? dn : 0;
    const tr = Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i - 1].close), Math.abs(c[i].low - c[i - 1].close));
    if (i <= period) { tr14 += tr; plus14 += plusDM; minus14 += minusDM; }
    else {
      tr14 = tr14 - tr14 / period + tr;
      plus14 = plus14 - plus14 / period + plusDM;
      minus14 = minus14 - minus14 / period + minusDM;
    }
    if (i >= period) {
      const pdi = 100 * (plus14 / tr14);
      const mdi = 100 * (minus14 / tr14);
      dx[i] = pdi + mdi === 0 ? 0 : (100 * Math.abs(pdi - mdi)) / (pdi + mdi);
    }
  }
  let acc = 0;
  for (let i = period; i < period * 2 && i < n; i++) acc += dx[i];
  adx[period * 2 - 1] = acc / period;
  for (let i = period * 2; i < n; i++) adx[i] = (adx[i - 1] * (period - 1) + dx[i]) / period;
  return adx;
}

interface Trade { side: 'long' | 'short'; entryTime: number; hour: number; rMultiple: number; pctReturn: number; maePct: number; reason: string; }

function backtest(c: Candle[], p: Params, onlySide?: 'long' | 'short'): Trade[] {
  const closes = c.map((x) => x.close);
  const nw = nwCausal(closes, p.h);
  const rsi = rsiSeries(ohlc4(c), p.rsiPeriod); // Coach Jaz: RSI source = ohlc4
  // RSI's own SMA (the yellow line on the chart)
  const rsiMa = new Array(rsi.length).fill(50);
  for (let i = 0; i < rsi.length; i++) {
    const s = Math.max(0, i - p.rsiMaLen + 1);
    let acc = 0;
    for (let j = s; j <= i; j++) acc += rsi[j];
    rsiMa[i] = acc / (i - s + 1);
  }
  // rolling mean abs error
  const mae = new Array(c.length).fill(0);
  for (let i = 0; i < c.length; i++) {
    const s = Math.max(0, i - p.maeLen + 1);
    let acc = 0;
    for (let j = s; j <= i; j++) acc += Math.abs(closes[j] - nw[j]);
    mae[i] = acc / (i - s + 1);
  }
  const upper = (i: number) => nw[i] + p.mult * mae[i];
  const lower = (i: number) => nw[i] - p.mult * mae[i];
  const adx = p.rangeFilter ? adxSeries(c, 14) : [];
  const isRanging = (i: number): boolean => {
    if (!p.rangeFilter) return true;
    if (i < p.rangeLookback) return false;
    const slopePct = (Math.abs(nw[i] - nw[i - p.rangeLookback]) / closes[i]) * 100;
    return slopePct <= p.rangeMaxSlopePct && adx[i] <= p.rangeAdxMax;
  };

  const trades: Trade[] = [];
  let pos: null | {
    side: 'long' | 'short'; entry: number; i: number; stop: number; init: number;
    be: boolean; tookTp1: boolean; remaining: number; bankedRet: number; legs: number; worstAdv: number;
  } = null;
  let arm: null | { side: 'long' | 'short'; bar: number } = null;

  for (let i = p.maeLen + 5; i < c.length; i++) {
    const bar = c[i];
    if (pos) {
      const dir = pos.side === 'long' ? 1 : -1;
      const retAt = (px: number) => (dir * (px - pos!.entry)) / pos!.entry;
      const risk = Math.abs(pos.entry - pos.init) / pos.entry || 0.01;
      const finish = (reason: string) => {
        const net = pos!.bankedRet - pos!.legs * COST;
        trades.push({
          side: pos!.side, entryTime: c[pos!.i].time, hour: new Date(c[pos!.i].time).getUTCHours(),
          rMultiple: net / risk, pctReturn: net, maePct: pos!.worstAdv, reason,
        });
        pos = null;
      };

      const advPx = pos.side === 'long' ? bar.low : bar.high;
      const advPct = pos.side === 'long' ? (pos.entry - advPx) / pos.entry * 100 : (advPx - pos.entry) / pos.entry * 100;
      if (advPct > pos.worstAdv) pos.worstAdv = advPct;

      const r0 = risk * pos.entry;
      const rNow = pos.side === 'long' ? (bar.high - pos.entry) / r0 : (pos.entry - bar.low) / r0;
      if (!pos.be && p.beAtR < 90 && rNow >= p.beAtR) { pos.stop = pos.entry; pos.be = true; }

      const hitStop = pos.side === 'long' ? bar.low <= pos.stop : bar.high >= pos.stop;
      if (hitStop) { pos.bankedRet += pos.remaining * retAt(pos.stop); pos.legs++; finish(pos.be || pos.tookTp1 ? 'be' : 'sl'); continue; }

      if (p.targetMode === 'tp1tp2') {
        const mid = nw[i];
        const opp = pos.side === 'long' ? upper(i) : lower(i);
        if (!pos.tookTp1) {
          const hitTp1 = pos.side === 'long' ? bar.high >= mid : bar.low <= mid;
          if (hitTp1) {
            pos.bankedRet += p.scaleFrac * retAt(mid);
            pos.remaining -= p.scaleFrac;
            pos.legs++;
            pos.tookTp1 = true;
            pos.stop = pos.entry + dir * p.tp1LockFrac * Math.abs(mid - pos.entry); // TP1 minus (1-lock) of the gain
          }
        } else {
          const hitTp2 = pos.side === 'long' ? bar.high >= opp : bar.low <= opp;
          if (hitTp2) { pos.bankedRet += pos.remaining * retAt(opp); pos.legs++; finish('tp2'); continue; }
        }
      } else {
        const tgt = p.targetMode === 'mid' ? nw[i] : pos.side === 'long' ? upper(i) : lower(i);
        const hitTgt = pos.side === 'long' ? bar.high >= tgt : bar.low <= tgt;
        if (hitTgt) { pos.bankedRet += pos.remaining * retAt(tgt); pos.legs++; finish('tp'); continue; }
      }

      if (i - pos.i >= p.maxBars) { pos.bankedRet += pos.remaining * retAt(bar.close); pos.legs++; finish('time'); continue; }
      continue;
    }

    // arm on a band tag — only when the market is ranging (sideways)
    if (!arm) {
      if (isRanging(i)) {
        if (bar.high >= upper(i) && onlySide !== 'long') arm = { side: 'short', bar: i };
        else if (bar.low <= lower(i) && onlySide !== 'short') arm = { side: 'long', bar: i };
      }
    } else {
      if (i - arm.bar > p.armBars) { arm = null; }
      else {
        const cross = p.rsiTrigger === 'maCross'
          ? (arm.side === 'long'
              ? rsi[i - 1] <= rsiMa[i - 1] && rsi[i] > rsiMa[i]
              : rsi[i - 1] >= rsiMa[i - 1] && rsi[i] < rsiMa[i])
          : (arm.side === 'long'
              ? rsi[i - 1] <= p.rsiLo && rsi[i] > p.rsiLo
              : rsi[i - 1] >= p.rsiHi && rsi[i] < p.rsiHi);
        if (cross) {
          const entry = bar.close;
          const stop = arm.side === 'long' ? entry * (1 - p.stopPct / 100) : entry * (1 + p.stopPct / 100);
          pos = { side: arm.side, entry, i, stop, init: stop, be: false, tookTp1: false, remaining: 1, bankedRet: 0, legs: 1, worstAdv: 0 };
          arm = null;
        }
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
  let eqSpot = 1000, eqLev = 1000;
  for (const t of trades) { eqSpot += eqSpot * t.pctReturn; eqLev += eqLev * 0.1 * 10 * t.pctReturn; if (eqLev < 0) eqLev = 0; }
  return { n, wr: n ? w / n * 100 : 0, pf: gL > 0 ? gW / gL : n ? 99 : 0, totR, ddR: dd, eqSpot, eqLev };
}
const fmtL = (label: string, s: ReturnType<typeof stats>) =>
  `  ${label.padEnd(12)} ${String(s.n).padStart(4)}  WR ${s.wr.toFixed(0).padStart(3)}%  PF ${s.pf.toFixed(2).padStart(5)}  totR ${s.totR.toFixed(0).padStart(5)}  ddR ${s.ddR.toFixed(0).padStart(4)}  $1k→ ${s.eqSpot.toFixed(0).padStart(6)} spot / ${s.eqLev.toFixed(0).padStart(6)} 10x`;

/** Isolated-margin leverage sim: commit 10% of equity per trade, compounding. */
function levSim(trades: Trade[], lev: number) {
  let eq = 1000, peak = 1000, maxDdPct = 0, liq = 0, wins = 0;
  const liqThresh = 100 / lev - (lev >= 50 ? 0.5 : lev >= 10 ? 0.3 : 0.1);
  for (const t of trades) {
    const margin = eq * 0.1;
    if (lev > 1 && t.maePct >= liqThresh) { eq -= margin; liq++; }
    else { eq += margin * lev * t.pctReturn; if (t.pctReturn > 0) wins++; }
    if (eq < 0) eq = 0;
    peak = Math.max(peak, eq);
    if (peak > 0) maxDdPct = Math.max(maxDdPct, (peak - eq) / peak * 100);
    if (eq === 0) break;
  }
  return { eq, liq, maxDdPct, wins, n: trades.length };
}

const DIRS: { name: string; side?: 'long' | 'short' }[] = [
  { name: 'long+short' }, { name: 'long only', side: 'long' }, { name: 'short only', side: 'short' },
];
const LEVS = [1, 2, 3, 5, 10, 20, 50, 100];

async function main() {
  console.log(`\nNW ENVELOPE + RSI/MA-CROSS reversal — SIDEWAYS-ONLY (NW slope ≤${BASE.rangeMaxSlopePct}% & ADX ≤${BASE.rangeAdxMax})`);
  console.log(`TP1 = mid band (bank ${BASE.scaleFrac * 100}%), runner locks ${BASE.tp1LockFrac * 100}% of TP1 gain · TP2 = opposite band · SL ${BASE.stopPct}% · 7bps/side`);
  console.log(`sizing: 10% of equity as margin per trade, isolated (liquidation loses the margin)\n`);

  for (const tf of TFS) {
    console.log(`\n═══════ ${tf} ═══════`);
    const data: Record<string, Candle[]> = {};
    for (const s of SYMBOLS) { try { data[s] = await fetchAll(s, tf); } catch { /* skip */ } }

    for (const d of DIRS) {
      const perCoin: Record<string, Trade[]> = {};
      for (const s of SYMBOLS) { if (data[s]) perCoin[s] = backtest(data[s], BASE, d.side); }
      const port = Object.values(perCoin).flat().sort((a, b) => a.entryTime - b.entryTime);
      const st = stats(port);
      console.log(`\n── ${d.name.toUpperCase()} · ${port.length} trades · WR ${st.wr.toFixed(0)}% · PF ${st.pf.toFixed(2)} · totR ${st.totR.toFixed(0)} ──`);
      for (const s of SYMBOLS) {
        if (!perCoin[s]) continue;
        const cs = stats(perCoin[s]);
        console.log(`   ${s.replace('USDT', '').padEnd(5)} n${String(cs.n).padStart(4)}  WR ${cs.wr.toFixed(0).padStart(3)}%  PF ${cs.pf.toFixed(2)}  totR ${cs.totR.toFixed(0).padStart(5)}`);
      }
      console.log(`   $1000 @ 10% margin, by leverage:`);
      console.log(`   ` + LEVS.map((L) => `${L}x`.padStart(9)).join(''));
      console.log(`   ` + LEVS.map((L) => {
        const r = levSim(port, L);
        const tag = r.eq <= 0 ? 'DEAD' : r.eq >= 1e6 ? `${(r.eq / 1e6).toFixed(1)}M` : r.eq >= 1e3 ? `${(r.eq / 1e3).toFixed(1)}k` : r.eq.toFixed(0);
        return (tag + (r.liq ? `│${r.liq}` : '')).padStart(9);
      }).join(''));
      console.log(`   ` + LEVS.map((L) => `${levSim(port, L).maxDdPct.toFixed(0)}%dd`.padStart(9)).join(''));

      if (HOURS && d.name === 'long+short') {
        console.log(`   by UTC entry hour (both dirs):`);
        const rows = [];
        for (let hr = 0; hr < 24; hr++) {
          const g = port.filter((t) => t.hour === hr);
          if (g.length < 8) continue;
          rows.push({ hr, st: stats(g) });
        }
        rows.sort((a, b) => b.st.wr - a.st.wr);
        for (const r of rows) {
          const mark = r.st.wr >= 45 && r.st.totR > 0 ? ' ★' : r.st.wr >= 40 && r.st.totR > 0 ? ' ·' : '';
          console.log(`     ${String(r.hr).padStart(2)}h  n${String(r.st.n).padStart(3)}  WR ${r.st.wr.toFixed(0).padStart(3)}%  PF ${r.st.pf.toFixed(2)}  totR ${r.st.totR.toFixed(0).padStart(4)}${mark}`);
        }
      }
    }
  }
  console.log(`\nNW repaints on the chart — corrected here via a causal estimate. "│N" = N liquidations.\n`);
}

async function mainGrid() {
  for (const tf of TFS) {
    console.log(`\n═══ ${tf} ${'═'.repeat(50)}`);
    const data: Record<string, Candle[]> = {};
    for (const s of SYMBOLS) {
      try { data[s] = await fetchAll(s, tf); } catch { /* skip */ }
    }
    const variants: { name: string; p: Params; side?: 'long' | 'short' }[] = GRID
      ? [
          { name: 'base', p: BASE },
          { name: 'RSI 25/75', p: { ...BASE, rsiLo: 25, rsiHi: 75 } },
          { name: 'RSI 35/65', p: { ...BASE, rsiLo: 35, rsiHi: 65 } },
          { name: 'TP opp band', p: { ...BASE, targetMode: 'opp' as const } },
          { name: 'stop 1%', p: { ...BASE, stopPct: 1 } },
          { name: 'stop 3%', p: { ...BASE, stopPct: 3 } },
          { name: 'mult 2', p: { ...BASE, mult: 2 } },
          { name: 'mult 4', p: { ...BASE, mult: 4 } },
          { name: 'h 12', p: { ...BASE, h: 12 } },
          { name: 'BE +1R', p: { ...BASE, beAtR: 1 } },
          { name: 'lock 50%', p: { ...BASE, tp1LockFrac: 0.5 } },
          { name: 'lock 100% (BE)', p: { ...BASE, tp1LockFrac: 1 } },
          { name: 'bank 75% at TP1', p: { ...BASE, scaleFrac: 0.75 } },
          { name: 'long only', p: { ...BASE }, side: 'long' as const },
          { name: 'short only', p: { ...BASE }, side: 'short' as const },
          { name: 'RSI level 30/70', p: { ...BASE, rsiTrigger: 'level' as const } },
          { name: 'maCross + arm 10', p: { ...BASE, armBars: 10 } },
          { name: 'maCross long only', p: { ...BASE }, side: 'long' as const },
        ]
      : [{ name: 'base', p: BASE }];

    for (const v of variants) {
      if (GRID) console.log(`\n── ${v.name} ──`);
      const port: Trade[] = [];
      for (const s of SYMBOLS) {
        if (!data[s]) continue;
        const tr = backtest(data[s], v.p, v.side);
        port.push(...tr);
        if (!GRID) console.log(fmtL(s.replace('USDT', ''), stats(tr)));
      }
      port.sort((a, b) => a.entryTime - b.entryTime);
      console.log(fmtL(GRID ? v.name : 'PORTFOLIO', stats(port)));

      if (HOURS && !GRID) {
        console.log(`  by UTC entry hour:`);
        for (let hr = 0; hr < 24; hr++) {
          const g = port.filter((t) => t.hour === hr);
          if (g.length < 5) continue;
          const st = stats(g);
          const mark = st.wr >= 50 && st.totR > 0 ? ' ★' : st.wr >= 45 && st.totR > 0 ? ' ·' : '';
          console.log(`    ${String(hr).padStart(2)}h  n${String(g.length).padStart(3)}  WR ${st.wr.toFixed(0).padStart(3)}%  PF ${st.pf.toFixed(2)}  totR ${st.totR.toFixed(0).padStart(4)}${mark}`);
        }
      }
    }
  }
  console.log(`\nNote: causal (non-repainting) NW. Treat small edges as noise.\n`);
}

(GRID ? mainGrid() : main()).catch((e) => { console.error(e); process.exit(1); });
