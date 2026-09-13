// TAD system backtest — Turtle + Atom + Duck (Fred Tam / 10percentaday).
// Reverse-engineered from public descriptions (exact Atom/Duck code is closed):
//
//   TURTLE  Donchian: 20-bar high = buy breakout, 20-bar low = sell breakout,
//           10-bar opposite channel = trailing exit (classic Donchian stop).
//   ATOM    Bollinger Bands (length 20, 1.0 SD): long needs close > upper band,
//           short needs close < lower band.
//   DUCK    EMA 50: long only when close > EMA50, short only when close < EMA50.
//   FILTER  breakout bar volume > SMA(volume, 20).
//
//   Entry  = all three aligned + volume. Initial stop = opposite 10-bar Donchian
//            at entry. Then the stop trails the 10-bar Donchian each bar.
//
//   npx tsx src/backtest/runTad.ts [--tf 1d] [--allowShort] [--start 1000]
//
// Data: Binance spot mirror (data-api.binance.vision), full listed history.

import type { Candle } from '../types.js';

const MIRROR = 'https://data-api.binance.vision/api/v3/klines';
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT'];

const arg = (n: string, d: string) => {
  const h = process.argv.find((a) => a.startsWith(`--${n}=`));
  if (h) return h.split('=')[1];
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const TF = arg('tf', '1d');
const START = Number(arg('start', '1000'));
const ALLOW_SHORT = process.argv.includes('--allowShort');
const COST_BPS = Number(arg('costBps', '7')) / 10_000;

const DON_ENTRY = 20;
const DON_EXIT = 10;
const BB_LEN = 20;
const BB_SD = 1.0;
const EMA_LEN = 50;
const VOL_LEN = 20;

const TF_MS: Record<string, number> = { '1m': 60_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000, '1h': 3_600_000, '2h': 7_200_000, '4h': 14_400_000, '12h': 43_200_000, '1d': 86_400_000, '1w': 604_800_000 };

async function fetchAll(symbol: string, tf: string): Promise<Candle[]> {
  const step = TF_MS[tf];
  const byTime = new Map<number, Candle>();
  // low TFs = millions of bars over full history; cap the lookback so a run finishes.
  const capDays = tf === '1m' ? 270 : tf === '5m' ? 540 : tf === '15m' || tf === '30m' ? 1095 : 0;
  let cursor = capDays ? Date.now() - capDays * 86_400_000 : Date.parse('2017-07-01');
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

function ema(vals: number[], len: number): number[] {
  const k = 2 / (len + 1);
  const out: number[] = [];
  let prev = vals[0];
  for (let i = 0; i < vals.length; i++) {
    prev = i === 0 ? vals[0] : vals[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}
const sma = (vals: number[], i: number, len: number) => {
  if (i < len - 1) return NaN;
  let s = 0;
  for (let j = i - len + 1; j <= i; j++) s += vals[j];
  return s / len;
};
const stdev = (vals: number[], i: number, len: number, mean: number) => {
  let s = 0;
  for (let j = i - len + 1; j <= i; j++) s += (vals[j] - mean) ** 2;
  return Math.sqrt(s / len);
};
const highest = (c: Candle[], i: number, len: number) => {
  let m = -Infinity;
  for (let j = i - len + 1; j <= i; j++) m = Math.max(m, c[j].high);
  return m;
};
const lowest = (c: Candle[], i: number, len: number) => {
  let m = Infinity;
  for (let j = i - len + 1; j <= i; j++) m = Math.min(m, c[j].low);
  return m;
};

interface Trade {
  side: 'long' | 'short';
  entryTime: number;
  entry: number;
  exit: number;
  exitTime: number;
  rMultiple: number;
  pctReturn: number; // net price return in the trade direction, after costs
  bars: number;
  win: boolean;
  mfePct: number;
  maePct: number;
}

function backtest(c: Candle[]): Trade[] {
  const closes = c.map((x) => x.close);
  const vols = c.map((x) => x.volume);
  const ema50 = ema(closes, EMA_LEN);
  const trades: Trade[] = [];
  let pos: null | { side: 'long' | 'short'; entry: number; entryIdx: number; stop: number; initialStop: number } = null;

  for (let i = Math.max(DON_ENTRY, EMA_LEN, BB_LEN, VOL_LEN) + 1; i < c.length; i++) {
    const bar = c[i];
    const mid = sma(closes, i, BB_LEN);
    const sd = stdev(closes, i, BB_LEN, mid);
    const bbUp = mid + BB_SD * sd;
    const bbDn = mid - BB_SD * sd;
    const donHi = highest(c, i - 1, DON_ENTRY); // prior-bar channel
    const donLo = lowest(c, i - 1, DON_ENTRY);
    const volAvg = sma(vols, i, VOL_LEN);

    if (pos) {
      // trail the 10-bar opposite Donchian
      const trailLong = lowest(c, i - 1, DON_EXIT);
      const trailShort = highest(c, i - 1, DON_EXIT);
      if (pos.side === 'long') pos.stop = Math.max(pos.stop, trailLong);
      else pos.stop = Math.min(pos.stop, trailShort);

      const hitStop = pos.side === 'long' ? bar.low <= pos.stop : bar.high >= pos.stop;
      if (hitStop) {
        const exit = pos.stop;
        const dir = pos.side === 'long' ? 1 : -1;
        const risk = Math.abs(pos.entry - pos.initialStop) || pos.entry * 0.02;
        const gross = (dir * (exit - pos.entry)) / pos.entry;
        const net = gross - 2 * COST_BPS;
        trades.push({
          side: pos.side,
          entryTime: c[pos.entryIdx].time,
          entry: pos.entry,
          exit,
          exitTime: bar.time,
          rMultiple: round((dir * (exit - pos.entry)) / risk - 2 * COST_BPS * (pos.entry / risk), 3),
          pctReturn: round(net, 5),
          bars: i - pos.entryIdx,
          win: net > 0,
          mfePct: 0,
          maePct: 0,
        });
        pos = null;
      } else {
        continue; // stay in the trade; no re-entry while in position
      }
    }

    if (pos || Number.isNaN(volAvg) || sd === 0) continue;

    const volOk = bar.volume > volAvg;
    const longSig = bar.close > donHi && bar.close > bbUp && bar.close > ema50[i] && volOk;
    const shortSig = ALLOW_SHORT && bar.close < donLo && bar.close < bbDn && bar.close < ema50[i] && volOk;

    if (longSig) {
      const initStop = lowest(c, i, DON_EXIT);
      pos = { side: 'long', entry: bar.close, entryIdx: i, stop: initStop, initialStop: initStop };
    } else if (shortSig) {
      const initStop = highest(c, i, DON_EXIT);
      pos = { side: 'short', entry: bar.close, entryIdx: i, stop: initStop, initialStop: initStop };
    }
  }

  // mark-to-market open position at the last close
  if (pos) {
    const bar = c[c.length - 1];
    const dir = pos.side === 'long' ? 1 : -1;
    const risk = Math.abs(pos.entry - pos.initialStop) || pos.entry * 0.02;
    const net = (dir * (bar.close - pos.entry)) / pos.entry - 2 * COST_BPS;
    trades.push({
      side: pos.side, entryTime: c[pos.entryIdx].time, entry: pos.entry, exit: bar.close, exitTime: bar.time,
      rMultiple: round((dir * (bar.close - pos.entry)) / risk, 3), pctReturn: round(net, 5),
      bars: c.length - 1 - pos.entryIdx, win: net > 0, mfePct: 0, maePct: 0,
    });
  }
  return trades;
}

function round(n: number, dp: number) { const f = 10 ** dp; return Math.round(n * f) / f; }
function fmt(n: number) {
  if (n >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
}

function equityCurve(trades: Trade[], start: number, sizePct: number, lev: number) {
  let eq = start;
  let peak = start;
  let maxDdPct = 0;
  let wins = 0;
  for (const t of trades) {
    const margin = eq * (sizePct / 100);
    // liquidation if the adverse move in-trade exceeds ~100/lev (we lack true MAE
    // per bar here, so approximate with the realised loss on losers only)
    eq += margin * lev * t.pctReturn;
    if (t.pctReturn > 0) wins++;
    if (eq < 0) eq = 0;
    peak = Math.max(peak, eq);
    maxDdPct = Math.max(maxDdPct, (peak - eq) / peak * 100);
  }
  return { eq, wins, n: trades.length, maxDdPct };
}

async function main() {
  console.log(`\nTAD SYSTEM (Turtle 20/10 · Atom BB20,1.0 · Duck EMA50 · vol>SMA20) — ${TF} bars, full history`);
  console.log(`entry: all 3 aligned + volume · exit: trailing 10-bar Donchian · ${ALLOW_SHORT ? 'long+short' : 'LONG ONLY'} · 7bps/side\n`);

  for (const sym of SYMBOLS) {
    process.stdout.write(`fetching ${sym} ${TF} …`);
    const bars = await fetchAll(sym, TF);
    const first = new Date(bars[0].time).toISOString().slice(0, 10);
    const last = new Date(bars[bars.length - 1].time).toISOString().slice(0, 10);
    const years = (bars[bars.length - 1].time - bars[0].time) / (365.25 * 86_400_000);
    console.log(` ${bars.length} bars  ${first}→${last}  (~${years.toFixed(1)}y)`);

    const trades = backtest(bars);
    const n = trades.length;
    const wins = trades.filter((t) => t.pctReturn > 0).length;
    const totalR = trades.reduce((s, t) => s + t.rMultiple, 0);
    const gW = trades.filter((t) => t.rMultiple > 0).reduce((s, t) => s + t.rMultiple, 0);
    const gL = -trades.filter((t) => t.rMultiple < 0).reduce((s, t) => s + t.rMultiple, 0);
    const pf = gL > 0 ? gW / gL : Infinity;
    const avgWin = trades.filter((t) => t.pctReturn > 0).reduce((s, t) => s + t.pctReturn, 0) / (wins || 1) * 100;
    const avgLoss = trades.filter((t) => t.pctReturn <= 0).reduce((s, t) => s + t.pctReturn, 0) / ((n - wins) || 1) * 100;
    const avgBars = trades.reduce((s, t) => s + t.bars, 0) / (n || 1);

    let peakR = 0, cumR = 0, ddR = 0;
    for (const t of trades) { cumR += t.rMultiple; peakR = Math.max(peakR, cumR); ddR = Math.max(ddR, peakR - cumR); }

    const bh = (bars[bars.length - 1].close / bars[0].close);

    console.log(`  ${n} trades · WR ${(wins / n * 100).toFixed(1)}% · totalR ${totalR.toFixed(1)} · PF ${pf === Infinity ? '∞' : pf.toFixed(2)} · maxDD ${ddR.toFixed(1)}R`);
    console.log(`  avg win +${avgWin.toFixed(1)}% · avg loss ${avgLoss.toFixed(1)}% · avg hold ${avgBars.toFixed(0)} bars · buy&hold ${bh.toFixed(1)}x`);
    console.log(`  $${START} outcomes (compounding, one position):`);
    for (const [tag, sz, lev] of [['spot 100% / 1x', 100, 1], ['10% margin / 5x', 10, 5], ['10% / 10x', 10, 10], ['20% / 10x', 20, 10], ['50% / 5x', 50, 5]] as [string, number, number][]) {
      const e = equityCurve(trades, START, sz, lev);
      const mult = e.eq / START;
      const cagr = e.eq > 0 ? (mult ** (1 / years) - 1) * 100 : -100;
      console.log(`    ${tag.padEnd(18)} ${fmt(e.eq).padStart(10)}  ${mult.toFixed(1)}x  CAGR ${cagr.toFixed(0)}%  maxDD ${e.maxDdPct.toFixed(0)}%`);
    }
    console.log();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
