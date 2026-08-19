// Resample 1-minute candles into higher timeframes for the backtester.
// Buckets are aligned to UTC epoch (floor(time / bucketMs)), so a slice of the
// 1m history up to time t yields exactly the higher-TF candles known at t.

import type { Candle } from '../types.js';

/** Aggregate 1m candles into `minutes`-sized buckets (open=first, close=last). */
export function resample(m1: Candle[], minutes: number): Candle[] {
  const size = minutes * 60_000;
  const out: Candle[] = [];
  let cur: Candle | null = null;
  let bucket = -1;
  for (const c of m1) {
    const b = Math.floor(c.time / size);
    if (b !== bucket) {
      if (cur) out.push(cur);
      cur = { time: b * size, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume };
      bucket = b;
    } else if (cur) {
      cur.high = Math.max(cur.high, c.high);
      cur.low = Math.min(cur.low, c.low);
      cur.close = c.close;
      cur.volume += c.volume;
    }
  }
  if (cur) out.push(cur);
  return out;
}
