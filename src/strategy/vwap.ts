// VWAP with standard-deviation bands, plus mean-reversion / trend / reclaim reads.

import type { Candle, VwapState } from '../types.js';

/**
 * Session VWAP over the provided candles (typically the current UTC day) with
 * volume-weighted standard-deviation bands at `mult` sigma.
 */
export function computeVwap(candles: Candle[], mult = 2): VwapState {
  if (candles.length === 0) return { vwap: 0, upper: 0, lower: 0 };

  let cumPV = 0;
  let cumV = 0;
  for (const c of candles) {
    const typical = (c.high + c.low + c.close) / 3;
    cumPV += typical * c.volume;
    cumV += c.volume;
  }
  const vwap = cumV > 0 ? cumPV / cumV : candles.at(-1)!.close;

  let cumVar = 0;
  for (const c of candles) {
    const typical = (c.high + c.low + c.close) / 3;
    cumVar += c.volume * (typical - vwap) ** 2;
  }
  const sd = cumV > 0 ? Math.sqrt(cumVar / cumV) : 0;

  return { vwap, upper: vwap + mult * sd, lower: vwap - mult * sd };
}

/** Restrict candles to the current UTC day so VWAP resets daily. */
export function todaysCandles(candles: Candle[]): Candle[] {
  if (candles.length === 0) return [];
  const DAY_MS = 24 * 60 * 60 * 1000;
  const day = Math.floor(candles.at(-1)!.time / DAY_MS);
  return candles.filter((c) => Math.floor(c.time / DAY_MS) === day);
}

export interface VwapRead {
  state: VwapState;
  position: 'above' | 'below' | 'at';
  signal: 'mean-reversion-long' | 'mean-reversion-short' | 'trend-long' | 'trend-short' | 'reclaim-long' | 'reclaim-short' | 'neutral';
}

export function readVwap(candles: Candle[]): VwapRead {
  const session = todaysCandles(candles);
  const state = computeVwap(session);
  const price = candles.at(-1)!.close;
  const prev = candles.at(-2)?.close ?? price;

  let position: VwapRead['position'] = 'at';
  if (price > state.vwap) position = 'above';
  else if (price < state.vwap) position = 'below';

  let signal: VwapRead['signal'] = 'neutral';
  // Reclaim: crossed back over VWAP this candle.
  if (prev < state.vwap && price > state.vwap) signal = 'reclaim-long';
  else if (prev > state.vwap && price < state.vwap) signal = 'reclaim-short';
  // Band tags = stretched -> mean reversion back to VWAP.
  else if (price <= state.lower) signal = 'mean-reversion-long';
  else if (price >= state.upper) signal = 'mean-reversion-short';
  // Holding one side = trend continuation.
  else if (position === 'above') signal = 'trend-long';
  else if (position === 'below') signal = 'trend-short';

  return { state, position, signal };
}
