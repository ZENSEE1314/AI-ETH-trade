// The hourly liquidity map — "the liq of all hours".
//
// Scans the 1H swings across the whole window, clusters the near-equal ones into
// resting liquidity pools, and hands back the NEAREST pool above and below the
// current price. That is how the setup is read: sell-side liquidity rests below
// (price is likely to sweep it, then you BUY the reversal); buy-side liquidity
// rests above (sweep, then you SELL / it's the long target). The nearest pool on
// each side is the level to watch right now.

import type { Candle, Side } from '../types.js';
import { findSwings } from './structure.js';

export interface LiquidityPool {
  price: number;
  side: 'buy-side' | 'sell-side'; // buy-side = resting highs (above); sell-side = resting lows (below)
  touches: number; // how many swings stacked here (equal highs/lows = stronger pool)
  distancePct: number; // distance from current price, %
}

export interface LiquidityMap {
  price: number;
  buySide: LiquidityPool[]; // pools above price, nearest first (sweep → sell / long target)
  sellSide: LiquidityPool[]; // pools below price, nearest first (sweep → buy / short target)
  nearestSell: LiquidityPool | null; // nearest buy-side above — where you'd sell / take longs off
  nearestBuy: LiquidityPool | null; // nearest sell-side below — where you'd buy / take shorts off
}

/**
 * Build the map from `candles` (use the 1H series for the hourly read).
 * `tolPct` groups swings within that % into one pool; `lookback` bounds how far
 * back the "all hours" scan reaches.
 */
export function buildLiquidityMap(candles: Candle[], lookback = 500, tolPct = 0.1): LiquidityMap {
  const window = candles.slice(-lookback);
  const price = window.at(-1)?.close ?? 0;
  if (window.length < 10 || price <= 0) {
    return { price, buySide: [], sellSide: [], nearestSell: null, nearestBuy: null };
  }

  const swings = findSwings(window, 3); // slightly wider fractal for hourly pools
  const highs = swings.filter((s) => s.kind === 'high').map((s) => s.price);
  const lows = swings.filter((s) => s.kind === 'low').map((s) => s.price);

  const withMeta = (price0: number, side: LiquidityPool['side'], touches: number): LiquidityPool => ({
    price: round(price0, 2),
    side,
    touches,
    distancePct: round((Math.abs(price0 - price) / price) * 100, 3),
  });

  const buySide = cluster(highs, tolPct)
    .map((p) => withMeta(p.price, 'buy-side', p.touches))
    .filter((p) => p.price > price)
    .sort((a, b) => a.price - b.price); // nearest above first

  const sellSide = cluster(lows, tolPct)
    .map((p) => withMeta(p.price, 'sell-side', p.touches))
    .filter((p) => p.price < price)
    .sort((a, b) => b.price - a.price); // nearest below first

  return {
    price: round(price, 2),
    buySide,
    sellSide,
    nearestSell: buySide[0] ?? null,
    nearestBuy: sellSide[0] ?? null,
  };
}

export interface LiquiditySweepCheck {
  ok: boolean;
  pool: LiquidityPool | null;
  reason: string;
}

/**
 * The manual read as a gate: only take the trade when price is sitting right at
 * the nearest opposing pool AND has just swept it. For a long that's the nearest
 * sell-side pool below (`nearestBuy`) — a recent bar must have pierced it (low ≤
 * pool) while price has since reclaimed above it, and current price must be
 * within `proximityPct` of the pool. Short mirrors on the nearest buy-side above.
 *
 * `recent` bounds how many of the latest 1H bars count as "just swept".
 */
export function liquiditySweepConfirms(
  candles: Candle[],
  side: Side,
  price: number,
  proximityPct: number,
  recent = 40,
): LiquiditySweepCheck {
  const map = buildLiquidityMap(candles);
  const pool = side === 'long' ? map.nearestBuy : map.nearestSell; // opposing pool we sweep
  if (!pool || price <= 0) {
    return { ok: false, pool: null, reason: 'LIQ-GATE: no opposing pool to sweep' };
  }

  const distPct = (Math.abs(price - pool.price) / price) * 100;
  const near = distPct <= proximityPct;

  const tail = candles.slice(-recent);
  const swept =
    side === 'long'
      ? tail.some((c) => c.low <= pool.price) && price > pool.price // dipped into it, back above
      : tail.some((c) => c.high >= pool.price) && price < pool.price; // spiked into it, back below

  const ok = near && swept;
  const poolName = side === 'long' ? 'sell-side' : 'buy-side';
  const reason = ok
    ? `LIQ-GATE: swept ${poolName} @ ${pool.price.toFixed(2)} (${distPct.toFixed(2)}% away, ×${pool.touches})`
    : `LIQ-GATE: no fresh sweep of ${poolName} @ ${pool.price.toFixed(2)} (${distPct.toFixed(2)}% away, near=${near}, swept=${swept})`;
  return { ok, pool, reason };
}

/** Group sorted values within `tolPct` into pools; touches = swings in the group. */
function cluster(values: number[], tolPct: number): Array<{ price: number; touches: number }> {
  const sorted = [...values].sort((a, b) => a - b);
  const out: Array<{ price: number; touches: number }> = [];
  let i = 0;
  while (i < sorted.length) {
    let j = i + 1;
    while (j < sorted.length && ((sorted[j] - sorted[i]) / sorted[i]) * 100 <= tolPct) j++;
    const group = sorted.slice(i, j);
    const mean = group.reduce((s, v) => s + v, 0) / group.length;
    out.push({ price: mean, touches: group.length });
    i = j;
  }
  return out;
}

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
