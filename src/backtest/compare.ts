// Config bake-off: run every entry approach the engine can trade through the
// same 1m history and rank them, so "which way is best" has a number behind it.
//
//   npm run compare                        # default data + 5.5bps cost
//   npm run compare -- data/eth90.json     # a different history
//   npm run compare -- --cost-bps 0        # frictionless (raw edge)
//   npm run compare -- --min-trades 15     # hide variants with too few trades
//
// Cost matters — a thin edge dies on fees. Default is a Bybit-taker-ish 5.5bps
// per side; pass --cost-bps 0 to see the frictionless picture too.

import { config } from '../config.js';
import { loadCandles } from './loadCandles.js';
import { fetchBybitKlines } from './fetchBybit.js';
import { backtest, type BacktestOptions, type BacktestStats } from './backtest.js';

const DEFAULT_DATA = 'data/eth-1m-90d.json';

interface Variant {
  name: string;
  note: string;
  opts: BacktestOptions;
}

/** Every way the engine knows how to enter. Gates (conf/RR) are per-variant so
 *  each approach runs at the selectivity it was designed for. */
function variants(): Variant[] {
  const draw = { targetMode: 'draw', stopMode: 'swing' } as const;
  return [
    {
      name: 'default',
      note: 'shipping engine — 7-stage, conf60/RR2',
      opts: { minConfluence: 60, minRiskReward: 2, signal: { ...draw } },
    },
    {
      name: 'trained',
      note: 'learned.json — conf75/RR4, sweep stop',
      opts: { minConfluence: 75, minRiskReward: 4, signal: { targetMode: 'draw', stopMode: 'sweep' } },
    },
    {
      name: 'loose',
      note: 'low bar — conf45/RR1.5',
      opts: { minConfluence: 45, minRiskReward: 1.5, signal: { ...draw } },
    },
    {
      name: 'near-target',
      note: 'bank at the nearest pool instead of the far draw',
      opts: { minConfluence: 60, minRiskReward: 1.5, signal: { targetMode: 'near', stopMode: 'swing' } },
    },
    {
      name: 'partial',
      note: 'scale out at near pool + breakeven runner',
      opts: { minConfluence: 60, minRiskReward: 2, signal: { ...draw }, partial: true },
    },
    {
      name: 'entry-15m',
      note: 'enter off the 15M HL/LH, skip the 1M drill-down',
      opts: { minConfluence: 55, minRiskReward: 2, signal: { ...draw, entryMode: '15m' } },
    },
    {
      name: 'entry-15m+cd',
      note: 'entry-15m but sit out 4h after each trade (throttle overtrading)',
      opts: {
        minConfluence: 55,
        minRiskReward: 2,
        signal: { ...draw, entryMode: '15m' },
        cooldownBars: 240,
      },
    },
    {
      name: 'entry-15m+mkr',
      note: 'entry-15m with a resting limit entry (maker fee, some misses)',
      opts: {
        minConfluence: 55,
        minRiskReward: 2,
        signal: { ...draw, entryMode: '15m' },
        makerEntry: true,
        makerBps: 2,
      },
    },
    {
      name: 'chain',
      note: 'strict manual chain: 1H HL/LH → 15M → 1M + VWAP',
      opts: { minConfluence: 60, minRiskReward: 2, signal: { ...draw, chain: true } },
    },
    {
      name: 'channel',
      note: 'trend-channel slope filter + band target',
      opts: {
        minConfluence: 55,
        minRiskReward: 1.5,
        signal: { ...draw, channelFilter: true, channelTarget: true },
      },
    },
    {
      name: 'liq-gate',
      note: 'only enter on a fresh 1H liquidity sweep (±0.5%)',
      opts: { minConfluence: 55, minRiskReward: 2, signal: { ...draw, liqProximityPct: 0.5 } },
    },
    {
      name: 'flip',
      note: 'channel-flip + swept EQH/EQL (alt model)',
      opts: { minConfluence: 0, minRiskReward: 0, flip: { length: 50, mult: 2, lookback: 40, targetMode: 'near' } },
    },
    {
      name: 'reversal',
      note: 'channel-band reversal + VWAP (alt model)',
      opts: { minConfluence: 0, minRiskReward: 0, reversal: { length: 50, mult: 2 } },
    },
    {
      name: 'travel',
      note: '15M green→red structure travel, 1H-gated (alt model)',
      opts: { minConfluence: 0, minRiskReward: 0, travel: { trigger: '15m', h1Mode: 'strict' } },
    },
    {
      name: 'choch',
      note: 'sweep → CHoCH → OB/FVG retest reversal (alt model)',
      opts: { minConfluence: 0, minRiskReward: 0, choch: { patternWindowBars: 60, targetFallbackR: 3 } },
    },
    {
      name: 'htf-travel',
      note: '4H green→red travel, 1D context, tight stop (alt model)',
      opts: {
        minConfluence: 0,
        minRiskReward: 0,
        htfTravel: { lineTf: '4h', ctxTf: '1d', entryTolPct: 0.5, stopPastPct: 0.5, minRangePct: 1.2, maxRangePct: 12 },
      },
    },
  ];
}

