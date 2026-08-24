// Pull real 1-minute klines from Bybit v5 (public, no key) for backtesting.
//
// Bybit caps each request at 1000 candles and returns them newest-first, so we
// page backwards from `now` until we've covered `days`. Linear USDT perps by
// default (category=linear) — the same market the bot trades.
//
// Note: this uses Node's global fetch, which does NOT honor HTTPS_PROXY. In a
// locked-down egress environment the exchange host may be blocked; run this
// where api.bybit.com is reachable (e.g. locally) to collect the history, then
// replay the saved file anywhere with `npm run backtest -- <file>`.

import type { Candle } from '../types.js';

const BYBIT_BASE = 'https://api.bybit.com';
const MINUTE = 60_000;

export async function fetchBybitKlines(
  symbol: string,
  days: number,
  category: 'linear' | 'spot' | 'inverse' = 'linear',
): Promise<Candle[]> {
  const end = Date.now();
  const start = end - days * 24 * 60 * MINUTE;
  const bySts = new Map<number, Candle>();
  let cursorEnd = end;

  while (cursorEnd > start) {
    const url =
      `${BYBIT_BASE}/v5/market/kline?category=${category}` +
      `&symbol=${symbol}&interval=1&end=${cursorEnd}&limit=1000`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Bybit HTTP ${res.status} for ${symbol}`);
    const json: any = await res.json();
    if (json?.retCode !== 0) throw new Error(`Bybit retCode ${json?.retCode}: ${json?.retMsg}`);
    const list: any[] = json?.result?.list ?? [];
    if (list.length === 0) break;

    // Each row: [startMs, open, high, low, close, volume, turnover], newest-first.
    for (const r of list) {
      const t = Number(r[0]);
      if (!Number.isFinite(t)) continue;
      bySts.set(t, {
        time: t,
        open: +r[1],
        high: +r[2],
        low: +r[3],
        close: +r[4],
        volume: +r[5] || 0,
      });
    }
    const oldest = Number(list[list.length - 1][0]);
    if (!Number.isFinite(oldest) || oldest <= start) break;
    cursorEnd = oldest - MINUTE; // step just past the oldest bar we got
    if (list.length < 1000) break; // no more history available
  }

  return [...bySts.values()].filter((c) => c.time >= start).sort((a, b) => a.time - b.time);
}
