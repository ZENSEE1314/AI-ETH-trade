// `npm run learn -- <1m.json|.csv | --bybit ETHUSDT 90 | --demo>`
// (a 1m file may be JSON or a TradingView CSV export — see loadCandles.ts)
//
// Teaches the engine to trade like the reference journal: it builds the user's
// profile from src/learning/history.ts, searches the strategy's parameters on
// the given 1m data, and writes the best config to learned.json. The paper
// engine then trades that way. Run it again on fresh data to learn again.

import { writeFile } from 'node:fs/promises';
import type { Candle } from '../types.js';
import { config } from '../config.js';
import { fetchBybitKlines } from '../backtest/fetchBybit.js';
import { loadCandles } from '../backtest/loadCandles.js';
import { USER_TRADES } from './history.js';
import { buildProfile } from './profile.js';
import { optimize } from './optimizer.js';
import { saveLearned, type LearnedParams } from './store.js';

/** A small GBM demo series so the pipeline runs with no data or network. */
function demoSeries(minutes = 20000): Candle[] {
  const m1: Candle[] = [];
  let t = Date.UTC(2026, 0, 1);
  let price = 3000;
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < minutes; i++) {
    const drift = Math.sin(i / 800) * 0.0004;
    const ret = drift + (rnd() - 0.5) * 0.0022;
    const o = price;
    const c = o * (1 + ret);
    const h = Math.max(o, c) * (1 + rnd() * 0.0015);
    const l = Math.min(o, c) * (1 - rnd() * 0.0015);
    m1.push({ time: t, open: o, high: h, low: l, close: c, volume: 1000 });
    price = c;
    t += 60_000;
  }
  return m1;
}

async function main() {
  const argv = process.argv.slice(2);
  const flag = (n: string, d?: string) => {
    const i = argv.indexOf(n);
    return i >= 0 ? argv[i + 1] : d;
  };
  const window = Number(flag('--window', '45000')); // cap data so the search stays fast
  const costBps = Number(flag('--cost-bps', '0')); // per-side fee+slippage, bps (Bybit taker ≈ 5.5)

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
    source = `Bybit ${symbol} 1m×${m1.length}`;
  } else {
    const path = argv.find((a) => !a.startsWith('--'));
    if (!path) {
      console.error('Usage: npm run learn -- <1m.json|.csv> | --bybit <SYMBOL> <days> | --demo  [--window N]');
      process.exit(1);
    }
    m1 = await loadCandles(path);
    source = path;
  }
  if (m1.length > window) m1 = m1.slice(-window);
  if (m1.length < 500) {
    console.error(`Only ${m1.length} candles — need more history to learn from.`);
    process.exit(1);
  }

  const profile = buildProfile(USER_TRADES);
  console.log('\nYour trading profile (from history.ts):');
  console.log(
    `  trades ${profile.n}  |  ${(profile.longShare * 100).toFixed(0)}% long / ${(100 - profile.longShare * 100).toFixed(0)}% short  |  ` +
      `win rate ${(profile.winRate * 100).toFixed(0)}%  |  avg stop ${profile.avgStopPct}%  |  avgR ${profile.avgR} (median ${profile.medianR})  |  target=${profile.targetStyle}`,
  );

  console.log(`\nLearning on ${source} (${m1.length} × 1m)${costBps > 0 ? ` — cost ${costBps}bps/side` : ' — frictionless'}…`);
  const ranked = optimize(m1, profile, undefined, costBps);
  const best = ranked[0];

  console.log('\nTop configs (best first):');
  console.log('  fit    target/stop     exit         conf  rr   chan  trades  WR      exp     PF');
  for (const c of ranked.slice(0, 8)) {
    const exit = c.params.partial ? 'partial' : c.params.beAtR > 0 ? `be${c.params.beAtR}` : 'tp';
    const chan = c.params.channelFilter ? 'on' : 'off';
    console.log(
      `  ${c.fitness.toFixed(2).padStart(5)}  ${(c.params.signal.targetMode + '/' + c.params.signal.stopMode).padEnd(14)} ${exit.padEnd(11)} ` +
        `${String(c.params.minConfluence).padStart(3)}  ${String(c.params.minRiskReward).padStart(3)}  ${chan.padStart(4)}  ${String(c.stats.trades).padStart(5)}  ` +
        `${(c.stats.winRate * 100).toFixed(1).padStart(5)}%  ${c.stats.avgR.toFixed(3).padStart(6)}  ${String(c.stats.profitFactor)}`,
    );
  }

  const learned: LearnedParams = {
    ...best.params,
    meta: {
      trainedAt: Date.now(),
      dataPoints: m1.length,
      fitness: round(best.fitness, 3),
      winRate: round(best.stats.winRate, 4),
      avgR: round(best.stats.avgR, 3),
      hitDrawRate: round(best.stats.hitDrawRate, 4),
      note: `learned from ${source}`,
    },
  };
  saveLearned(learned);
  const dumpPath = flag('--out');
  if (dumpPath) await writeFile(dumpPath, JSON.stringify(learned, null, 2));

  console.log(
    `\n✓ Learned config saved to ${config.dataDir}/learned.json — the paper engine will now trade this way:\n` +
      `  target=${learned.signal.targetMode} stop=${learned.signal.stopMode} ` +
      `${learned.partial ? 'partial(scale+BE) ' : learned.beAtR ? `be@${learned.beAtR}R ` : ''}` +
      `conf≥${learned.minConfluence} rr≥${learned.minRiskReward}` +
      `${learned.liqProximityPct > 0 ? ` liq-gate≤${learned.liqProximityPct}%` : ''}` +
      `${learned.channelFilter ? ' chan-filter' : ''}\n`,
  );
  console.log(
    'Note: this is parameter learning on the given data — it tunes the engine toward your profile.\n' +
      'On synthetic/random data it cannot manufacture your win rate; feed real 1m klines (--bybit or a file)\n' +
      'for a config that reflects real market behaviour, and re-run to keep learning.',
  );
}

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

main().catch((err) => {
  console.error('Learn failed:', (err as Error).message);
  process.exit(1);
});