function num(flag: string, def: number): number {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? Number(process.argv[i + 1]) : def;
}

async function loadData(): Promise<{ m1: Awaited<ReturnType<typeof loadCandles>>; source: string }> {
  const args = process.argv.slice(2);
  // A bare token is the data path only if it doesn't sit right after a --flag
  // (those tokens are flag values like the number in `--cost-bps 5.5`).
  const positional = args.find((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
  if (positional) return { m1: await loadCandles(positional), source: positional };
  try {
    return { m1: await loadCandles(DEFAULT_DATA), source: DEFAULT_DATA };
  } catch {
    const m1 = await fetchBybitKlines(config.symbol, 90);
    return { m1, source: `Bybit ${config.symbol} 90d (live pull — ${DEFAULT_DATA} missing)` };
  }
}

function row(name: string, s: BacktestStats): string {
  const pf = s.profitFactor === Infinity ? '  ∞ ' : s.profitFactor.toFixed(2).padStart(4);
  return [
    name.padEnd(12),
    String(s.trades).padStart(4),
    `${(s.winRate * 100).toFixed(0)}%`.padStart(5),
    s.avgR.toFixed(3).padStart(7),
    s.totalR.toFixed(1).padStart(7),
    pf,
    s.maxDrawdownR.toFixed(1).padStart(6),
    `${s.avgBarsHeld}m`.padStart(6),
  ].join('  ');
}

async function main(): Promise<void> {
  const { m1, source } = await loadData();
  if (m1.length < 5000) {
    console.error(`Only ${m1.length} 1m candles at ${source} — need a real history to compare.`);
    process.exit(1);
  }
  const costBps = num('--cost-bps', 5.5);
  const minTrades = num('--min-trades', 5);
  const from = new Date(m1[0].time).toISOString().slice(0, 10);
  const to = new Date(m1.at(-1)!.time).toISOString().slice(0, 10);

  console.log(`\nConfig bake-off — ${source}`);
  console.log(`  ${m1.length} × 1m  (${from} → ${to})   cost ${costBps}bps/side   hiding <${minTrades} trades\n`);

  const results = variants().map((v) => {
    const { stats } = backtest(m1, { ...v.opts, symbol: config.symbol, costBps });
    return { ...v, stats };
  });

  const ranked = [...results].sort((a, b) => b.stats.totalR - a.stats.totalR);

  console.log('  variant         trades   WR%    exp/R   totalR    PF     maxDD   hold');
  console.log('  ' + '─'.repeat(72));
  for (const r of ranked) {
    const thin = r.stats.trades < minTrades;
    console.log((thin ? '  · ' : '    ') + row(r.name, r.stats) + (thin ? '  (thin)' : ''));
  }

  const best = ranked.find((r) => r.stats.trades >= minTrades && r.stats.totalR > 0);
  console.log('\n  ' + '─'.repeat(72));
  if (best) {
    console.log(`  best: ${best.name} — ${best.note}`);
    console.log(`        ${best.stats.totalR.toFixed(1)}R over ${best.stats.trades} trades, ` +
      `${(best.stats.winRate * 100).toFixed(0)}% WR, ${best.stats.avgR.toFixed(3)}R expectancy, PF ${best.stats.profitFactor}`);
  } else {
    console.log('  best: none — no variant is net-positive on this history after cost.');
  }
  console.log('');
}

main().catch((err) => {
  console.error('Compare failed:', (err as Error).message);
  process.exit(1);
});
