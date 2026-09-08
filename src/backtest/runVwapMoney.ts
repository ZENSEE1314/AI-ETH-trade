// $ P&L sim for the long-only VWAP-band + RSI strategy with 100x leverage.
//
//   npx tsx src/backtest/runVwapMoney.ts [--days 540] [--start 1000]
//
// Strategy: long-only, lower-band tag + RSI cross up through 30, TP1 = VWAP
// (bank 50%), runner stop trails to +50% of the TP1 gain if TP2 (opposite
// band) is not hit. 4h bars, rolling-50 VWAP anchor.
//
// Three money models, each starting from `--start` and compounding, one coin
// at a time (one position, no overlap):
//   A  risk 3% of equity per trade  — leverage floats, capped at 100x
//   B  fixed 10x, full equity as margin every trade
//   C  full 100x, full equity as margin — liquidated if price runs ~0.9%
//      against the entry before the stop (1/100 leverage minus a fee buffer)

import type { Candle } from '../types.js';
import { backtestVwapBandRsi, type VbrTrade } from './vwapBandRsi.js';

const MIRROR = 'https://data-api.binance.vision/api/v3/klines';
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT'];
const TF = '4h';
const STEP = 240 * 60_000;

const arg = (n: string, d: string) => {
  const h = process.argv.find((a) => a.startsWith(`--${n}=`));
  if (h) return h.split('=')[1];
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const DAYS = Number(arg('days', '540'));
const START = Number(arg('start', '1000'));
const LIQ_ADVERSE_PCT = 0.9; // 100x ⇒ ~1% wipes margin; 0.9 leaves a fee/maint buffer

async function fetchKlines(symbol: string): Promise<Candle[]> {
  const end = Date.now();
  let cursor = end - DAYS * 86_400_000;
  const byTime = new Map<number, Candle>();
  while (cursor < end) {
    const url = `${MIRROR}?symbol=${symbol}&interval=${TF}&startTime=${cursor}&limit=1000`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${symbol}`);
    const rows = (await res.json()) as unknown[][];
    if (!rows.length) break;
    for (const r of rows) {
      const t = Number(r[0]);
      byTime.set(t, { time: t, open: +(r[1] as string), high: +(r[2] as string), low: +(r[3] as string), close: +(r[4] as string), volume: +(r[5] as string) || 0 });
    }
    const newest = Number(rows[rows.length - 1][0]);
    if (newest <= cursor) break;
    cursor = newest + STEP;
    if (rows.length < 1000) break;
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

interface MoneyResult {
  model: string;
  finalEquity: number;
  peak: number;
  trough: number;
  liquidated: boolean;
  liqTrade: number | null;
  wins: number;
  trades: number;
}

function simRisk(trades: VbrTrade[], start: number, riskPct: number, maxLev: number): MoneyResult {
  let eq = start;
  let peak = start;
  let trough = start;
  let wins = 0;
  for (const t of trades) {
    const stopDist = Math.abs(t.entry - t.stopLoss) / t.entry; // fraction
    let lev = riskPct / 100 / stopDist;
    if (lev > maxLev) lev = maxLev;
    const pnl = eq * lev * t.pctReturn;
    eq += pnl;
    if (t.pctReturn > 0) wins++;
    peak = Math.max(peak, eq);
    trough = Math.min(trough, eq);
    if (eq <= 0) return { model: '', finalEquity: 0, peak, trough, liquidated: true, liqTrade: trades.indexOf(t) + 1, wins, trades: trades.length };
  }
  return { model: '', finalEquity: eq, peak, trough, liquidated: false, liqTrade: null, wins, trades: trades.length };
}

function simFixedLev(trades: VbrTrade[], start: number, lev: number): MoneyResult {
  let eq = start;
  let peak = start;
  let trough = start;
  let wins = 0;
  for (let k = 0; k < trades.length; k++) {
    const t = trades[k];
    // liquidation: adverse excursion eats the margin before the stop / TP logic
    if (t.maePct >= 100 / lev - (lev >= 50 ? 0.1 : 0)) {
      return { model: '', finalEquity: 0, peak, trough, liquidated: true, liqTrade: k + 1, wins, trades: trades.length };
    }
    const pnl = eq * lev * t.pctReturn;
    eq += pnl;
    if (t.pctReturn > 0) wins++;
    peak = Math.max(peak, eq);
    trough = Math.min(trough, eq);
    if (eq <= 0) return { model: '', finalEquity: 0, peak, trough, liquidated: true, liqTrade: k + 1, wins, trades: trades.length };
  }
  return { model: '', finalEquity: eq, peak, trough, liquidated: false, liqTrade: null, wins, trades: trades.length };
}

function fmt(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
}

async function main() {
  console.log(`\nLONG-ONLY VWAP-band + RSI · 4h · rolling-50 VWAP · TP1 bank 50%, runner locks +50% of TP1`);
  console.log(`start ${fmt(START)} · ${DAYS}d · costs 7bps/side · compounding, one position at a time\n`);

  const opts = {
    anchor: 'rolling' as const,
    rollingLen: 50,
    longOnly: true,
    tp1LockFrac: 0.5,
    scaleFrac: 0.5,
    stopMode: 'entryPct' as const,
    stopPct: 2,
    armBars: 6,
    maxBars: 30,
  };

  let allTrades: VbrTrade[] = [];
  for (const sym of SYMBOLS) {
    process.stdout.write(`fetching ${sym} …`);
    const bars = await fetchKlines(sym);
    const { trades, stats } = backtestVwapBandRsi(bars, opts);
    console.log(` ${bars.length} bars, ${trades.length} long trades, ${stats.winRatePct}% win, ${stats.totalR}R`);

    const a = simRisk(trades, START, 3, 100);
    const b = simFixedLev(trades, START, 10);
    const c = simFixedLev(trades, START, 100);
    const line = (tag: string, m: MoneyResult) =>
      `   ${tag.padEnd(22)} ${fmt(m.finalEquity).padStart(10)}  peak ${fmt(m.peak).padStart(9)}  ` +
      (m.liquidated ? `LIQUIDATED on trade ${m.liqTrade}/${m.trades}` : `${m.wins}/${m.trades} win`);
    console.log(line('A risk 3%/trade ≤100x', a));
    console.log(line('B fixed 10x all-in', b));
    console.log(line('C fixed 100x all-in', c));
    console.log();
    allTrades.push(...trades);
  }

  allTrades.sort((x, y) => x.entryTime - y.entryTime);
  console.log(`── BLENDED (all 4 coins, sequential, one position) ${'─'.repeat(14)}`);
  const A = simRisk(allTrades, START, 3, 100);
  const B = simFixedLev(allTrades, START, 10);
  const C = simFixedLev(allTrades, START, 100);
  for (const [tag, m] of [['A risk 3%/trade ≤100x', A], ['B fixed 10x all-in', B], ['C fixed 100x all-in', C]] as [string, MoneyResult][]) {
    console.log(
      `   ${tag.padEnd(22)} ${fmt(m.finalEquity).padStart(10)}  peak ${fmt(m.peak).padStart(9)}  trough ${fmt(m.trough).padStart(8)}  ` +
        (m.liquidated ? `LIQUIDATED on trade ${m.liqTrade}/${m.trades}` : `${m.wins}/${m.trades} win`),
    );
  }
  console.log();
}

main().catch((e) => { console.error(e); process.exit(1); });
