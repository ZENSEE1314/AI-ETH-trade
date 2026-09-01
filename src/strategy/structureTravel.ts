// Structure travel: the "green line → red line" move from the Zeiierman-style
// 15M market-structure map. The 15M structure sets the leg — green→red (price
// still below the range top under a rising HL) is a long bias, red→green (price
// still above the range low under a falling LH) is a short bias.
//
// Two ways to time the entry:
//   trigger '15m' — buy the 15M pullback right at the green line (or sell at the
//     red line), the anchor swing must be fresh.
//   trigger '1m'  — once the 15M leg is set, drill to the 1M: take the next
//     candle after a fresh 1M reaction swing low (HL or swept LL) for a long,
//     or a fresh 1M reaction swing high (HH or LH) for a short.
//
// Stop: either a small buffer past the anchor swing, or — with slRangePct set —
// a fixed fraction of the green→red range away from entry. Target: the opposing
// line (or one range projected beyond it).

import { randomUUID } from 'node:crypto';
import type { Candle, Side, Signal } from '../types.js';
import { readStructure, lastReactionSwing } from './structure.js';
import { analyzeCandle } from './candles.js';
import { buildMtfLiquidityMap, pickTravelTarget, type MtfTf, type MtfLiquidityMap, type MtfPool } from './mtfLiquidity.js';

/** The multi-timeframe view the travel signal reads. h4/d1 may be empty. */
export interface TravelSnapshot {
  m1: Candle[];
  m15: Candle[];
  h1: Candle[];
  h4: Candle[];
  d1: Candle[];
}

export interface StructureTravelOptions {
  swingLookback?: number; // fractal width for the 15M / 1H swings
  pullbackTolPct?: number; // (15m trigger) how close price must sit to the line, % of price
  h1Mode?: 'strict' | 'loose'; // 'strict': 1H trend must match; 'loose': just not opposed
  htfGate?: 'off' | '4h' | '4h+1d'; // also require the 4H (and 1D) structure to agree
  volMult?: number; // require the trigger bar's volume ≥ this × recent average (0 = off)
  volWindow?: number; // bars to average volume over for the volume gate
  stopBufferPct?: number; // stop distance past the anchor swing, % of price
  slRangePct?: number; // if > 0, stop = this % of the green→red range away from entry
  minStopPct?: number; // floor on the stop distance, % of price (guards tiny-range setups)
  targetMode?: 'line' | 'extend' | 'mtf'; // 'mtf': read the stacked liquidity map for the target
  mtfGuardStrength?: number; // pool strength that counts as "defended" / "worth running to"
  mtfReachPct?: number; // how far beyond the line a stronger pool may sit and still be the target
  trigger?: '15m' | '1m'; // where the entry is timed (default '15m')
  m1Lookback?: number; // (1m trigger) fractal width for the 1M reaction swing
  requireHl?: boolean; // (1m trigger) require a true HL/LH, reject swept LL/HH
  /** Only trade when the stacked map has a real draw ahead — a pool in the trade
   *  direction with strength ≥ drawMinStrength within drawMaxDistPct of price. */
  requireHtfDraw?: boolean;
  drawMinStrength?: number; // default = mtfGuardStrength ?? 4
  drawMaxDistPct?: number; // how far ahead the draw may sit, % of price (default 6)
  /** For a long, wait until price has swept (pierced + reclaimed) the nearest
   *  MTF pool below within the last sweepLookbackBars trigger-TF bars — "take the
   *  down liq first". Mirror for a short (sweep the pool above). */
  sweepFirst?: boolean;
  sweepLookbackBars?: number; // default 20
  sweepTolPct?: number; // wick must come within this % of the pool (default 0.1)
  /** Add psychological round-number levels to the liquidity map at this price
   *  step (e.g. 50 → …1900, 1950, 2000…). 0 = off. */
  roundStep?: number;
  /** Session filter — only trigger when the entry bar's UTC hour is in [h, h). */
  hoursUtc?: [number, number];
  /** Only trigger when the stop distance falls in this % -of-price band — skips
   *  the fee-dominated tiny ranges and the sloppy huge ones. */
  stopBandPct?: [number, number];
}

