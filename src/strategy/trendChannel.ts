// The trend channel — the red/green range envelope you read direction off.
//
// A linear-regression channel over the recent window: the regression line is the
// mid, its slope is the trend (line sloping top→bottom = down), and the channel
// walls are the mid ± a multiple of the residual spread. That gives both a
// direction filter (only trade with the slope) and dynamic targets (the band the
// trend is travelling toward), instead of a single fixed far level.

import type { Candle } from '../types.js';

export interface TrendChannel {
  direction: 'up' | 'down' | 'flat';
  slope: number; // regression slope, price per bar
  slopePct: number; // slope as % of price per bar
  mid: number; // regression value at the last bar
  upper: number; // mid + width
  lower: number; // mid - width
  width: number; // half-channel width (mult × residual std)
  price: number;
}

/**
 * Fit y = a + b·x over the last `length` closes. `mult` sets the wall distance
 * from the mid in residual-std units. Direction is 'flat' when the net drift
 * across the window is small relative to the channel width (slope lost in noise).
 */
export function readTrendChannel(candles: Candle[], length = 50, mult = 2): TrendChannel | null {
  const w = candles.slice(-length);
  const n = w.length;
  if (n < Math.min(20, length)) return null;

  const closes = w.map((c) => c.close);
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sx += i;
    sy += closes[i];
    sxx += i * i;
    sxy += i * closes[i];
  }
  const denom = n * sxx - sx * sx || 1e-9;
  const b = (n * sxy - sx * sy) / denom; // slope
  const a = (sy - b * sx) / n; // intercept

  let ss = 0;
  for (let i = 0; i < n; i++) {
    const yhat = a + b * i;
    ss += (closes[i] - yhat) ** 2;
  }
  const std = Math.sqrt(ss / n);
  const width = std * mult;
  const mid = a + b * (n - 1);
  const price = closes[n - 1];

  const netMove = b * (n - 1); // total drift the line covers across the window
  const direction: TrendChannel['direction'] =
    Math.abs(netMove) < 0.5 * (width || 1e-9) ? 'flat' : b > 0 ? 'up' : 'down';

  return {
    direction,
    slope: b,
    slopePct: (b / price) * 100,
    mid: round(mid),
    upper: round(mid + width),
    lower: round(mid - width),
    width: round(width),
    price: round(price),
  };
}

function round(n: number, dp = 4): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
