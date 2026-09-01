// Multi-timeframe liquidity map — "the liq of all hours", not just the 1H.
//
// Stacks swing highs/lows from the 1D, 4H, 1H, 15M and 1M series into one set of
// price pools. A pool that several timeframes agree on (a 4H high sitting on a
// 1D high) is a stronger magnet / harder wall than a lone 15M swing. The travel
// strategy reads this to decide the target: the opposing 15M line if it is
// defended by higher-timeframe liquidity, or the next pool beyond it when the
// line is thin and price is likely to run straight through to the real level.

import type { Candle } from '../types.js';
import { findSwings } from './structure.js';

export interface MtfTf {
  label: string; // '1D' | '4H' | '1H' | '15M' | '1M'
  weight: number; // how much a swing on this TF adds to a pool's strength
  candles: Candle[];
  fractal: number; // swing fractal width for this TF
}

export interface MtfPool {
  price: number;
  side: 'above' | 'below'; // relative to the reference price
  strength: number; // Σ weights of the swings clustered here
  tfs: string[]; // which timeframes contributed (deduped)
  distancePct: number;
}

export interface MtfLiquidityMap {
  price: number;
  above: MtfPool[]; // nearest first
  below: MtfPool[]; // nearest first
}

/**
 * Build the stacked map. `tolPct` groups swings within that % into one pool.
 * `roundStep` (>0) also injects psychological round-number levels within ±3%
 * of price as pools of weight `roundWeight` — the SMC "psychological level" idea
 * (0.700, 1700, 145…) where the crowd clusters orders and stops.
 */
export function buildMtfLiquidityMap(
  tfs: MtfTf[],
  price: number,
  tolPct = 0.15,
  roundStep = 0,
  roundWeight = 1.5,
): MtfLiquidityMap {
  if (price <= 0) return { price, above: [], below: [] };

  type Raw = { price: number; kind: 'high' | 'low'; weight: number; tf: string };
  const raw: Raw[] = [];
  for (const tf of tfs) {
    if (tf.candles.length < tf.fractal * 2 + 2) continue;
    for (const s of findSwings(tf.candles, tf.fractal)) {
      raw.push({ price: s.price, kind: s.kind, weight: tf.weight, tf: tf.label });
    }
  }
  if (roundStep > 0) {
    const lo = Math.ceil((price * 0.97) / roundStep) * roundStep;
    const hi = Math.floor((price * 1.03) / roundStep) * roundStep;
    for (let lvl = lo; lvl <= hi; lvl += roundStep) {
      raw.push({ price: lvl, kind: lvl >= price ? 'high' : 'low', weight: roundWeight, tf: 'RND' });
    }
  }
  if (!raw.length) return { price, above: [], below: [] };

  raw.sort((a, b) => a.price - b.price);
  const pools: MtfPool[] = [];
  let i = 0;
  while (i < raw.length) {
    let j = i + 1;
    while (j < raw.length && ((raw[j].price - raw[i].price) / raw[i].price) * 100 <= tolPct) j++;
    const group = raw.slice(i, j);
    const wSum = group.reduce((s, g) => s + g.weight, 0);
    const wPrice = group.reduce((s, g) => s + g.price * g.weight, 0) / wSum;
    pools.push({
      price: round(wPrice),
      side: wPrice >= price ? 'above' : 'below',
      strength: round(wSum, 2),
      tfs: [...new Set(group.map((g) => g.tf))],
      distancePct: round((Math.abs(wPrice - price) / price) * 100, 3),
    });
    i = j;
  }

  return {
    price: round(price),
    above: pools.filter((p) => p.price > price).sort((a, b) => a.price - b.price),
    below: pools.filter((p) => p.price < price).sort((a, b) => b.price - a.price),
  };
}

/**
 * Pick the trade target from the stacked map given the opposing 15M line.
 *
 *  - If a strong pool (strength ≥ `guardStrength`) sits at/just before the line,
 *    the line is defended → target the line, it will likely reject.
 *  - Otherwise, if a strong pool sits within `reachPct` beyond the line, price
 *    tends to run straight through the thin line to it → target that pool.
 *  - Failing both, target the line.
 */
export function pickTravelTarget(
  map: MtfLiquidityMap,
  side: 'long' | 'short',
  line: number,
  opts: { guardStrength?: number; reachPct?: number } = {},
): { price: number; reason: string } {
  const guard = opts.guardStrength ?? 4;
  const reachPct = opts.reachPct ?? 0.6;
  const stack = side === 'long' ? map.above : map.below;

  const beyondLine = (p: MtfPool) => (side === 'long' ? p.price > line : p.price < line);
  const nearLine = (p: MtfPool) => (Math.abs(p.price - line) / line) * 100 <= 0.15;

  const defender = stack.find((p) => nearLine(p) && p.strength >= guard);
  if (defender) return { price: line, reason: `line defended by ${defender.tfs.join('+')} (str ${defender.strength})` };

  const runner = stack.find(
    (p) => beyondLine(p) && !nearLine(p) && p.strength >= guard && p.distancePct - (Math.abs(line - map.price) / map.price) * 100 <= reachPct,
  );
  if (runner) return { price: runner.price, reason: `thin line → run to ${runner.tfs.join('+')} @ ${runner.price} (str ${runner.strength})` };

  return { price: line, reason: 'no stronger pool in reach — target the line' };
}

function round(n: number, dp = 4): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
