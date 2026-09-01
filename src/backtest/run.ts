// Backtest runner.
//
//   npm run backtest -- data/eth-1m.json      # replay a saved 1m history (JSON)
//   npm run backtest -- data/eth-1m.csv       # …or a TradingView chart-data CSV
//   npm run backtest -- --bybit ETHUSDT 90    # pull 90d of 1m from Bybit (real)
//   npm run backtest -- --fetch ETHUSDT 1000  # pull recent 1m from Bitunix
//   npm run backtest -- --demo                # synthetic smoke test
//   npm run backtest -- --bybit ETHUSDT 90 --flip  # trend-channel flip + swept EQH/EQL
//
// The file may be JSON ({time,open,high,low,close,volume} objects or
// [time,…] arrays) or CSV (incl. a raw TradingView export); see loadCandles.ts.
// Confluence / R:R gates default to the app config; override with --min-conf /
// --min-rr, and --liq-prox N gates on a fresh hourly-liquidity sweep.

import { writeFile } from 'node:fs/promises';
import type { Candle } from '../types.js';
import { config } from '../config.js';
import { fetchKlines } from '../exchange/bitunix.js';
import { fetchBybitKlines } from './fetchBybit.js';
import { fetchBinanceKlines } from './fetchBinance.js';
import { loadCandles } from './loadCandles.js';
import { backtest, type BtTrade } from './backtest.js';

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
  const disable = (flag('--disable', '') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const beAtR = Number(flag('--be', '0')); // move stop to breakeven after this many R
  const liqProximityPct = Number(flag('--liq-prox', '0')); // hourly-liquidity sweep gate
  const bothChannel = argv.includes('--channel'); // filter + band target
  const channelFilter = bothChannel || argv.includes('--channel-filter'); // slope filter only
  const channelTarget = bothChannel || argv.includes('--channel-target'); // band target only
  const costBps = Number(flag('--cost-bps', '0')); // taker per-side fee+slippage, bps (Bybit taker ≈ 5.5)
  const cooldownBars = Number(flag('--cooldown', '0')); // 1m bars to sit out after a trade closes
  const makerEntry = argv.includes('--maker-entry'); // rest a limit at the trigger level
  const makerBps = Number(flag('--maker-bps', String(costBps))); // maker per-side fee, bps (Bybit ≈ 2)
  const fillWindow = Number(flag('--fill-window', '10')); // bars a maker entry limit stays live
  const chain = argv.includes('--chain'); // strict manual chain: 1H HL/LH → 15M → 1M + VWAP
  const entryMode = (flag('--entry-mode', '1m') as '1m' | '15m'); // trigger TF: drill to 1M, or enter on the 15M HL/LH itself
  const flip = argv.includes('--flip'); // trend-channel red/green flip + swept EQH/EQL entry
  const flipLen = Number(flag('--flip-len', '50'));
  const flipMult = Number(flag('--flip-mult', '2'));
  const flipLookback = Number(flag('--flip-lookback', '40'));
  const flipTarget = (flag('--flip-target', 'near') as 'near' | 'draw');
  const reversal = argv.includes('--reversal'); // LL@lower-band+VWAP -> HH, or mirror at the top
  const revLen = Number(flag('--rev-len', '50'));
  const revMult = Number(flag('--rev-mult', '2'));
  const revSwingLookback = Number(flag('--rev-swing-lookback', '2'));
  const revBandTolPct = Number(flag('--rev-band-tol', '0.15'));
  const revVwap = !argv.includes('--rev-no-vwap'); // require near/outside the VWAP band (default on)
  const revVwapTolPct = Number(flag('--rev-vwap-tol', '0.15'));
  const revTarget = (flag('--rev-target', 'opposite-swing') as 'opposite-swing' | 'channel');
  const travel = argv.includes('--travel'); // 15M green-line→red-line structure travel, 1H-gated
  const travelTolPct = Number(flag('--travel-tol', '0.25'));
  const travelH1 = (flag('--travel-h1', 'strict') as 'strict' | 'loose');
  const travelVolMult = Number(flag('--travel-vol', '0')); // require trigger bar volume ≥ N × avg
  const travelTarget = (flag('--travel-target', 'line') as 'line' | 'extend' | 'mtf');
  const travelTrigger = (flag('--travel-trigger', '15m') as '15m' | '1m');
  const travelSlRange = Number(flag('--travel-sl-range', '0')); // stop = N% of the green→red range from entry
  const travelRequireHl = argv.includes('--travel-require-hl');
  const travelHtf = (flag('--travel-htf', 'off') as 'off' | '4h' | '4h+1d'); // 4H/1D structure gate
  const travelMtfGuard = Number(flag('--travel-mtf-guard', '4')); // pool strength that "defends" a line
  const travelMtfReach = Number(flag('--travel-mtf-reach', '0.6')); // how far past the line a stronger pool may sit
  const travelMinStop = Number(flag('--travel-min-stop', '0.15')); // floor on stop distance, % of price
  const travelRequireDraw = argv.includes('--travel-require-draw'); // need a strong pool ahead
  const travelDrawDist = Number(flag('--travel-draw-dist', '6')); // how far ahead the draw may sit, %
  const travelSweepFirst = argv.includes('--travel-sweep-first'); // take the opposing liq first
  const travelSweepLookback = Number(flag('--travel-sweep-lookback', '20'));
  const travelRoundStep = Number(flag('--travel-round', '0')); // psychological round-number step
  const htfTravel = argv.includes('--htftravel'); // journal-matched HTF green→red travel
  const htfLineTf = (flag('--htf-line', '4h') as '15m' | '1h' | '4h' | '1d');
  const htfCtxTf = (flag('--htf-ctx', '1d') as '15m' | '1h' | '4h' | '1d' | 'off');
  const htfCtxStrict = argv.includes('--htf-ctx-strict');
  const htfEntryTol = Number(flag('--htf-entry-tol', '0.5'));
  const htfStopPast = Number(flag('--htf-stop-past', '0.5'));
  const htfMinRange = Number(flag('--htf-min-range', '1.2'));
  const htfMaxRange = Number(flag('--htf-max-range', '12'));
  const htfReaction = !argv.includes('--htf-no-reaction');
  const choch = argv.includes('--choch'); // SMC sweep→CHoCH→OB/FVG-retest reversal
  const chochWindow = Number(flag('--choch-window', '60'));
  const chochReaction = argv.includes('--choch-reaction');
  const chochFallbackR = Number(flag('--choch-fallback-r', '3'));
  const chochTargetMode = (flag('--choch-target', 'strong') as 'near' | 'strong');
  const chochTargetMaxR = Number(flag('--choch-target-max-r', '0'));
  const maxHoldBars = Number(flag('--max-hold', '240'));
  const travelHours = flag('--travel-hours'); // e.g. "7-17" (UTC)
  const travelStopBand = flag('--travel-stop-band'); // e.g. "0.25-0.55" (% of price)
  const parseRange = (s?: string): [number, number] | undefined => {
    if (!s) return undefined;
    const [a, b] = s.split('-').map(Number);
    return Number.isFinite(a) && Number.isFinite(b) ? [a, b] : undefined;
  };
  const dumpPath = flag('--dump');

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
  } else if (argv.includes('--binance')) {
    const i = argv.indexOf('--binance');
    const symbol = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : config.symbol;
    const days = Number(argv[i + 2] ?? 90);
    process.stderr.write(`Fetching ${days}d of ${symbol} 1m from Binance…\n`);
    m1 = await fetchBinanceKlines(symbol, days);
    source = `Binance ${symbol} 1m×${m1.length} (${days}d)`;
  } else if (argv.includes('--fetch')) {
    const symbol = flag('--fetch', config.symbol) ?? config.symbol;
    const limit = Number(argv[argv.indexOf('--fetch') + 2] ?? 1000);
    m1 = await fetchKlines(symbol, '1m', limit);
    source = `Bitunix ${symbol} 1m×${m1.length}`;
  } else {
    const path = argv.find((a) => !a.startsWith('--'));
    if (!path) {
      console.error(
        'Usage: npm run backtest -- <1m.json|.csv> | --bybit <SYMBOL> <days> | --binance <SYMBOL> <days> | --fetch <SYMBOL> <limit> | --demo',
      );
      process.exit(1);
    }
    m1 = await loadCandles(path);
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
    maxHoldBars,
    signal: { targetMode, stopMode, disable, liqProximityPct, channelFilter, channelTarget, chain, entryMode },
    partial,
    beAtR,
    costBps,
    cooldownBars,
    makerEntry,
    makerBps,
    fillWindowBars: fillWindow,
    flip: flip && {
      length: flipLen,
      mult: flipMult,
      lookback: flipLookback,
      targetMode: flipTarget,
    },
    reversal: reversal && {
      length: revLen,
      mult: revMult,
      swingLookback: revSwingLookback,
      bandTolerancePct: revBandTolPct,
      requireVwapBand: revVwap,
      vwapTolerancePct: revVwapTolPct,
      targetMode: revTarget,
    },
    travel: travel && {
      pullbackTolPct: travelTolPct,
      h1Mode: travelH1,
      volMult: travelVolMult,
      targetMode: travelTarget,
      trigger: travelTrigger,
      slRangePct: travelSlRange,
      requireHl: travelRequireHl,
      htfGate: travelHtf,
      mtfGuardStrength: travelMtfGuard,
      mtfReachPct: travelMtfReach,
      minStopPct: travelMinStop,
      requireHtfDraw: travelRequireDraw,
      drawMaxDistPct: travelDrawDist,
      sweepFirst: travelSweepFirst,
      sweepLookbackBars: travelSweepLookback,
      hoursUtc: parseRange(travelHours),
      stopBandPct: parseRange(travelStopBand),
      roundStep: travelRoundStep,
    },
    choch: choch && {
      patternWindowBars: chochWindow,
      requireReaction: chochReaction,
      targetFallbackR: chochFallbackR,
      targetMode: chochTargetMode,
      targetMaxR: chochTargetMaxR,
    },
    htfTravel: htfTravel && {
      lineTf: htfLineTf,
      ctxTf: htfCtxTf,
      ctxStrict: htfCtxStrict,
      entryTolPct: htfEntryTol,
      stopPastPct: htfStopPast,
      minRangePct: htfMinRange,
      maxRangePct: htfMaxRange,
      reactionCandle: htfReaction,
    },
  });

  if (dumpPath) {
    await writeFile(dumpPath, JSON.stringify(trades));
    process.stderr.write(`Dumped ${trades.length} trades → ${dumpPath}\n`);
  }

  const from = new Date(m1[0].time).toISOString().slice(0, 16);
  const to = new Date(m1.at(-1)!.time).toISOString().slice(0, 16);
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

  console.log(`\nBacktest — ${source}`);
  console.log(`  data:        ${m1.length} × 1m  (${from} → ${to} UTC)`);
  console.log(`  gates:       confluence ≥ ${minConf},  R:R ≥ ${minRR}   target=${targetMode} stop=${stopMode} entry=${entryMode}${partial ? ' partial(scale+BE)' : ''}${liqProximityPct > 0 ? ` liq-prox=${liqProximityPct}%` : ''}${channelFilter ? ' chan-filter' : ''}${channelTarget ? ' chan-target' : ''}${chain ? ' CHAIN(1H→15M→1M+VWAP)' : ''}${flip ? ` FLIP(len=${flipLen} mult=${flipMult} lookback=${flipLookback} target=${flipTarget})` : ''}${reversal ? ` REVERSAL(len=${revLen} mult=${revMult} band-tol=${revBandTolPct}% vwap=${revVwap} target=${revTarget})` : ''}${htfTravel ? ` HTF-TRAVEL(line=${htfLineTf} ctx=${htfCtxTf}${htfCtxStrict ? '(strict)' : ''} tol=${htfEntryTol}% stop=${htfStopPast}% range=${htfMinRange}-${htfMaxRange}%${htfReaction ? ' reaction' : ''})` : ''}${choch ? ` CHoCH(window=${chochWindow}${chochReaction ? ' reaction' : ''} fallback=${chochFallbackR}R)` : ''}${travel ? ` TRAVEL(trigger=${travelTrigger} sl-range=${travelSlRange}% h1=${travelH1} htf=${travelHtf}${travelRequireHl ? ' HL-only' : ''}${travelRequireDraw ? ' need-draw' : ''}${travelSweepFirst ? ' sweep-first' : ''} vol=${travelVolMult}× target=${travelTarget})` : ''}${costBps > 0 || makerEntry ? ` cost=${makerEntry ? `maker-in ${makerBps}` : costBps}/${costBps}bps` : ' (frictionless)'}${cooldownBars > 0 ? ` cooldown=${cooldownBars}` : ''}`);
  console.log('  ─────────────────────────────────────────────');
  console.log(`  trades:      ${stats.trades}   (${stats.wins}W / ${stats.losses}L / ${stats.timeouts} timeout)`);
  console.log(`  win rate:    ${pct(stats.winRate).padStart(7)}   ← trades closed net-positive (real WR)`);
  console.log(`  reached draw:${pct(stats.hitDrawRate).padStart(7)}   (hit the FULL target — stricter)`);
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