export interface StructureTravel {
  side: Side;
  greenLine: number; // rising HL support — anchor for a long, target for a short
  redLine: number; // standing swing high — target for a long, anchor for a short
  bigVolume: boolean; // did the trigger bar print outsized volume
  triggerSwing: number; // the price the entry keys off (15M line, or 1M reaction swing)
  triggerLabel: string; // 'green line' | 'red line' | '1M HL' | '1M LL' | '1M HH' | '1M LH'
  map: MtfLiquidityMap; // the stacked-liquidity map at the trigger bar
  htfDraw: MtfPool | null; // the pool ahead the trade is drawn toward, if any
  sweptPool: MtfPool | null; // the opposing pool price swept first, if sweepFirst is on
}

/**
 * Read the 15M leg and time the entry. `m1` is only consulted for the '1m'
 * trigger; `h4`/`d1` only for the HTF gate.
 */
export function detectStructureTravel(
  snap: TravelSnapshot,
  opts: StructureTravelOptions = {},
): StructureTravel | null {
  const { m1, m15, h1, h4, d1 } = snap;
  const lookback = opts.swingLookback ?? 2;
  const tolPct = opts.pullbackTolPct ?? 0.25;
  const h1Mode = opts.h1Mode ?? 'strict';
  const htfGate = opts.htfGate ?? 'off';
  const volMult = opts.volMult ?? 0;
  const volWindow = opts.volWindow ?? 20;
  const trigger = opts.trigger ?? '15m';

  if (m15.length < lookback * 2 + 6) return null;

  const s15 = readStructure(m15, lookback);
  const s1h = readStructure(h1, lookback);
  if (!s15.lastSwingHigh || !s15.lastSwingLow) return null;

  const green = s15.lastSwingLow.price;
  const red = s15.lastSwingHigh.price;
  if (red <= green) return null;

  // Which leg are we in? green→red = long bias (still room below the top),
  // red→green = short bias (still room above the low).
  const px = m15.at(-1)!.close;
  let side: Side | null = null;
  if (s15.trend === 'bullish' && px < red) side = 'long';
  else if (s15.trend === 'bearish' && px > green) side = 'short';
  if (!side) return null;

  // 1H gate.
  if (h1Mode === 'strict') {
    if (side === 'long' && s1h.trend !== 'bullish') return null;
    if (side === 'short' && s1h.trend !== 'bearish') return null;
  } else {
    if (side === 'long' && s1h.trend === 'bearish') return null;
    if (side === 'short' && s1h.trend === 'bullish') return null;
  }

  // Higher-timeframe gate — 4H (and optionally 1D) must not oppose the leg.
  if (htfGate !== 'off') {
    const opposed = (c: Candle[]) => {
      if (c.length < lookback * 2 + 2) return false; // not enough history → don't block
      const s = readStructure(c, lookback).trend;
      return side === 'long' ? s === 'bearish' : s === 'bullish';
    };
    if (opposed(h4)) return null;
    if (htfGate === '4h+1d' && opposed(d1)) return null;
  }

  let triggerSwing: number;
  let triggerLabel: string;
  let volSeries: Candle[];

  if (trigger === '1m') {
    if (m1.length < (opts.m1Lookback ?? 2) * 2 + 4) return null;
    const m1Lb = opts.m1Lookback ?? 2;
    const react = lastReactionSwing(m1, side, m1Lb);
    if (!react) return null;
    // Fresh only — the pivot must be within a few bars of the last candle so we
    // really are entering on "the next candle" after it printed.
    if (m1.length - 1 - react.swing.index > m1Lb + 3) return null;
    if (opts.requireHl && !react.higher) return null; // reject swept LL / HH
    triggerSwing = react.swing.price;
    const hlLabel = side === 'long' ? (react.higher ? '1M HL' : '1M LL') : react.higher ? '1M LH' : '1M HH';
    triggerLabel = hlLabel;
    volSeries = m1;
  } else {
    const line = side === 'long' ? green : red;
    const near = (Math.abs(px - line) / px) * 100 <= tolPct;
    const rightSide = side === 'long' ? px > line : px < line;
    if (!near || !rightSide) return null;
    const anchorSwing = side === 'long' ? s15.lastSwingLow! : s15.lastSwingHigh!;
    if (m15.length - 1 - anchorSwing.index > lookback + 4) return null;
    triggerSwing = line;
    triggerLabel = side === 'long' ? 'green line' : 'red line';
    volSeries = m15;
  }

  const vols = volSeries.slice(-(volWindow + 1), -1).map((c) => c.volume);
  const avgVol = vols.length ? vols.reduce((a, b) => a + b, 0) / vols.length : 0;
  const bigVolume = avgVol > 0 && volSeries.at(-1)!.volume >= volMult * avgVol;
  if (volMult > 0 && !bigVolume) return null;

  // Stacked-liquidity map at this bar — the "liq of all hours" (1D→1M).
  const map = buildMtfLiquidityMap(mtfSeries(snap, lookback), px, 0.15, opts.roundStep ?? 0);
  const ahead = side === 'long' ? map.above : map.below;
  const behind = side === 'long' ? map.below : map.above;

  // Draw filter — is there a real target ahead worth trading toward?
  const drawStr = opts.drawMinStrength ?? opts.mtfGuardStrength ?? 4;
  const drawMaxDist = opts.drawMaxDistPct ?? 6;
  const htfDraw = ahead.find((p) => p.strength >= drawStr && p.distancePct <= drawMaxDist) ?? null;
  if (opts.requireHtfDraw && !htfDraw) return null;

  // Sweep-first — "take the down liq first". Require price to have pierced and
  // reclaimed the nearest opposing pool within the recent trigger-TF window.
  let sweptPool: MtfPool | null = null;
  if (opts.sweepFirst) {
    const pool = behind[0] ?? null;
    if (!pool) return null;
    const tol = opts.sweepTolPct ?? 0.1;
    const win = volSeries.slice(-(opts.sweepLookbackBars ?? 20));
    const pierced =
      side === 'long'
        ? win.some((c) => c.low <= pool.price * (1 + tol / 100)) && px > pool.price
        : win.some((c) => c.high >= pool.price * (1 - tol / 100)) && px < pool.price;
    if (!pierced) return null;
    sweptPool = pool;
  }

  return {
    side,
    greenLine: round(green),
    redLine: round(red),
    bigVolume,
    triggerSwing: round(triggerSwing),
    triggerLabel,
    map,
    htfDraw,
    sweptPool,
  };
}

