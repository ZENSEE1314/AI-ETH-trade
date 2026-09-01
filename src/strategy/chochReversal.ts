// CHoCH reversal — the SMC sequence the reference articles describe:
//
//   liquidity  →  sweep  →  CHoCH  →  OB / FVG retest  →  entry
//
// For a long: price sweeps a swing low (grabs sell-side liquidity) and reclaims
// it, then breaks the most recent swing high that formed on the way down (the
// change of character), leaving an imbalance behind. The entry is the pullback
// into that imbalance (an unmitigated FVG, or the order block — the last down
// candle before the break). Stop below the sweep wick; target opposing
// liquidity from the stacked map. Mirror for a short.
//
// Distinct from structureTravel.ts, which trades continuation inside an
// established trend — this one is built to catch the turn itself.

import { randomUUID } from 'node:crypto';
import type { Candle, Side, Signal } from '../types.js';
import { findSwings } from './structure.js';
import { findFVGs } from './fvg.js';
import { analyzeCandle } from './candles.js';
import { buildMtfLiquidityMap, type MtfTf } from './mtfLiquidity.js';
import type { TravelSnapshot } from './structureTravel.js';

export interface ChochReversalOptions {
  swingLookback?: number; // fractal width
  patternWindowBars?: number; // sweep→CHoCH→retest must complete within this many bars
  sweepReclaimTolPct?: number; // how far past the swing the wick may poke, % of price
  zoneTolPct?: number; // how close price must be to the FVG/OB zone to count as a retest
  requireReaction?: boolean; // require a bullish/bearish reaction candle at the retest
  stopBufferPct?: number; // stop this far past the sweep extreme
  targetGuardStrength?: number; // MTF pool strength that qualifies as the target
  targetFallbackR?: number; // if no qualifying pool, target this many R
  targetMode?: 'near' | 'strong'; // 'near': first opposing pool; 'strong': first pool ≥ guard
  targetMaxR?: number; // cap the target at this many R (0 = uncapped)
  minStopPct?: number; // floor on stop distance, % of price
}

export interface ChochReversal {
  side: Side;
  sweptLevel: number; // the swing that was grabbed
  sweepExtreme: number; // the wick extreme of the grab (stop anchor)
  chochLevel: number; // the swing whose break confirmed the change of character
  zoneTop: number;
  zoneBottom: number;
  zoneKind: 'FVG' | 'OB';
}

/** Detect the sweep→CHoCH→retest sequence on the most recent bar. */
export function detectChochReversal(candles: Candle[], opts: ChochReversalOptions = {}): ChochReversal | null {
  const lb = opts.swingLookback ?? 2;
  const win = opts.patternWindowBars ?? 60;
  const tol = opts.sweepReclaimTolPct ?? 0.05;
  const zoneTol = opts.zoneTolPct ?? 0.1;

  if (candles.length < lb * 2 + 10) return null;

  const swings = findSwings(candles, lb);
  const last = candles.length - 1;
  const px = candles[last].close;

  for (const side of ['long', 'short'] as Side[]) {
    const grabbed = swings.filter((s) => s.kind === (side === 'long' ? 'low' : 'high'));
    for (let gi = grabbed.length - 1; gi >= 0; gi--) {
      const sw = grabbed[gi];
      if (last - sw.index > win || last - sw.index < lb + 2) continue;

      // Sweep + reclaim: a bar after the swing pokes past it, price is back the
      // right side now.
      const after = candles.slice(sw.index + 1);
      const pierce = side === 'long'
        ? after.find((c) => c.low < sw.price * (1 - tol / 100))
        : after.find((c) => c.high > sw.price * (1 + tol / 100));
      if (!pierce) continue;
      const reclaimed = side === 'long' ? px > sw.price : px < sw.price;
      if (!reclaimed) continue;
      const sweepExtreme = side === 'long'
        ? Math.min(...after.map((c) => c.low))
        : Math.max(...after.map((c) => c.high));

      // CHoCH: break the most recent opposing swing that printed after the grab.
      const opp = swings
        .filter((s) => s.kind === (side === 'long' ? 'high' : 'low') && s.index > sw.index && s.index < last)
        .at(-1);
      if (!opp) continue;
      const broke = side === 'long' ? px > opp.price : px < opp.price;
      if (!broke) continue;

      // Imbalance left by the CHoCH move: latest unmitigated FVG, else the OB
      // (last candle against the break direction before it fired).
      let zoneTop: number;
      let zoneBottom: number;
      let zoneKind: 'FVG' | 'OB';
      const fvg = findFVGs(candles.slice(sw.index)).filter((g) => g.side === side && !g.mitigated).at(-1);
      if (fvg) {
        zoneTop = fvg.top;
        zoneBottom = fvg.bottom;
        zoneKind = 'FVG';
      } else {
        const obIdx = lastOppositeCandle(candles, side, opp.index);
        if (obIdx < 0) continue;
        zoneTop = candles[obIdx].high;
        zoneBottom = candles[obIdx].low;
        zoneKind = 'OB';
      }

      // Retest: price is back at the zone right now.
      const inZone = px <= zoneTop * (1 + zoneTol / 100) && px >= zoneBottom * (1 - zoneTol / 100);
      if (!inZone) continue;

      if (opts.requireReaction) {
        const a = analyzeCandle(candles[last]);
        const reacts = side === 'long' ? a.bullish || a.rejection === 'bottom' : a.bearish || a.rejection === 'top';
        if (!reacts) continue;
      }

      return {
        side,
        sweptLevel: round(sw.price),
        sweepExtreme: round(sweepExtreme),
        chochLevel: round(opp.price),
        zoneTop: round(zoneTop),
        zoneBottom: round(zoneBottom),
        zoneKind,
      };
    }
  }
  return null;
}

