// Fetches the multi-timeframe snapshot the strategy needs, from Bitunix klines.
// 4H → bias, 1H → confirmation, 15M → setup, 1M → entry.

import type { MarketSnapshot } from '../strategy/signal.js';
import { fetchKlines } from '../exchange/bitunix.js';

export async function loadSnapshot(symbol: string): Promise<MarketSnapshot> {
  // 1H and 1M pull 250+ so the EMA 200 confirmation has enough history on both.
  const [h4, h1, m15, m1] = await Promise.all([
    fetchKlines(symbol, '4h', 120),
    fetchKlines(symbol, '1h', 250),
    fetchKlines(symbol, '15m', 200),
    fetchKlines(symbol, '1m', 250),
  ]);
  return { symbol, h4, h1, m15, m1 };
}

export function lastPrice(snap: MarketSnapshot): number {
  const series = snap.m1.length ? snap.m1 : snap.m15.length ? snap.m15 : snap.h1;
  return series.at(-1)?.close ?? 0;
}
