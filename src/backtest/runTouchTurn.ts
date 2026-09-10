// "Touch and Turn Scalper" (Carl / 20yr trader, YouTube BifyQ6ppdLU) — an
// opening-range reversal.
//
//   npx tsx src/backtest/runTouchTurn.ts [--days 150] [--open 13:30,00:00,08:00]
//
// Steps (per Carl):
//   1. On the 15m open candle: range = high - low. Fib the range; TP levels are
//      the 38.2% and 61.8% retracements.
//   2. Liquidity-candle filter: range >= 25% of the Daily ATR(14).
//   3. Fade it: RED open candle -> LONG limit at the range LOW; GREEN -> SHORT
//      at the range HIGH. Only fill within 90 min of the open. TP = the Fib
//      level; SL = half the TP distance (2:1 R:R), just past the range edge.
//
// Crypto has no "market open", so we test several session opens (UTC). NYSE
// opens 13:30 UTC (skip weekends); the 00:00 UTC daily candle runs every day.
// Data: Binance spot 1m mirror + daily bars for the ATR.

import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Candle } from '../types.js';

const MIRROR = 'https://data-api.binance.vision/api/v3/klines';
const CACHE = join(process.cwd(), 'data');
const COST = 7 / 10_000;
const MIN = 60_000;

const arg = (n: string, d: string) => {
  const h = process.argv.find((a) => a.startsWith(`--${n}=`));
  if (h) return h.split('=')[1];
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const SYMBOLS = arg('syms', 'BTCUSDT,ETHUSDT,BNBUSDT,PAXGUSDT').split(',');
const DAYS = Number(arg('days', '150'));
const OPENS = arg('open', '13:30,00:00,08:00').split(',');
const ATR_FRAC = Number(arg('atrFrac', '0.25')); // liquidity-candle threshold
const FILL_WINDOW_MIN = 90; // must fill within 90 min of the open
const HOLD_MAX_MIN = 24 * 60; // give up / mark-to-market after this
const TP_FRACS = [0.382, 0.618]; // the two Fib targets

async function fetch1m(symbol: string, days: number): Promise<Candle[]> {
  const cacheFile = join(CACHE, `${symbol.toLowerCase()}-1m-${days}d-tt.json`);
  if (existsSync(cacheFile)) {
    const cached = JSON.parse(readFileSync(cacheFile, 'utf8')) as Candle[];
    if (cached.length > 1000 && Date.now() - cached[cached.length - 1].time < 3 * 86_400_000) return cached;
  }
  const byTime = new Map<number, Candle>();
  let cursor = Date.now() - days * 86_400_000;
  const end = Date.now();
  while (cursor < end) {
    const url = `${MIRROR}?symbol=${symbol}&interval=1m&startTime=${cursor}&limit=1000`;
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
    cursor = newest + MIN;
    if (rows.length < 1000) break;
  }
  const bars = [...byTime.values()].sort((a, b) => a.time - b.time);
  try { mkdirSync(CACHE, { recursive: true }); writeFileSync(cacheFile, JSON.stringify(bars)); } catch { /* noop */ }
  return bars;
}

async function fetchDaily(symbol: string, days: number): Promise<Candle[]> {
  const url = `${MIRROR}?symbol=${symbol}&interval=1d&limit=${Math.min(1000, days + 30)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  const rows = (await res.json()) as unknown[][];
  return rows.map((r) => ({ time: Number(r[0]), open: +(r[1] as string), high: +(r[2] as string), low: +(r[3] as string), close: +(r[4] as string), volume: +(r[5] as string) || 0 }));
}

/** Wilder ATR(14) per daily bar (uses only prior bars). */
function atr14(daily: Candle[]): Map<number, number> {
  const out = new Map<number, number>();
  let atr = 0;
  for (let i = 1; i < daily.length; i++) {
    const tr = Math.max(
      daily[i].high - daily[i].low,
      Math.abs(daily[i].high - daily[i - 1].close),
      Math.abs(daily[i].low - daily[i - 1].close),
    );
    if (i <= 14) { atr += tr / 14; }
    else atr = (atr * 13 + tr) / 14;
    // ATR value known at the END of day i is used for day i+1's open
    if (i >= 14) out.set(daily[i + 1]?.time ?? daily[i].time + 86_400_000, atr);
  }
  return out;
}

const dayKey = (ms: number) => Math.floor(ms / 86_400_000) * 86_400_000;

interface Trade {
  day: number; side: 'long' | 'short'; tpFrac: number; entry: number; exit: number;
  rMultiple: number; pctReturn: number; outcome: 'tp' | 'sl' | 'timeout' | 'nofill';
}

function backtest(m1: Candle[], daily: Candle[], openHHMM: string, tpFrac: number): Trade[] {
  const [oh, om] = openHHMM.split(':').map(Number);
  const openMs = (oh * 60 + om) * MIN;
  const atrByDay = atr14(daily);
  const byMin = new Map<number, Candle>();
  for (const c of m1) byMin.set(c.time, c);

  const trades: Trade[] = [];
  const firstDay = dayKey(m1[0].time) + 86_400_000;
  const lastDay = dayKey(m1[m1.length - 1].time);

  for (let d = firstDay; d <= lastDay; d += 86_400_000) {
    const openT = d + openMs;
    // NYSE session — skip weekends (Sat=6, Sun=0)
    if (openHHMM === '13:30') { const wd = new Date(openT).getUTCDay(); if (wd === 0 || wd === 6) continue; }

    // build the 15m opening candle from 1m bars
    let hi = -Infinity, lo = Infinity, first: number | null = null, last = 0;
    for (let k = 0; k < 15; k++) {
      const c = byMin.get(openT + k * MIN);
      if (!c) continue;
      if (first === null) first = c.open;
      last = c.close;
      hi = Math.max(hi, c.high);
      lo = Math.min(lo, c.low);
    }
    if (first === null || !isFinite(hi) || !isFinite(lo)) continue;
    const range = hi - lo;
    if (range <= 0) continue;

    const atr = atrByDay.get(dayKey(openT));
    if (!atr || range < ATR_FRAC * atr) continue; // not a liquidity candle

    const green = last >= first;
    const side: 'long' | 'short' = green ? 'short' : 'long';
    const entryPx = green ? hi : lo;
    const tpDist = tpFrac * range;
    const tp = side === 'long' ? entryPx + tpDist : entryPx - tpDist;
    const sl = side === 'long' ? entryPx - tpDist / 2 : entryPx + tpDist / 2;

    // fill within 90 min of the open
    let filled = false, fillIdx = 0;
    for (let k = 15; k < 15 + FILL_WINDOW_MIN; k++) {
      const c = byMin.get(openT + k * MIN);
      if (!c) continue;
      if ((side === 'long' && c.low <= entryPx) || (side === 'short' && c.high >= entryPx)) { filled = true; fillIdx = k; break; }
    }
    if (!filled) { trades.push({ day: d, side, tpFrac, entry: entryPx, exit: entryPx, rMultiple: 0, pctReturn: 0, outcome: 'nofill' }); continue; }

    // manage
    const dir = side === 'long' ? 1 : -1;
    let exitPx = entryPx, outcome: Trade['outcome'] = 'timeout';
    for (let k = fillIdx + 1; k < 15 + HOLD_MAX_MIN; k++) {
      const c = byMin.get(openT + k * MIN);
      if (!c) continue;
      const hitSl = side === 'long' ? c.low <= sl : c.high >= sl;
      const hitTp = side === 'long' ? c.high >= tp : c.low <= tp;
      if (hitSl) { exitPx = sl; outcome = 'sl'; break; }
      if (hitTp) { exitPx = tp; outcome = 'tp'; break; }
      exitPx = c.close;
    }
    const net = (dir * (exitPx - entryPx)) / entryPx - 2 * COST;
    const riskPct = (tpDist / 2) / entryPx;
    trades.push({ day: d, side, tpFrac, entry: entryPx, exit: exitPx, rMultiple: net / riskPct, pctReturn: net, outcome });
  }
  return trades;
}

function stats(ts: Trade[]) {
  const filled = ts.filter((t) => t.outcome !== 'nofill');
  const n = filled.length;
  const w = filled.filter((t) => t.pctReturn > 0).length;
  const gW = filled.filter((t) => t.rMultiple > 0).reduce((s, t) => s + t.rMultiple, 0);
  const gL = -filled.filter((t) => t.rMultiple < 0).reduce((s, t) => s + t.rMultiple, 0);
  const totR = filled.reduce((s, t) => s + t.rMultiple, 0);
  let eqSpot = 1000, eqLev = 1000;
  for (const t of filled) { eqSpot += eqSpot * t.pctReturn; eqLev += eqLev * 0.1 * 10 * t.pctReturn; if (eqLev < 0) eqLev = 0; }
  const nofill = ts.filter((t) => t.outcome === 'nofill').length;
  const tp = filled.filter((t) => t.outcome === 'tp').length;
  const sl = filled.filter((t) => t.outcome === 'sl').length;
  const to = filled.filter((t) => t.outcome === 'timeout').length;
  return { n, wr: n ? w / n * 100 : 0, pf: gL > 0 ? gW / gL : n ? 99 : 0, totR, eqSpot, eqLev, nofill, tp, sl, to };
}

async function mainAllHours(m1: Record<string, Candle[]>, dl: Record<string, Candle[]>) {
  console.log(`\n═══ ALL 24 UTC "open" hours — ranked by win rate ═══`);
  for (const tpFrac of TP_FRACS) {
    console.log(`\n── TP = ${tpFrac === 0.382 ? '38.2%' : '61.8%'} Fib · SL = ½ TP (2:1) ──`);
    const rows: { hh: string; st: ReturnType<typeof stats>; longs: number; shorts: number }[] = [];
    for (let h = 0; h < 24; h++) {
      const hh = `${String(h).padStart(2, '0')}:00`;
      const all: Trade[] = [];
      for (const s of SYMBOLS) all.push(...backtest(m1[s], dl[s], hh, tpFrac));
      const st = stats(all);
      const filled = all.filter((t) => t.outcome !== 'nofill');
      rows.push({ hh, st, longs: filled.filter((t) => t.side === 'long').length, shorts: filled.filter((t) => t.side === 'short').length });
    }
    rows.sort((a, b) => b.st.wr - a.st.wr);
    console.log(`  hr     n   WR%    PF   totR   tp/sl   L/S    $1k→(10x)`);
    for (const r of rows) {
      const { st } = r;
      if (st.n < 6) continue;
      const mark = st.wr >= 50 && st.totR > 0 ? '  ★' : st.wr >= 45 && st.totR > 0 ? '  ·' : '';
      console.log(
        `  ${r.hh}  ${String(st.n).padStart(3)}  ${st.wr.toFixed(0).padStart(3)}  ${st.pf.toFixed(2).padStart(5)}  ${st.totR.toFixed(0).padStart(5)}  ${String(st.tp).padStart(2)}/${String(st.sl).padStart(2)}  ${String(r.longs).padStart(2)}/${String(r.shorts).padStart(2)}  ${st.eqLev.toFixed(0).padStart(6)}${mark}`,
      );
    }
  }
  // best single (hour, direction, tp) cell
  console.log(`\n── best (hour × direction × TP), n ≥ 6 ──`);
  const cells: { tag: string; st: ReturnType<typeof stats> }[] = [];
  for (const tpFrac of TP_FRACS) for (let h = 0; h < 24; h++) {
    const hh = `${String(h).padStart(2, '0')}:00`;
    const all: Trade[] = [];
    for (const s of SYMBOLS) all.push(...backtest(m1[s], dl[s], hh, tpFrac));
    for (const dir of ['long', 'short'] as const) {
      const sub = all.filter((t) => t.side === dir);
      const st = stats(sub);
      if (st.n >= 6) cells.push({ tag: `${hh} ${dir.padEnd(5)} TP${tpFrac === 0.382 ? '38' : '62'}`, st });
    }
  }
  cells.sort((a, b) => b.st.wr - a.st.wr);
  for (const c of cells.slice(0, 12)) {
    console.log(`  ${c.tag}  n${String(c.st.n).padStart(3)}  WR ${c.st.wr.toFixed(0)}%  PF ${c.st.pf.toFixed(2)}  totR ${c.st.totR.toFixed(0)}  $1k→ ${c.st.eqLev.toFixed(0)} (10x)`);
  }
}

// ─── Adapted for crypto: fade ANY manipulation candle, any time of day ───
// "mostly this happens in crypto too" — so drop the market-open constraint.
// Scan every 15m candle: if its range ≥ atrFrac·DailyATR AND it has a decisive
// body (|close-open| ≥ 0.6·range), it's a manipulation candle. Fade it —
// GREEN → short limit at its high, RED → long limit at its low. "Touch & turn":
// wait up to `touchBars` 15m bars for price to return to that level, then fill.
// TP = Fib retracement of the candle; SL = ½ TP dist (2:1). Hold ≤ holdBars.
function resample15m(m1: Candle[]): Candle[] {
  const out: Candle[] = [];
  let cur: Candle | null = null;
  let bucket = -1;
  for (const c of m1) {
    const b = Math.floor(c.time / (15 * MIN));
    if (b !== bucket) { if (cur) out.push(cur); cur = { ...c, time: b * 15 * MIN }; bucket = b; }
    else if (cur) { cur.high = Math.max(cur.high, c.high); cur.low = Math.min(cur.low, c.low); cur.close = c.close; cur.volume += c.volume; }
  }
  if (cur) out.push(cur);
  return out;
}

interface AnyTrade { entryTime: number; hour: number; side: 'long' | 'short'; rMultiple: number; pctReturn: number; outcome: 'tp' | 'sl' | 'timeout'; }

function backtestAny(m1: Candle[], daily: Candle[], tpFrac: number, atrFrac: number, opts: {
  bodyFrac: number; touchBars: number; holdBars: number; cooldownBars: number; onlySide?: 'long' | 'short';
}): AnyTrade[] {
  const c15 = resample15m(m1);
  const atrByDay = atr14(daily);
  const trades: AnyTrade[] = [];
  let busyUntil = 0;

  for (let i = 20; i < c15.length - opts.holdBars - 2; i++) {
    if (i < busyUntil) continue;
    const cand = c15[i];
    const range = cand.high - cand.low;
    if (range <= 0) continue;
    const atr = atrByDay.get(dayKey(cand.time));
    if (!atr || range < atrFrac * atr) continue;
    if (Math.abs(cand.close - cand.open) < opts.bodyFrac * range) continue; // needs a decisive body

    const green = cand.close >= cand.open;
    const side: 'long' | 'short' = green ? 'short' : 'long';
    if (opts.onlySide && side !== opts.onlySide) continue;
    const entryPx = green ? cand.high : cand.low;
    const tpDist = tpFrac * range;
    const tp = side === 'long' ? entryPx + tpDist : entryPx - tpDist;
    const sl = side === 'long' ? entryPx - tpDist / 2 : entryPx + tpDist / 2;

    // touch & turn: wait for price to return to the level
    let fillIdx = -1;
    for (let k = i + 1; k <= i + opts.touchBars && k < c15.length; k++) {
      const b = c15[k];
      if ((side === 'long' && b.low <= entryPx) || (side === 'short' && b.high >= entryPx)) { fillIdx = k; break; }
      // invalidated if price runs to the TP without us (already reverted) — skip
      if ((side === 'long' && b.low <= tp) || (side === 'short' && b.high >= tp)) { fillIdx = -2; break; }
    }
    if (fillIdx < 0) continue;

    const dir = side === 'long' ? 1 : -1;
    let exitPx = entryPx, outcome: AnyTrade['outcome'] = 'timeout';
    for (let k = fillIdx + 1; k <= fillIdx + opts.holdBars && k < c15.length; k++) {
      const b = c15[k];
      const hitSl = side === 'long' ? b.low <= sl : b.high >= sl;
      const hitTp = side === 'long' ? b.high >= tp : b.low <= tp;
      if (hitSl) { exitPx = sl; outcome = 'sl'; break; }
      if (hitTp) { exitPx = tp; outcome = 'tp'; break; }
      exitPx = b.close;
    }
    const net = (dir * (exitPx - entryPx)) / entryPx - 2 * COST;
    const riskPct = (tpDist / 2) / entryPx;
    trades.push({ entryTime: c15[fillIdx].time, hour: new Date(c15[fillIdx].time).getUTCHours(), side, rMultiple: net / riskPct, pctReturn: net, outcome });
    busyUntil = fillIdx + opts.cooldownBars;
  }
  return trades;
}

const aStats = (ts: AnyTrade[]) => {
  const n = ts.length;
  const w = ts.filter((t) => t.pctReturn > 0).length;
  const gW = ts.filter((t) => t.rMultiple > 0).reduce((s, t) => s + t.rMultiple, 0);
  const gL = -ts.filter((t) => t.rMultiple < 0).reduce((s, t) => s + t.rMultiple, 0);
  const totR = ts.reduce((s, t) => s + t.rMultiple, 0);
  let eq = 1000;
  for (const t of ts) { eq += eq * 0.1 * 10 * t.pctReturn; if (eq < 0) eq = 0; }
  return { n, wr: n ? w / n * 100 : 0, pf: gL > 0 ? gW / gL : n ? 99 : 0, totR, eq };
};

async function mainAny(m1: Record<string, Candle[]>, dl: Record<string, Candle[]>) {
  console.log(`\n═══ ADAPTED FOR CRYPTO — fade ANY manipulation candle, any time ═══`);
  console.log(`15m candle · range ≥ ${ATR_FRAC * 100}% Daily ATR · body ≥ 60% of range · touch&turn ≤ 8h · TP Fib · SL ½ TP (2:1)\n`);
  const opts = { bodyFrac: 0.6, touchBars: 32, holdBars: 96, cooldownBars: 8 };
  for (const tpFrac of TP_FRACS) {
    console.log(`── TP ${tpFrac === 0.382 ? '38.2%' : '61.8%'} ──`);
    for (const dir of [undefined, 'long', 'short'] as const) {
      const port: AnyTrade[] = [];
      for (const s of SYMBOLS) port.push(...backtestAny(m1[s], dl[s], tpFrac, ATR_FRAC, { ...opts, onlySide: dir }));
      port.sort((a, b) => a.entryTime - b.entryTime);
      const st = aStats(port);
      console.log(`  ${(dir ?? 'both').padEnd(6)} ${String(st.n).padStart(4)} trades  WR ${st.wr.toFixed(0)}%  PF ${st.pf.toFixed(2)}  totR ${st.totR.toFixed(0)}  $1k→ ${st.eq.toFixed(0)} (10x)`);
      if (!dir) {
        const rows = [];
        for (let h = 0; h < 24; h++) { const g = port.filter((t) => t.hour === h); if (g.length >= 10) rows.push({ h, st: aStats(g) }); }
        rows.sort((a, b) => b.st.wr - a.st.wr);
        for (const r of rows.slice(0, 6)) {
          const mk = r.st.wr >= 45 && r.st.totR > 0 ? ' ★' : '';
          console.log(`     ${String(r.h).padStart(2)}h  n${String(r.st.n).padStart(3)}  WR ${r.st.wr.toFixed(0)}%  PF ${r.st.pf.toFixed(2)}  totR ${r.st.totR.toFixed(0)}${mk}`);
        }
      }
    }
  }
}

async function main() {
  console.log(`\nTOUCH & TURN SCALPER — 15m opening range, fade the liquidity candle, Fib TP · ${DAYS}d · 7bps/side`);
  console.log(`filter: opening range ≥ ${ATR_FRAC * 100}% of Daily ATR(14) · fill ≤90m · SL = ½ TP dist (2:1) · sizing 10% margin @10x\n`);

  const m1: Record<string, Candle[]> = {};
  const dl: Record<string, Candle[]> = {};
  for (const s of SYMBOLS) {
    process.stdout.write(`fetching ${s} 1m (${DAYS}d) …`);
    m1[s] = await fetch1m(s, DAYS);
    dl[s] = await fetchDaily(s, DAYS);
    console.log(` ${m1[s].length} m1 bars`);
  }

  if (process.argv.includes('--allHours')) { await mainAllHours(m1, dl); console.log(); return; }
  if (process.argv.includes('--any')) { await mainAny(m1, dl); console.log(); return; }

  for (const open of OPENS) {
    console.log(`\n═══ open ${open} UTC ${open === '13:30' ? '(NYSE, weekdays)' : '(daily)'} ═══`);
    for (const tpFrac of TP_FRACS) {
      console.log(`  ── TP = ${tpFrac === 0.382 ? '38.2%' : '61.8%'} Fib ──`);
      const port: Trade[] = [];
      for (const s of SYMBOLS) {
        const tr = backtest(m1[s], dl[s], open, tpFrac);
        port.push(...tr);
        const st = stats(tr);
        console.log(`     ${s.replace('USDT', '').padEnd(4)} ${String(st.n).padStart(3)} trades (${st.tp}tp/${st.sl}sl/${st.to}to, ${st.nofill} nofill)  WR ${st.wr.toFixed(0)}%  PF ${st.pf.toFixed(2)}  totR ${st.totR.toFixed(0)}  $1k→ ${st.eqSpot.toFixed(0)} spot / ${st.eqLev.toFixed(0)} 10x`);
      }
      const st = stats(port);
      console.log(`     ${'PORT'.padEnd(4)} ${String(st.n).padStart(3)} trades              WR ${st.wr.toFixed(0)}%  PF ${st.pf.toFixed(2)}  totR ${st.totR.toFixed(0)}  $1k→ ${st.eqSpot.toFixed(0)} spot / ${st.eqLev.toFixed(0)} 10x`);
    }
  }
  console.log(`\nNote: crypto has no true open; results depend heavily on which session open. Carl trades US stocks.\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
