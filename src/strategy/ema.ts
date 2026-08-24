// EMA (exponential moving average) — the trend/dynamic-S&R filter.
//
// The trade history reads as post-sweep reversals that only run when the higher
// timeframe agrees on direction. The EMA 200 is the classic line for that: it
// separates "with trend" from "counter trend" and often acts as the dynamic
// level price reclaims before continuing. We read it on the 1H (bias) and again
// on the 1M (entry) so an entry is only taken when the fast and slow frames sit
// on the same side of their EMA 200 — the manual "1H → 1M all confirm" check.

import type { Candle, Side } from '../types.js';

/** Exponential moving average of a value series. Returns the final EMA value. */
export function ema(values: number[], period: number): number | null {
  if (values.length === 0 || period <= 0) return null;
  const k = 2 / (period + 1);
  // Seed with the SMA of the first `period` (or all, if fewer) values.
  const seedLen = Math.min(period, values.length);
  let e = values.slice(0, seedLen).reduce((s, v) => s + v, 0) / seedLen;
  for (let i = seedLen; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

export interface EmaRead {
  value: number | null;
  side: 'above' | 'below' | 'at' | 'unknown'; // where price sits vs the EMA
  slope: 'up' | 'down' | 'flat'; // recent EMA direction
  reclaim: 'long' | 'short' | null; // price crossed back over the EMA this candle
}

/**
 * Read price vs its EMA(period) on one timeframe: which side, which way the EMA
 * is sloping, and whether the last candle reclaimed the line.
 */
export function readEma(candles: Candle[], period = 200): EmaRead {
  if (candles.length < 2) return { value: null, side: 'unknown', slope: 'flat', reclaim: null };
  const closes = candles.map((c) => c.close);
  const value = ema(closes, period);
  if (value == null) return { value: null, side: 'unknown', slope: 'flat', reclaim: null };

  const price = closes.at(-1)!;
  const prev = closes.at(-2)!;
  const side: EmaRead['side'] = price > value ? 'above' : price < value ? 'below' : 'at';

  // Slope from the EMA a few candles back (guards against noise).
  const back = Math.min(5, candles.length - 1);
  const prevEma = ema(closes.slice(0, closes.length - back), period);
  let slope: EmaRead['slope'] = 'flat';
  if (prevEma != null) {
    const drift = (value - prevEma) / (Math.abs(prevEma) || 1);
    if (drift > 0.0002) slope = 'up';
    else if (drift < -0.0002) slope = 'down';
  }

  let reclaim: EmaRead['reclaim'] = null;
  if (prev < value && price > value) reclaim = 'long';
  else if (prev > value && price < value) reclaim = 'short';

  return { value, side, slope, reclaim };
}

/** True when this timeframe's EMA read supports taking `side` (or is at least not against it). */
export function emaSupports(read: EmaRead, side: Side): boolean {
  if (read.value == null) return true; // no data → don't block
  if (side === 'long') return read.side !== 'below' || read.reclaim === 'long';
  return read.side !== 'above' || read.reclaim === 'short';
}
