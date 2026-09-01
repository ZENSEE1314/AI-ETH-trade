// Bitunix Futures connector.
// - Public market data (klines) needs no auth and powers self-analysis.
// - Private order placement is guarded behind canTradeLive and is intentionally
//   conservative. VERIFY against your account with tiny size before trusting it;
//   this cannot be end-to-end tested without live credentials and real funds.

import { createHash, randomUUID } from 'node:crypto';
import type { Candle, Side } from '../types.js';
import { runtime } from '../runtime.js';
import { logger } from '../logger.js';

const BASE_URL = 'https://fapi.bitunix.com';

// Bitunix can be egress-blocked from some datacenters and then the socket hangs
// open with no response. Without this cap loadSnapshot's Promise.all never
// settles and the whole analysis loop stalls silently.
const MARKET_FETCH_TIMEOUT_MS = 8000;

/** Map our timeframe labels to Bitunix interval strings. */
export type Interval = '1m' | '15m' | '1h' | '4h' | '1d';

export async function fetchKlines(symbol: string, interval: Interval, limit = 200): Promise<Candle[]> {
  const url = `${BASE_URL}/api/v1/futures/market/kline?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(MARKET_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Bitunix klines ${interval} HTTP ${res.status}`);
  const json: any = await res.json();
  const rows: any[] = json?.data ?? [];
  const candles: Candle[] = rows.map((r) => normalizeKline(r)).filter((c): c is Candle => c !== null);
  candles.sort((a, b) => a.time - b.time);
  return candles;
}

function normalizeKline(r: any): Candle | null {
  // Bitunix may return arrays or objects depending on endpoint version.
  if (Array.isArray(r)) {
    const [time, open, high, low, close, volume] = r;
    return num6(time, open, high, low, close, volume);
  }
  const time = r.time ?? r.ts ?? r.t;
  return num6(time, r.open ?? r.o, r.high ?? r.h, r.low ?? r.l, r.close ?? r.c, r.baseVol ?? r.volume ?? r.v);
}

function num6(time: any, o: any, h: any, l: any, c: any, v: any): Candle | null {
  const t = Number(time);
  const open = Number(o);
  const high = Number(h);
  const low = Number(l);
  const close = Number(c);
  const volume = Number(v) || 0;
  if (![t, open, high, low, close].every(Number.isFinite)) return null;
  return { time: t < 1e12 ? t * 1000 : t, open, high, low, close, volume };
}

// --- Private (signed) requests --------------------------------------------

function sign(nonce: string, timestamp: string, queryString: string, body: string): string {
  // Bitunix double-hash scheme: digest = sha256(nonce+ts+apiKey+query+body),
  // sign = sha256(digest + secret).
  const digest = createHash('sha256')
    .update(nonce + timestamp + runtime.apiKey + queryString + body)
    .digest('hex');
  return createHash('sha256').update(digest + runtime.apiSecret).digest('hex');
}

async function signedPost(path: string, payload: Record<string, unknown>): Promise<any> {
  const nonce = randomUUID().replace(/-/g, '');
  const timestamp = Date.now().toString();
  const body = JSON.stringify(payload);
  const signature = sign(nonce, timestamp, '', body);
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'api-key': runtime.apiKey,
      nonce,
      timestamp,
      sign: signature,
      language: 'en-US',
      'Content-Type': 'application/json',
    },
    body,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Bitunix ${path} HTTP ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

export interface LiveOrderRequest {
  symbol: string;
  side: Side;
  qty: number;
  entry: number;
  stopLoss: number;
  takeProfit: number;
}

/** Place a live market order with attached SL/TP. Guarded by the caller. */
export async function placeLiveOrder(req: LiveOrderRequest): Promise<{ orderId: string }> {
  logger.warn(`LIVE ORDER submitting: ${req.side} ${req.qty} ${req.symbol} @~${req.entry}`);
  const json = await signedPost('/api/v1/futures/trade/place_order', {
    symbol: req.symbol,
    side: req.side === 'long' ? 'BUY' : 'SELL',
    tradeSide: 'OPEN',
    orderType: 'MARKET',
    qty: String(req.qty),
    tpPrice: String(req.takeProfit),
    slPrice: String(req.stopLoss),
    leverage: String(runtime.leverage),
  });
  const orderId = json?.data?.orderId ?? json?.orderId ?? 'unknown';
  logger.trade(`LIVE ORDER accepted id=${orderId}`);
  return { orderId: String(orderId) };
}