/** Turn a detected structure-travel entry into a full trade Signal. */
export function generateStructureTravelSignal(
  snap: TravelSnapshot,
  symbol: string,
  opts: StructureTravelOptions = {},
): Signal | null {
  const t = detectStructureTravel(snap, opts);
  if (!t) return null;

  const { m1, m15 } = snap;
  const trigger = opts.trigger ?? '15m';
  const triggerBar = (trigger === '1m' ? m1 : m15).at(-1)!;
  const entry = triggerBar.close;
  const range = t.redLine - t.greenLine;

  // Session filter.
  if (opts.hoursUtc) {
    const h = new Date(triggerBar.time).getUTCHours();
    const [a, b] = opts.hoursUtc;
    const inWindow = a <= b ? h >= a && h < b : h >= a || h < b;
    if (!inWindow) return null;
  }

  let stopDist: number;
  if ((opts.slRangePct ?? 0) > 0) {
    stopDist = range * (opts.slRangePct! / 100);
  } else {
    const anchor = t.side === 'long' ? t.greenLine : t.redLine;
    stopDist = Math.abs(entry - anchor) + entry * ((opts.stopBufferPct ?? 0.15) / 100);
  }
  // Floor the stop so a tiny-range setup can't produce a few-tick stop that
  // trading costs then dwarf.
  stopDist = Math.max(stopDist, entry * ((opts.minStopPct ?? 0.15) / 100));
  const stopLoss = t.side === 'long' ? entry - stopDist : entry + stopDist;

  // Stop-band filter — the study shows stops of 0.25–0.5% of price carry the
  // edge; tighter ones are eaten by fees, wider ones are sloppy.
  if (opts.stopBandPct) {
    const stopPct = (stopDist / entry) * 100;
    if (stopPct < opts.stopBandPct[0] || stopPct > opts.stopBandPct[1]) return null;
  }

  const line = t.side === 'long' ? t.redLine : t.greenLine;
  const mode = opts.targetMode ?? 'line';
  let takeProfit = line;
  let targetReason = `${t.side === 'long' ? 'red' : 'green'} line`;
  if (mode === 'extend') {
    takeProfit = t.side === 'long' ? t.redLine + range : t.greenLine - range;
    targetReason = 'one range beyond the line';
  } else if (mode === 'mtf') {
    const pick = pickTravelTarget(t.map, t.side, line, {
      guardStrength: opts.mtfGuardStrength,
      reachPct: opts.mtfReachPct,
    });
    takeProfit = pick.price;
    targetReason = pick.reason;
    // If there's a real HTF draw further out (the ~3k stacked liquidity), and
    // the pick stopped at a nearer line, run to the draw instead.
    if (t.htfDraw) {
      const beyond = t.side === 'long' ? t.htfDraw.price > takeProfit : t.htfDraw.price < takeProfit;
      if (beyond) {
        takeProfit = t.htfDraw.price;
        targetReason = `HTF draw ${t.htfDraw.tfs.join('+')} @ ${t.htfDraw.price} (str ${t.htfDraw.strength})`;
      }
    }
  }

  const risk = Math.abs(entry - stopLoss);
  const reward = Math.abs(takeProfit - entry);
  if (risk <= 0 || reward <= 0) return null;

  const candle = analyzeCandle((trigger === '1m' ? m1 : m15).at(-1)!);
  const confirms =
    (t.side === 'long' && (candle.bullish || candle.rejection === 'bottom')) ||
    (t.side === 'short' && (candle.bearish || candle.rejection === 'top'));
  const confluence =
    60 + (t.bigVolume ? 15 : 0) + (confirms ? 10 : 0) + (t.sweptPool ? 10 : 0) + (t.htfDraw ? 5 : 0);

  return {
    id: randomUUID(),
    time: Date.now(),
    symbol,
    side: t.side,
    entry: round(entry),
    stopLoss: round(stopLoss),
    takeProfit: round(takeProfit),
    riskReward: round(reward / risk, 2),
    confluence,
    source: 'engine',
    reasons: [
      `TRAVEL: 15M ${t.side === 'long' ? 'green→red leg' : 'red→green leg'}, trigger ${t.triggerLabel} @ ${t.triggerSwing.toFixed(2)}`,
      ...(t.sweptPool ? [`SWEEP: took ${t.sweptPool.tfs.join('+')} liq @ ${t.sweptPool.price} first, then reclaimed`] : []),
      `TARGET: ${targetReason} @ ${takeProfit.toFixed(2)}${t.bigVolume ? '  [big volume]' : ''}`,
    ],
    sweptLevel: round(t.triggerSwing),
    // near = the 15M line (scale-out point); draw = the final target (may be a
    // stacked-liquidity pool beyond the line when the line is thin).
    nearTarget: round(line),
    drawTarget: round(takeProfit),
    drawTimeframe: '15M',
  };
}

/** The TF stack the MTF map reads, with per-TF strength weights. */
function mtfSeries(snap: TravelSnapshot, baseFractal: number): MtfTf[] {
  return [
    { label: '1D', weight: 5, candles: snap.d1, fractal: 2 },
    { label: '4H', weight: 3, candles: snap.h4, fractal: 2 },
    { label: '1H', weight: 2, candles: snap.h1, fractal: baseFractal },
    { label: '15M', weight: 1, candles: snap.m15, fractal: baseFractal },
    { label: '1M', weight: 0.5, candles: snap.m1.slice(-240), fractal: baseFractal },
  ];
}

function round(n: number, dp = 4): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
