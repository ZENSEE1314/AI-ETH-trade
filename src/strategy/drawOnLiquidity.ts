// Draw on Liquidity (DOL) — the 4H high-timeframe read.
//
// The idea (see the ETH example this was built from): on the 4H, price wicks
// below a resting pool of sell-side liquidity (old lows / equal lows), reclaims
// it, and there is still a resting pool of buy-side liquidity overhead (an old
// high the market hasn't tapped). That combination — sweep on one side, unfilled
// liquidity on the other — is the day's high-probability direction. The sweep
// picks the side; the opposing pool is where price is *drawn*, i.e. the target.
//
// Lower timeframes rarely show both halves in one window, which is exactly why
// the read lives on the 4H: sweep behind us, draw ahead of us.

import type { Candle, DrawOnLiquidity } from '../types.js';
import { findSwings } from './structure.js';
import { equalLevels } from './liquidity.js';

/**
 * Detect a 4H sweep-and-reclaim with an opposing draw on liquidity.
 *
 * Bullish: a prior swing low was breached (wick below it) and price has since
 * closed back above it, while a prior swing high still rests overhead as the
 * draw. Bearish is the mirror. Returns the strongest of the two, or null when
 * neither a clean sweep nor a real draw target exists.
 */
export function detectDrawOnLiquidity(h4: Candle[], lookback = 40): DrawOnLiquidity | null {
  if (h4.length < 12) return null;
  const window = h4.slice(-lookback);
  const swings = findSwings(window, 2);
  const highs = swings.filter((s) => s.kind === 'high');
  const lows = swings.filter((s) => s.kind === 'low');
  // Need at least one pivot to reason about a sweep; the opposing draw can fall
  // back to the window extreme / equal levels, so we don't require both sides.
  if (swings.length === 0) return null;

  const price = window.at(-1)!.close;
  const extremeLow = Math.min(...window.map((c) => c.low));
  const extremeHigh = Math.max(...window.map((c) => c.high));
  const { highs: equalHighs, lows: equalLows } = equalLevels(window);

  const long = evaluateBullish(window, lows, highs, equalHighs, price, extremeLow, extremeHigh);
  const short = evaluateBearish(window, highs, lows, equalLows, price, extremeHigh, extremeLow);

  // Prefer the read whose draw offers more room (bigger unfilled pool ahead).
  if (long && short) {
    const longRoom = long.drawTarget - price;
    const shortRoom = price - short.drawTarget;
    return longRoom >= shortRoom ? long : short;
  }
  return long ?? short ?? null;
}

function evaluateBullish(
  window: Candle[],
  lows: ReturnType<typeof findSwings>,
  highs: ReturnType<typeof findSwings>,
  equalHighs: number[],
  price: number,
  extremeLow: number,
  extremeHigh: number,
): DrawOnLiquidity | null {
  // Most recent swing low that a later candle pierced but price has reclaimed.
  let sweptLevel: number | null = null;
  for (let k = lows.length - 1; k >= 0; k--) {
    const sl = lows[k];
    const pierced = window.slice(sl.index + 1).some((c) => c.low < sl.price);
    if (pierced && price > sl.price) {
      sweptLevel = sl.price;
      break;
    }
  }
  if (sweptLevel == null) return null;

  // Draw = the furthest resting buy-side liquidity overhead we haven't tapped.
  const overhead = [
    ...highs.map((s) => s.price),
    ...equalHighs,
    extremeHigh,
  ].filter((v) => v > price);
  if (overhead.length === 0) return null;
  const drawTarget = Math.max(...overhead); // the full draw (furthest pool)
  const nearTarget = Math.min(...overhead); // nearest resting pool (first TP)
  if (drawTarget <= price) return null;

  return {
    side: 'long',
    sweptLevel,
    sweepExtreme: extremeLow,
    drawTarget,
    nearTarget,
    reasons: [
      `4H swept sell-side @ ${sweptLevel.toFixed(2)} (wick to ${extremeLow.toFixed(2)}) and reclaimed`,
      `Draw: buy-side resting @ ${nearTarget.toFixed(2)} (near) → ${drawTarget.toFixed(2)} (full) overhead`,
    ],
  };
}

function evaluateBearish(
  window: Candle[],
  highs: ReturnType<typeof findSwings>,
  lows: ReturnType<typeof findSwings>,
  equalLows: number[],
  price: number,
  extremeHigh: number,
  extremeLow: number,
): DrawOnLiquidity | null {
  let sweptLevel: number | null = null;
  for (let k = highs.length - 1; k >= 0; k--) {
    const sh = highs[k];
    const pierced = window.slice(sh.index + 1).some((c) => c.high > sh.price);
    if (pierced && price < sh.price) {
      sweptLevel = sh.price;
      break;
    }
  }
  if (sweptLevel == null) return null;

  const below = [
    ...lows.map((s) => s.price),
    ...equalLows,
    extremeLow,
  ].filter((v) => v < price);
  if (below.length === 0) return null;
  const drawTarget = Math.min(...below); // the full draw (furthest pool)
  const nearTarget = Math.max(...below); // nearest resting pool (first TP)
  if (drawTarget >= price) return null;

  return {
    side: 'short',
    sweptLevel,
    sweepExtreme: extremeHigh,
    drawTarget,
    nearTarget,
    reasons: [
      `4H swept buy-side @ ${sweptLevel.toFixed(2)} (wick to ${extremeHigh.toFixed(2)}) and rejected`,
      `Draw: sell-side resting @ ${nearTarget.toFixed(2)} (near) → ${drawTarget.toFixed(2)} (full) below`,
    ],
  };
}
