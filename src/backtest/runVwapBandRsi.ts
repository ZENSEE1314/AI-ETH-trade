// Run the VWAP outer-band + RSI-cross backtest across ETH / BTC / BNB / SOL.
//
//   npx tsx src/backtest/runVwapBandRsi.ts [--tf 1h] [--days 365] [--grid]
//
// Data: Binance spot public mirror (data-api.binance.vision — no key). Falls
// back to data/<sym>-<tf>.json if a fetch fails, and caches successful pulls
// there so re-runs are instant.

import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Candle } from '../types.js';
import { backtestVwapBandRsi, summarize, type VwapBandRsiOptions, type VbrStats } from './vwapBandRsi.js';

const MIRROR = 'https://data-api.binance.vision/api/v3/klines';
const SYMBOLS = ['ETHUSDT', 'BTCUSDT', 'BNBUSDT', 'SOLUSDT'];

function arg(name: string, def: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.split('=')[1];
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : def;
}

const TF = arg('tf', '1h');
const DAYS = Number(arg('days', '365'));
const GRID = process.argv.includes('--grid');

const TF_MS: Record<string, number> = {
  '15m': 15 * 60_000,
  '30m': 30 * 60_000,
  '1h': 60 * 60_000,
  '2h': 120 * 60_000,
  '4h': 240 * 60_000,
};

async function fetchKlines(symbol: string, tf: string, days: number): Promise<Candle[]> {
  const step = TF_MS[tf];
  if (!step) throw new Error(`unsupported tf ${tf}`);
  const end = Date.now();
  const start = end - days * 86_400_000;
  const byTime = new Map<number, Candle>();
  let cursor = start;

  while (cursor < end) {
    const url = `${MIRROR}?symbol=${symbol}&interval=${tf}&startTime=${cursor}&limit=1000`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${symbol}`);
    const rows = (await res.json()) as unknown[][];
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const r of rows) {
      const t = Number(r[0]);
      byTime.set(t, {
        time: t,
        open: +(r[1] as string),
        high: +(r[2] as string),
        low: +(r[3] as string),
        close: +(r[4] as string),
        volume: +(r[5] as string) || 0,
      });
    }
    const newest = Number(rows[rows.length - 1][0]);
    if (!Number.isFinite(newest) || newest <= cursor) break;
    cursor = newest + step;
    if (rows.length < 1000) break;
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

async function loadData(symbol: string): Promise<Candle[]> {
  const dir = join(process.cwd(), 'data');
  const cache = join(dir, `${symbol.toLowerCase()}-${TF}-${DAYS}d.json`);
  try {
    const bars = await fetchKlines(symbol, TF, DAYS);
    if (bars.length > 100) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(cache, JSON.stringify(bars));
      return bars;
    }
    throw new Error('short fetch');
  } catch (e) {
    if (existsSync(cache)) {
      console.warn(`  ${symbol}: fetch failed (${(e as Error).message}) — using cache`);
      return JSON.parse(readFileSync(cache, 'utf8')) as Candle[];
    }
    throw e;
  }
}

function row(label: string, s: VbrStats): string {
  return [
    label.padEnd(16),
    String(s.trades).padStart(5),
    `${s.winRatePct}%`.padStart(7),
    `${s.tp1RatePct}%`.padStart(7),
    `${s.tp2RatePct}%`.padStart(7),
    s.avgR.toFixed(3).padStart(8),
    s.totalR.toFixed(1).padStart(8),
    (s.profitFactor === Infinity ? '∞' : s.profitFactor.toFixed(2)).padStart(6),
    s.maxDrawdownR.toFixed(1).padStart(7),
    String(s.avgBarsHeld).padStart(5),
    `${s.longs}/${s.shorts}`.padStart(9),
  ].join(' ');
}

const HEADER =
  'variant / symbol'.padEnd(16) +
  '  n'.padStart(6) +
  '  win%'.padStart(8) +
  '  tp1%'.padStart(8) +
  '  tp2%'.padStart(8) +
  '  avgR'.padStart(9) +
  ' totalR'.padStart(9) +
  '    pf'.padStart(7) +
  '  maxDD'.padStart(8) +
  ' hold'.padStart(6) +
  '   L/S'.padStart(10);

async function main() {
  console.log(`\nVWAP outer-band + RSI-cross — ${TF} bars, ${DAYS}d, spot\n`);
  console.log(`costs 7bps/side · band ±2σ · TP1 VWAP (bank 50%, BE) · TP2 opposite band\n`);

  const data: Record<string, Candle[]> = {};
  for (const sym of SYMBOLS) {
    process.stdout.write(`fetching ${sym} ${TF} …`);
    data[sym] = await loadData(sym);
    console.log(` ${data[sym].length} bars`);
  }

  const base: VwapBandRsiOptions = { armBars: 6, maxBars: 30 };
  const variants: { name: string; opts: VwapBandRsiOptions }[] = GRID
    ? [
        { name: 'daily 70/30', opts: { ...base } },
        { name: 'weekly 70/30', opts: { ...base, anchor: 'weekly' } },
        { name: 'weekly bank75', opts: { ...base, anchor: 'weekly', scaleFrac: 0.75 } },
        { name: 'weekly bank75 s1.5%', opts: { ...base, anchor: 'weekly', scaleFrac: 0.75, stopMode: 'entryPct', stopPct: 1.5 } },
        { name: 'roll30 70/30', opts: { ...base, anchor: 'rolling', rollingLen: 30 } },
        { name: 'roll30 bank75', opts: { ...base, anchor: 'rolling', rollingLen: 30, scaleFrac: 0.75 } },
        { name: 'roll30 reclaim b75', opts: { ...base, anchor: 'rolling', rollingLen: 30, trigger: 'reclaim', scaleFrac: 0.75 } },
        { name: 'roll50 bank75 s2%', opts: { ...base, anchor: 'rolling', rollingLen: 50, scaleFrac: 0.75, stopMode: 'entryPct', stopPct: 2 } },
      ]
    : [{ name: 'RSI 70/30 (as specified)', opts: { ...base } }];

  for (const v of variants) {
    console.log(`\n── ${v.name} ${'─'.repeat(60 - v.name.length)}`);
    console.log(HEADER);
    const agg = { all: [] as number[], long: [] as number[], short: [] as number[] };
    for (const sym of SYMBOLS) {
      const { trades } = backtestVwapBandRsi(data[sym], v.opts);
      const longs = trades.filter((t) => t.side === 'long');
      const shorts = trades.filter((t) => t.side === 'short');
      console.log(row(sym.replace('USDT', ''), summarize(trades)));
      console.log(row('  ├ long', summarize(longs)));
      console.log(row('  └ short', summarize(shorts)));
      agg.all.push(...trades.map((t) => t.rMultiple));
      agg.long.push(...longs.map((t) => t.rMultiple));
      agg.short.push(...shorts.map((t) => t.rMultiple));
    }
    const sum = (a: number[]) => a.reduce((s, x) => s + x, 0);
    console.log(
      `${'PORTFOLIO'.padEnd(16)} ${String(agg.all.length).padStart(5)}   ` +
        `all ${sum(agg.all).toFixed(1)}  ·  long ${sum(agg.long).toFixed(1)} (n${agg.long.length})  ·  short ${sum(agg.short).toFixed(1)} (n${agg.short.length})`,
    );
  }
  console.log();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
