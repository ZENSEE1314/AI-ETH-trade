// Parameter sweep for the LONG-ONLY VWAP-band + RSI strategy:
// find the best stop, take-profit shape, then the best leverage.
//
//   npx tsx src/backtest/runVwapSweep.ts [--days 540]
//
// Phase 1 — grid over stop%, TP1 bank fraction, runner-lock fraction, TP2 σ.
//           Ranked by BTC and by BTC+BNB total R (the two coins that work long).
// Phase 2 — take the winner, sweep leverage with liquidation modelling on a
//           $1000 compounding account, one position at a time.

import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Candle } from '../types.js';
import { backtestVwapBandRsi, type VbrTrade, type VwapBandRsiOptions } from './vwapBandRsi.js';

const MIRROR = 'https://data-api.binance.vision/api/v3/klines';
const SYMBOLS = ['BTCUSDT', 'BNBUSDT', 'ETHUSDT', 'SOLUSDT'];
const TF = '4h';
const STEP = 240 * 60_000;
const arg = (n: string, d: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const DAYS = Number(arg('days', '540'));

async function fetchKlines(symbol: string): Promise<Candle[]> {
  const dir = join(process.cwd(), 'data');
  const cache = join(dir, `${symbol.toLowerCase()}-${TF}-${DAYS}d.json`);
  if (existsSync(cache)) return JSON.parse(readFileSync(cache, 'utf8')) as Candle[];
  const end = Date.now();
  let cursor = end - DAYS * 86_400_000;
  const byTime = new Map<number, Candle>();
  while (cursor < end) {
    const res = await fetch(`${MIRROR}?symbol=${symbol}&interval=${TF}&startTime=${cursor}&limit=1000`, { signal: AbortSignal.timeout(15_000) });
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
  const bars = [...byTime.values()].sort((a, b) => a.time - b.time);
  mkdirSync(dir, { recursive: true });
  writeFileSync(cache, JSON.stringify(bars));
  return bars;
}

const BASE: VwapBandRsiOptions = {
  anchor: 'rolling',
  rollingLen: 50,
  longOnly: true,
  stopMode: 'entryPct',
  armBars: 6,
  maxBars: 30,
};

function fmt(n: number): string {
  if (n >= 1e12) return `$${(n / 1e12).toFixed(1)}T`;
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
}

/** Compounding $ account, one position at a time, all-in at fixed leverage.
 *  Liquidated if a trade's adverse excursion reaches the margin (≈100/lev %). */
function simLev(trades: VbrTrade[], start: number, lev: number): { eq: number; peak: number; maxDdPct: number; liq: number | null } {
  let eq = start;
  let peak = start;
  let maxDd = 0;
  for (let k = 0; k < trades.length; k++) {
    const t = trades[k];
    const liqAt = 100 / lev - (lev >= 25 ? 0.15 : 0); // maintenance + fee buffer
    if (lev > 1 && t.maePct >= liqAt) return { eq: 0, peak, maxDdPct: 100, liq: k + 1 };
    eq += eq * lev * t.pctReturn;
    if (eq <= 0) return { eq: 0, peak, maxDdPct: 100, liq: k + 1 };
    peak = Math.max(peak, eq);
    maxDd = Math.max(maxDd, (peak - eq) / peak);
  }
  return { eq, peak, maxDdPct: round(maxDd * 100, 1), liq: null };
}

const round = (n: number, dp: number) => Math.round(n * 10 ** dp) / 10 ** dp;

async function main() {
  const data: Record<string, Candle[]> = {};
  for (const s of SYMBOLS) {
    process.stdout.write(`${s} `);
    data[s] = await fetchKlines(s);
  }
  console.log(`\n\nLONG-ONLY VWAP-band + RSI · 4h · rolling-50 VWAP · ${DAYS}d · 7bps/side\n`);

  // ---- Phase 1: strategy shape --------------------------------------------
  const stops = [0.5, 0.75, 1, 1.25, 1.5, 2];
  const banks = [0.2, 0.3, 0.5, 0.7];
  const locks = [0, 0.5];
  const tp2s = [1, 1.5, 2];

  type Row = { label: string; opts: VwapBandRsiOptions; btc: number; bnb: number; eth: number; sol: number; pf: number; n: number };
  const rows: Row[] = [];
  for (const stopPct of stops)
    for (const scaleFrac of banks)
      for (const tp1LockFrac of locks)
        for (const tp2Sigma of tp2s) {
          if (scaleFrac === 1.0 && (tp1LockFrac !== 0 || tp2Sigma !== tp2s[0])) continue; // no runner ⇒ lock/tp2 irrelevant
          const opts = { ...BASE, stopPct, scaleFrac, tp1LockFrac, tp2Sigma };
          const r = (s: string) => backtestVwapBandRsi(data[s], opts).stats;
          const btc = r('BTCUSDT');
          const bnb = r('BNBUSDT');
          const eth = r('ETHUSDT');
          const sol = r('SOLUSDT');
          rows.push({
            label: `SL ${stopPct}% · bank ${scaleFrac}${scaleFrac < 1 ? ` · lock ${tp1LockFrac} · TP2 ${tp2Sigma}σ` : ' (all at TP1)'}`,
            opts,
            btc: btc.totalR,
            bnb: bnb.totalR,
            eth: eth.totalR,
            sol: sol.totalR,
            pf: btc.profitFactor,
            n: btc.trades,
          });
        }

  const byBtcBnb = [...rows].sort((a, b) => b.btc + b.bnb - (a.btc + a.bnb));
  console.log('── TOP 12 by BTC+BNB total R ' + '─'.repeat(40));
  console.log('config'.padEnd(46) + 'BTC'.padStart(8) + 'BNB'.padStart(8) + 'ETH'.padStart(8) + 'SOL'.padStart(8) + 'pf'.padStart(7) + '  n');
  for (const x of byBtcBnb.slice(0, 12)) {
    console.log(
      x.label.padEnd(46) +
        x.btc.toFixed(1).padStart(8) +
        x.bnb.toFixed(1).padStart(8) +
        x.eth.toFixed(1).padStart(8) +
        x.sol.toFixed(1).padStart(8) +
        (x.pf === Infinity ? '∞' : x.pf.toFixed(2)).padStart(7) +
        `  ${x.n}`,
    );
  }

  // ---- Phase 2: leverage on the winner (BTC) ------------------------------
  const winner = byBtcBnb[0];
  console.log(`\n── LEVERAGE SWEEP · winner: ${winner.label} ` + '─'.repeat(12));
  console.log('applied to BTC alone, $1000 start, compounding, one position at a time\n');
  const btcTrades = backtestVwapBandRsi(data['BTCUSDT'], winner.opts).trades;
  const bnbTrades = backtestVwapBandRsi(data['BNBUSDT'], winner.opts).trades;
  const blend = [...btcTrades, ...bnbTrades].sort((a, b) => a.entryTime - b.entryTime);

  console.log('lev'.padStart(5) + '   BTC-only'.padStart(14) + '  maxDD'.padStart(9) + '   BTC+BNB'.padStart(14) + '  maxDD'.padStart(9));
  for (const lev of [2, 3, 5, 8, 10, 12, 14, 16, 18, 20, 25, 100]) {
    const a = simLev(btcTrades, 1000, lev);
    const b = simLev(blend, 1000, lev);
    const cell = (m: { eq: number; maxDdPct: number; liq: number | null }) =>
      (m.liq ? `LIQ #${m.liq}` : fmt(m.eq)).padStart(12) + `  ${m.maxDdPct}%`.padStart(8);
    console.log(`${String(lev) + 'x'}`.padStart(5) + '  ' + cell(a) + '   ' + cell(b));
  }
  console.log();
}

main().catch((e) => { console.error(e); process.exit(1); });
