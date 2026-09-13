// BTC + BNB — VWAP-band + RSI (live params) with a FIXED 10%-of-wallet margin
// per trade, swept across leverage. Answers: "if I risk 10% of the wallet per
// trade at high leverage with the 1% stop, what's the win rate and what does
// $1000 become per coin, over what period?"
//
//   npx tsx src/backtest/runVwapWallet.ts [--days 540] [--start 1000] [--marginPct 10]
//
// Model: isolated margin. Each trade commits `marginPct`% of current equity.
//   pnl        = margin * leverage * pctReturn         (pctReturn already net of 7bps/side)
//   liquidation = adverse excursion (maePct) reaches ~100/leverage before the
//                 stop/TP logic plays out → lose the committed margin only
//                 (the rest of the wallet survives).
// One position at a time, compounding.

import type { Candle } from '../types.js';
import { backtestVwapBandRsi, type VbrTrade, type VwapBandRsiOptions } from './vwapBandRsi.js';

const MIRROR = 'https://data-api.binance.vision/api/v3/klines';
const SYMBOLS = ['BTCUSDT', 'BNBUSDT'];
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
const MARGIN_PCT = Number(arg('marginPct', '10'));
const LEVERAGES = [5, 8, 10, 12, 15, 20];

// Live band-fade params (DEFAULT_VBR): rolling-50 VWAP, 1% stop, TP2 1.5σ.
const OPTS: VwapBandRsiOptions = {
  anchor: 'rolling',
  rollingLen: 50,
  bandMult: 2,
  rsiPeriod: 14,
  rsiLong: 30,
  armBars: 6,
  maxBars: 30,
  longOnly: true,
  stopMode: 'entryPct',
  stopPct: 1,
  scaleFrac: 0.5,
  tp1LockFrac: 0.5,
  tp2Sigma: 1.5,
  minBandWidthPct: 0.8,
  costBps: 7,
};

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

interface WalletResult {
  finalEquity: number;
  peak: number;
  trough: number;
  wins: number;
  trades: number;
  liquidations: number;
  maxDdPct: number;
}

function simWallet(trades: VbrTrade[], start: number, marginPct: number, lev: number): WalletResult {
  let eq = start;
  let peak = start;
  let trough = start;
  let wins = 0;
  let liquidations = 0;
  let maxDdPct = 0;
  const liqThresh = 100 / lev - (lev >= 50 ? 0.1 : 0.05); // maint + fee buffer, % adverse
  for (const t of trades) {
    const margin = eq * (marginPct / 100);
    if (t.maePct >= liqThresh) {
      eq -= margin; // isolated margin: lose only the committed margin
      liquidations++;
    } else {
      eq += margin * lev * t.pctReturn;
      if (t.pctReturn > 0) wins++;
    }
    peak = Math.max(peak, eq);
    trough = Math.min(trough, eq);
    maxDdPct = Math.max(maxDdPct, (peak - eq) / peak * 100);
    if (eq <= 0) { eq = 0; break; }
  }
  return { finalEquity: eq, peak, trough, wins, trades: trades.length, liquidations, maxDdPct };
}

function fmt(n: number): string {
  if (n >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
}

async function main() {
  console.log(`\nBTC + BNB · VWAP-band + RSI (long-only, 4h, rolling-50) · 1% stop · TP1 bank 50% → BE+ · TP2 1.5σ`);
  console.log(`FIXED ${MARGIN_PCT}% of wallet as margin per trade · compounding · one position at a time · 7bps/side\n`);

  const perSym: Record<string, VbrTrade[]> = {};
  for (const sym of SYMBOLS) {
    process.stdout.write(`fetching ${sym} ${TF} …`);
    const bars = await fetchKlines(sym);
    const { trades, stats } = backtestVwapBandRsi(bars, OPTS);
    perSym[sym] = trades;
    const span = trades.length
      ? ((trades[trades.length - 1].entryTime - trades[0].entryTime) / 86_400_000).toFixed(0)
      : '0';
    const first = new Date(bars[0].time).toISOString().slice(0, 10);
    const last = new Date(bars[bars.length - 1].time).toISOString().slice(0, 10);
    console.log(` ${bars.length} bars  ${first}→${last}  |  ${trades.length} trades over ~${span}d  ·  raw WR ${stats.winRatePct}%  ·  ${stats.totalR}R  ·  PF ${stats.profitFactor}  ·  maxDD ${stats.maxDrawdownR}R`);
  }

  const hdr = 'lev'.padStart(5) + '   final$'.padStart(11) + '   peak'.padStart(11) + '   WR%'.padStart(8) + '   liq'.padStart(6) + '   maxDD%'.padStart(9) + '   x'.padStart(9);
  for (const sym of SYMBOLS) {
    const trades = perSym[sym];
    const years = trades.length
      ? (trades[trades.length - 1].entryTime - trades[0].entryTime) / (365.25 * 86_400_000)
      : 0;
    console.log(`\n── ${sym.replace('USDT', '')} · ${trades.length} trades · ~${years.toFixed(2)}y ${'─'.repeat(40)}`);
    console.log(hdr);
    for (const lev of LEVERAGES) {
      const r = simWallet(trades, START, MARGIN_PCT, lev);
      const mult = r.finalEquity / START;
      const cagr = years > 0 && r.finalEquity > 0 ? (mult ** (1 / years) - 1) * 100 : 0;
      console.log(
        String(lev + 'x').padStart(5) +
        fmt(r.finalEquity).padStart(11) +
        fmt(r.peak).padStart(11) +
        `${(r.wins / r.trades * 100).toFixed(0)}%`.padStart(8) +
        String(r.liquidations).padStart(6) +
        `${r.maxDdPct.toFixed(0)}%`.padStart(9) +
        `${mult.toFixed(1)}x`.padStart(9) +
        (cagr ? `   CAGR ${cagr.toFixed(0)}%` : ''),
      );
    }
  }

  // blended: both coins, sequential by entry time, shared wallet
  const blended = [...perSym.BTCUSDT, ...perSym.BNBUSDT].sort((a, b) => a.entryTime - b.entryTime);
  const years = (blended[blended.length - 1].entryTime - blended[0].entryTime) / (365.25 * 86_400_000);
  console.log(`\n── BTC+BNB BLENDED · ${blended.length} trades · ~${years.toFixed(2)}y ${'─'.repeat(30)}`);
  console.log(hdr);
  for (const lev of LEVERAGES) {
    const r = simWallet(blended, START, MARGIN_PCT, lev);
    const mult = r.finalEquity / START;
    const cagr = years > 0 && r.finalEquity > 0 ? (mult ** (1 / years) - 1) * 100 : 0;
    console.log(
      String(lev + 'x').padStart(5) +
      fmt(r.finalEquity).padStart(11) +
      fmt(r.peak).padStart(11) +
      `${(r.wins / r.trades * 100).toFixed(0)}%`.padStart(8) +
      String(r.liquidations).padStart(6) +
      `${r.maxDdPct.toFixed(0)}%`.padStart(9) +
      `${mult.toFixed(1)}x`.padStart(9) +
      (cagr ? `   CAGR ${cagr.toFixed(0)}%` : ''),
    );
  }
  console.log();
}

main().catch((e) => { console.error(e); process.exit(1); });
