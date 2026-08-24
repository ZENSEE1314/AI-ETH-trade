// Backtest runner.
//
//   npm run backtest -- data/eth-1m.json      # replay a saved 1m history
//   npm run backtest -- --bybit ETHUSDT 90    # pull 90d of 1m from Bybit (real)
//   npm run backtest -- --fetch ETHUSDT 1000  # pull recent 1m from Bitunix
//   npm run backtest -- --demo                # synthetic smoke test
//
// The 1m JSON may be an array of {time,open,high,low,close,volume} objects or
// of [time,open,high,low,close,volume] arrays. Confluence / R:R gates default
// to the app config; override with --min-conf N and --min-rr N.

import { readFile } from 'node:fs/promises';
import type { Candle } from '../types.js';
import { config } from '../config.js';
import { fetchKlines } from '../exchange/bitunix.js';
import { fetchBybitKlines } from './fetchBybit.js';
import { backtest, type BtTrade } from './backtest.js';

async function loadFromFile(path: string): Promise<Candle[]> {
  const raw = JSON.parse(await readFile(path, 'utf8'));
  const rows: any[] = Array.isArray(raw) ? raw : raw.data ?? raw.candles ?? [];
  const out = rows.map((r): Candle | null => {
    const [time, open, high, low, close, volume] = Array.isArray(r)
      ? r
      : [r.time ?? r.t ?? r.ts, r.open ?? r.o, r.high ?? r.h, r.low ?? r.l, r.close ?? r.c, r.volume ?? r.v ?? 0];
    const t = Number(time);
    const c = { time: t < 1e12 ? t * 1000 : t, open: +open, high: +high, low: +low, close: +close, volume: +volume || 0 };
    return [c.open, c.high, c.low, c.close, c.time].every(Number.isFinite) ? c : null;
  }).filter((c): c is Candle => c !== null);
  out.sort((a, b) => a.time - b.time);
  return out;
}

/**
 * A synthetic 1m series with repeated sweep-and-reclaim-into-draw cycles, plus
 * a deterministic zig-zag so fractal swings and sweeps actually form (a smooth
 * ramp has no pivots for the strategy to read). For smoke-testing the harness,
 * not for drawing conclusions.
 */
function demoSeries(cycles = 10): Candle[] {
  const m1: Candle[] = [];
  let t = Date.UTC(2026, 0, 1);
  let price = 2000;
  let seed = 42;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const push = (o: number, c: number, extraLow = 0, extraHigh = 0) => {
    const h = Math.max(o, c) + rnd() * 1.5 + extraHigh;
    const l = Math.min(o, c) - rnd() * 1.5 - extraLow;
    m1.push({ time: t, open: o, high: h, low: l, close: c, volume: 1000 });
    t += 60_000;
  };
  // one leg of `bars` candles drifting by `slope`/bar with zig-zag wiggle
  const leg = (bars: number, slope: number, wiggle: number) => {
    for (let i = 0; i < bars; i++) {
      const o = price;
      const c = o + slope + Math.sin(i / 3) * wiggle + (rnd() - 0.5) * wiggle;
      push(o, c);
      price = c;
    }
  };
  for (let cy = 0; cy < cycles; cy++) {
    leg(120, -0.8, 3); // drift down, forming a swing low
    leg(40, -0.3, 3); // consolidate near the low
    const o = price; // sweep candle: spike below the low, close back up
    push(o, o + 1, /*extraLow*/ 12);
    price = o + 1;
    leg(200, 1.2, 4); // rally toward the draw (buy-side liquidity overhead)
    leg(60, -0.2, 4); // pull back (higher low)
    leg(80, 1.0, 4); // continue up
  }
  return m1;
}

