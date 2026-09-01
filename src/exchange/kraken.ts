// Kraken public OHLC — a data source that (unlike Binance/Bybit/Bitunix) is
// generally reachable from datacenter IPs, so the bot keeps running on Railway
// even when the perp venues geo-block the host. No key, spot prices.
//
//   https://api.kraken.com/0/public/OHLC?pair=ETHUSD&interval=1

import type { Candle } from '../types.js';

// Map our USDT perp symbols to Kraken spot pairs (Kraken uses USD, close enough
// for structure/entry analysis; execution still happens on the real venue).
const PAIR: Record<string, string> = {
  ETHUSDT: 'ETHUSD',
  BTCUSDT: 'XBTUSD',
  SOLUSDT: 'SOLUSD',
  BNBUSDT: 'BNBUSD', // not listed on Kraken — will 404, caller falls through
};

/** Fetch up to 720 recent 1m candles for `symbol` from Kraken. */
export async function fetchKrakenKlines(symbol: string): Promise<Candle[]> {
  const pair = PAIR[symbol] ?? symbol.replace('USDT', 'USD');
  const res = await fetch(`https://api.kraken.com/0/public/OHLC?pair=${pair}&interval=1`, {
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Kraken OHLC HTTP ${res.status}`);
  const json = (await res.json()) as { error?: string[]; result?: Record<string, unknown> };
  if (json.error?.length) throw new Error(`Kraken: ${json.error.join(', ')}`);

  const key = Object.keys(json.result ?? {}).find((k) => k !== 'last');
  const rows = (key && (json.result as Record<string, unknown>)[key]) as unknown[] | undefined;
  if (!Array.isArray(rows)) throw new Error('Kraken: no OHLC rows');

  // Each row: [time, open, high, low, close, vwap, volume, count]
  return rows.map((r) => {
    const a = r as (string | number)[];
    return {
      time: Number(a[0]) * 1000,
      open: +a[1],
      high: +a[2],
      low: +a[3],
      close: +a[4],
      volume: +a[6] || 0,
    };
  });
}