/** Build the full trade Signal from a detected CHoCH reversal. */
export function generateChochReversalSignal(
  snap: TravelSnapshot,
  symbol: string,
  opts: ChochReversalOptions = {},
): Signal | null {
  const c = detectChochReversal(snap.m15, opts);
  if (!c) return null;

  const entry = snap.m15.at(-1)!.close;
  const buffer = entry * ((opts.stopBufferPct ?? 0.1) / 100);
  let stopDist = Math.abs(entry - c.sweepExtreme) + buffer;
  stopDist = Math.max(stopDist, entry * ((opts.minStopPct ?? 0.15) / 100));
  const stopLoss = c.side === 'long' ? entry - stopDist : entry + stopDist;

  const map = buildMtfLiquidityMap(mtfSeries(snap, opts.swingLookback ?? 2), entry);
  const stack = c.side === 'long' ? map.above : map.below;
  const guard = opts.targetGuardStrength ?? 4;
  const pool = (opts.targetMode ?? 'strong') === 'near' ? stack[0] : stack.find((p) => p.strength >= guard);
  const fallbackR = opts.targetFallbackR ?? 3;
  let takeProfit = pool
    ? pool.price
    : c.side === 'long'
    ? entry + stopDist * fallbackR
    : entry - stopDist * fallbackR;
  if (opts.targetMaxR && opts.targetMaxR > 0) {
    const cap = c.side === 'long' ? entry + stopDist * opts.targetMaxR : entry - stopDist * opts.targetMaxR;
    takeProfit = c.side === 'long' ? Math.min(takeProfit, cap) : Math.max(takeProfit, cap);
  }

  const risk = Math.abs(entry - stopLoss);
  const reward = Math.abs(takeProfit - entry);
  if (risk <= 0 || reward <= 0) return null;

  return {
    id: randomUUID(),
    time: Date.now(),
    symbol,
    side: c.side,
    entry: round(entry),
    stopLoss: round(stopLoss),
    takeProfit: round(takeProfit),
    riskReward: round(reward / risk, 2),
    confluence: 70 + (c.zoneKind === 'FVG' ? 10 : 0) + (pool ? 10 : 0),
    source: 'engine',
    reasons: [
      `SWEEP: grabbed ${c.side === 'long' ? 'SSL' : 'BSL'} @ ${c.sweptLevel.toFixed(2)} (wick ${c.sweepExtreme.toFixed(2)})`,
      `CHoCH: broke ${c.side === 'long' ? 'swing high' : 'swing low'} @ ${c.chochLevel.toFixed(2)}`,
      `RETEST: ${c.zoneKind} ${c.zoneBottom.toFixed(2)}–${c.zoneTop.toFixed(2)}`,
      `TARGET: ${pool ? `${pool.tfs.join('+')} pool` : `${opts.targetFallbackR ?? 3}R`} @ ${takeProfit.toFixed(2)}`,
    ],
    sweptLevel: round(c.sweptLevel),
    nearTarget: round(takeProfit),
    drawTarget: round(takeProfit),
    drawTimeframe: '15M',
  };
}

/** Index of the last candle opposite the break direction, at or before `beforeIdx`. */
function lastOppositeCandle(candles: Candle[], side: Side, beforeIdx: number): number {
  for (let i = Math.min(beforeIdx, candles.length - 1); i >= 0; i--) {
    const bearish = candles[i].close < candles[i].open;
    if (side === 'long' ? bearish : !bearish) return i;
  }
  return -1;
}

function mtfSeries(snap: TravelSnapshot, fractal: number): MtfTf[] {
  return [
    { label: '1D', weight: 5, candles: snap.d1, fractal: 2 },
    { label: '4H', weight: 3, candles: snap.h4, fractal: 2 },
    { label: '1H', weight: 2, candles: snap.h1, fractal },
    { label: '15M', weight: 1, candles: snap.m15, fractal },
  ];
}

function round(n: number, dp = 4): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
