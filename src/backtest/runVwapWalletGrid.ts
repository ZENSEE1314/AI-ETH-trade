// Grid-search the VWAP-band + RSI params on BTC + BNB to see if ANY config has
// a real edge — long, short, and both directions.
//
//   npx tsx src/backtest/runVwapWalletGrid.ts [--days 1200]
//
// Ranks by blended (BTC+BNB) net R after 7bps/side, requiring a minimum trade
// count so a 3-trade fluke can't top the table. Then shows the $1000 outcome
// for the top configs at 10% fixed margin across leverage.

import type { Candle } from '../types.js';
import { backtestVwapBandRsi, summarize, type VbrTrade, type VwapBandRsiOptions } from './vwapBandRsi.js';

const MIRROR = 'https://data-api.binance.vision/api/v3/klines';
const SYMBOLS = ['BTCUSDT', 'BNBUSDT'];

const arg = (n: string, d: string) => {
  const h = process.argv.find((a) => a.startsWith(`--${n}=`));
  if (h) return h.split('=')[1];
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const DAYS = Number(arg('days', '1200'));
const MIN_TRADES = Number(arg('minTrades', '25'));

const TF_MS: Record<string, number> = { '1h': 3_600_000, '2h': 7_200_000, '4h': 14_400_000 };

async function fetchKlines(symbol: string, tf: string): Promise<Candle[]> {
  const step = TF_MS[tf];
  const end = Date.now();
  let cursor = end - DAYS * 86_400_000;
  const byTime = new Map<number, Candle>();
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

type Dir = 'long' | 'short' | 'both';
interface Cfg {
  tf: string;
  dir: Dir;
  bandMult: number;
  rsi: number; // symmetric: long at rsi, short at 100-rsi
  stopPct: number;
  tp2Sigma: number;
  anchor: 'rolling' | 'daily';
  rollingLen: number;
}

function toOpts(c: Cfg): VwapBandRsiOptions {
  return {
    anchor: c.anchor,
    rollingLen: c.rollingLen,
    bandMult: c.bandMult,
    rsiPeriod: 14,
    rsiLong: c.rsi,
    rsiShort: 100 - c.rsi,
    armBars: 6,
    maxBars: c.tf === '4h' ? 30 : 60,
    longOnly: c.dir === 'long',
    shortOnly: c.dir === 'short',
    stopMode: 'entryPct',
    stopPct: c.stopPct,
    scaleFrac: 0.5,
    tp1LockFrac: 0.5,
    tp2Sigma: c.tp2Sigma,
    minBandWidthPct: 0.8,
    costBps: 7,
  };
}

function* grid(): Generator<Cfg> {
  for (const tf of ['1h', '2h', '4h'])
    for (const dir of ['long', 'short', 'both'] as Dir[])
      for (const bandMult of [1.5, 2, 2.5])
        for (const rsi of [25, 30, 35])
          for (const stopPct of [0.75, 1, 1.5, 2])
            for (const tp2Sigma of [1, 1.5, 2])
              for (const [anchor, rollingLen] of [['rolling', 30], ['rolling', 50], ['daily', 0]] as [Cfg['anchor'], number][])
                yield { tf, dir, bandMult, rsi, stopPct, tp2Sigma, anchor, rollingLen };
}

function simWallet(trades: VbrTrade[], start: number, marginPct: number, lev: number) {
  let eq = start;
  let peak = start;
  let wins = 0;
  let liq = 0;
  let maxDdPct = 0;
  const liqThresh = 100 / lev - (lev >= 50 ? 0.1 : 0.05);
  for (const t of trades) {
    const margin = eq * (marginPct / 100);
    if (t.maePct >= liqThresh) { eq -= margin; liq++; }
    else { eq += margin * lev * t.pctReturn; if (t.pctReturn > 0) wins++; }
    peak = Math.max(peak, eq);
    maxDdPct = Math.max(maxDdPct, (peak - eq) / peak * 100);
    if (eq <= 0) { eq = 0; break; }
  }
  return { eq, wins, liq, maxDdPct, n: trades.length };
}

async function main() {
  const data: Record<string, Record<string, Candle[]>> = {};
  for (const tf of ['1h', '2h', '4h']) {
    data[tf] = {};
    for (const sym of SYMBOLS) {
      process.stdout.write(`fetching ${sym} ${tf} …`);
      data[tf][sym] = await fetchKlines(sym, tf);
      console.log(` ${data[tf][sym].length} bars`);
    }
  }

  interface Row {
    c: Cfg;
    n: number;
    wr: number;
    totalR: number;
    pf: number;
    ddR: number;
    btcR: number;
    bnbR: number;
    blended: VbrTrade[];
  }
  const rows: Row[] = [];

  for (const c of grid()) {
    const opts = toOpts(c);
    const btc = backtestVwapBandRsi(data[c.tf].BTCUSDT, opts).trades;
    const bnb = backtestVwapBandRsi(data[c.tf].BNBUSDT, opts).trades;
    const blended = [...btc, ...bnb].sort((a, b) => a.entryTime - b.entryTime);
    if (blended.length < MIN_TRADES) continue;
    const s = summarize(blended);
    // require BOTH coins to be non-terrible so we don't ride one coin's luck
    const btcR = summarize(btc).totalR;
    const bnbR = summarize(bnb).totalR;
    rows.push({ c, n: blended.length, wr: s.winRatePct, totalR: s.totalR, pf: s.profitFactor === Infinity ? 99 : s.profitFactor, ddR: s.maxDrawdownR, btcR, bnbR, blended });
  }

  rows.sort((a, b) => b.totalR - a.totalR);
  console.log(`\n${rows.length} configs with ≥${MIN_TRADES} blended trades over ~${(DAYS / 365).toFixed(1)}y\n`);
  console.log('  #  tf   dir   band rsi  sl  tp2  anchor      n   WR%   totalR   PF   ddR    BTC_R   BNB_R');
  const show = (r: Row, i: number) =>
    `${String(i + 1).padStart(3)}  ${r.c.tf.padEnd(3)}  ${r.c.dir.padEnd(5)} ${String(r.c.bandMult).padStart(4)} ${String(r.c.rsi).padStart(3)} ${String(r.c.stopPct).padStart(3)} ${String(r.c.tp2Sigma).padStart(4)}  ${(r.c.anchor + (r.c.rollingLen || '')).padEnd(10)} ${String(r.n).padStart(3)}  ${String(r.wr).padStart(4)}  ${r.totalR.toFixed(1).padStart(7)}  ${r.pf.toFixed(2).padStart(4)}  ${r.ddR.toFixed(1).padStart(5)}  ${r.btcR.toFixed(1).padStart(6)}  ${r.bnbR.toFixed(1).padStart(6)}`;
  rows.slice(0, 20).forEach((r, i) => console.log(show(r, i)));

  console.log(`\nBOTTOM 5 (worst):`);
  rows.slice(-5).forEach((r, i) => console.log(show(r, rows.length - 5 + i)));

  // $1000 outcome for the best config that has BOTH coins positive
  const best = rows.find((r) => r.btcR > 0 && r.bnbR > 0) ?? rows[0];
  console.log(`\n── $1000 · 10% fixed margin · best config with both coins +ve ──`);
  console.log(JSON.stringify(best.c));
  const years = (best.blended[best.blended.length - 1].entryTime - best.blended[0].entryTime) / (365.25 * 86_400_000);
  console.log(`n=${best.n} · WR ${best.wr}% · ~${years.toFixed(2)}y`);
  for (const lev of [3, 5, 8, 12, 20, 50]) {
    const w = simWallet(best.blended, 1000, 10, lev);
    const mult = w.eq / 1000;
    const cagr = w.eq > 0 ? (mult ** (1 / years) - 1) * 100 : 0;
    console.log(`  ${String(lev + 'x').padStart(4)}  $${w.eq.toFixed(0).padStart(9)}  WR ${(w.wins / w.n * 100).toFixed(0)}%  liq ${w.liq}  maxDD ${w.maxDdPct.toFixed(0)}%  ${mult.toFixed(2)}x  CAGR ${cagr.toFixed(0)}%`);
  }
  console.log();
}

main().catch((e) => { console.error(e); process.exit(1); });