async function main() {
  const argv = process.argv.slice(2);
  const flag = (name: string, def?: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : def;
  };
  const minConf = Number(flag('--min-conf', String(config.minConfluence)));
  const minRR = Number(flag('--min-rr', String(config.minRiskReward)));
  const targetMode = (flag('--target', 'draw') as 'near' | 'draw');
  const stopMode = (flag('--stop', 'swing') as 'swing' | 'sweep');
  const partial = argv.includes('--partial'); // scale out at near, BE stop, run to draw

  let m1: Candle[];
  let source: string;
  if (argv.includes('--demo')) {
    m1 = demoSeries();
    source = 'synthetic demo';
  } else if (argv.includes('--bybit')) {
    const i = argv.indexOf('--bybit');
    const symbol = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : config.symbol;
    const days = Number(argv[i + 2] ?? 90);
    process.stderr.write(`Fetching ${days}d of ${symbol} 1m from Bybit…\n`);
    m1 = await fetchBybitKlines(symbol, days);
    source = `Bybit ${symbol} 1m×${m1.length} (${days}d)`;
  } else if (argv.includes('--fetch')) {
    const symbol = flag('--fetch', config.symbol) ?? config.symbol;
    const limit = Number(argv[argv.indexOf('--fetch') + 2] ?? 1000);
    m1 = await fetchKlines(symbol, '1m', limit);
    source = `Bitunix ${symbol} 1m×${m1.length}`;
  } else {
    const path = argv.find((a) => !a.startsWith('--'));
    if (!path) {
      console.error(
        'Usage: npm run backtest -- <1m.json> | --bybit <SYMBOL> <days> | --fetch <SYMBOL> <limit> | --demo',
      );
      process.exit(1);
    }
    m1 = await loadFromFile(path);
    source = path;
  }

  if (m1.length < 50) {
    console.error(`Only ${m1.length} 1m candles — need more history to backtest.`);
    process.exit(1);
  }

  const { stats, trades } = backtest(m1, {
    symbol: config.symbol,
    minConfluence: minConf,
    minRiskReward: minRR,
    signal: { targetMode, stopMode },
    partial,
  });

  const from = new Date(m1[0].time).toISOString().slice(0, 16);
  const to = new Date(m1.at(-1)!.time).toISOString().slice(0, 16);
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

  console.log(`\nBacktest — ${source}`);
  console.log(`  data:        ${m1.length} × 1m  (${from} → ${to} UTC)`);
  console.log(`  gates:       confluence ≥ ${minConf},  R:R ≥ ${minRR}   target=${targetMode} stop=${stopMode}${partial ? ' partial(scale+BE)' : ''}`);
  console.log('  ─────────────────────────────────────────────');
  console.log(`  trades:      ${stats.trades}   (${stats.wins}W / ${stats.losses}L / ${stats.timeouts} timeout)`);
  console.log(`  reached draw:${pct(stats.hitDrawRate).padStart(7)}   ← headline: hit TP before stop`);
  console.log(`  win rate:    ${pct(stats.winRate).padStart(7)}`);
  console.log(`  expectancy:  ${stats.avgR.toFixed(3)} R / trade`);
  console.log(`  total:       ${stats.totalR.toFixed(2)} R`);
  console.log(`  profit factor:${String(stats.profitFactor).padStart(6)}`);
  console.log(`  max drawdown:${stats.maxDrawdownR.toFixed(2).padStart(7)} R`);
  console.log(`  avg hold:    ${stats.avgBarsHeld} × 1m`);

  const byTf = (tf: string) => trades.filter((t) => t.drawTimeframe === tf);
  for (const tf of ['4H', '15M'] as const) {
    const g = byTf(tf);
    if (g.length) {
      const w = g.filter((t) => t.outcome === 'win').length;
      console.log(`    ${tf} draws: ${g.length} trades, ${pct(w / g.length)} reached draw`);
    }
  }

  const sample: BtTrade[] = trades.slice(0, 8);
  if (sample.length) {
    console.log('\n  first trades:');
    for (const t of sample) {
      console.log(
        `    ${new Date(t.entryTime).toISOString().slice(5, 16)}  ${t.side.padEnd(5)} ` +
          `entry ${t.entry.toFixed(2)}  tp ${t.takeProfit.toFixed(2)}  ${t.outcome.padEnd(7)} ${t.rMultiple >= 0 ? '+' : ''}${t.rMultiple}R`,
      );
    }
  }
  console.log('');
}

main().catch((err) => {
  console.error('Backtest failed:', (err as Error).message);
  process.exit(1);
});
