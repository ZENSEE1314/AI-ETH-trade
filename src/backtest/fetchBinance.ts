// Pull real 1-minute klines from Binance's public market-data mirror
// (data-api.binance.vision — no key, no auth) for backtesting.
//
// Binance caps each request at 1000 candles and returns them oldest-first, so
// we page forward from `start` until we reach `end`. Spot market by default;
// pass 'futures' for USDT-M perp klines from the same mirror's futures path.

import type { Candle } from '../types.js';

const SPOT_BASE = 'https://data-api.binance.vision';
const FUTURES_BASE = 'https://fapi.binance.com'; // futures has no public vision mirror
const MINUTE = 60_000;

export async function fetchBinanceKlines(
  symbol: string,
  days: number,
  market: 'spot' | 'futures' = 'spot',
): Promise<Candle[]> {
  const end = Date.now();
  const start = end - days * 24 * 60 * MINUTE;
  const base = market === 'spot' ? SPOT_BASE : FUTURES_BASE;
  const path = market === 'spot' ? '/api/v3/klines' : '/fapi/v1/klines';
  const byTime = new Map<number, Candle>();
  let cursorStart = start;

  while (cursorStart < end) {
    const url = `${base}${path}?symbol=${symbol}&interval=1m&startTime=${cursorStart}&limit=1000`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Binance HTTP ${res.status} for ${symbol}`);
    const list: any[] = await res.json();
    if (!Array.isArray(list) || list.length === 0) break;

    // Each row: [openTime, open, high, low, close, volume, closeTime, ...], oldest-first.
    for (const r of list) {
      const t = Number(r[0]);
      if (!Number.isFinite(t)) continue;
      byTime.set(t, {
        time: t,
        open: +r[1],
        high: +r[2],
        low: +r[3],
        close: +r[4],
        volume: +r[5] || 0,
      });
    }
    const newest = Number(list[list.length - 1][0]);
    if (!Number.isFinite(newest) || newest <= cursorStart) break;
    cursorStart = newest + MINUTE; // step just past the newest bar we got
    if (list.length < 1000) break; // caught up to the present
  }

  return [...byTime.values()].filter((c) => c.time >= start && c.time <= end).sort((a, b) => a.time - b.time);
}
