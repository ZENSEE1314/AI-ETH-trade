// Parse inbound TradingView alert payloads into internal Signals.
//
// Configure a TradingView alert with webhook URL  https://<app>/webhook/tradingview
// and this JSON message body (Pine can build it with alert() calls):
// {
//   "secret": "<WEBHOOK_SECRET>",
//   "symbol": "ETHUSDT",
//   "side": "long",            // or "short"
//   "entry": {{close}},
//   "stopLoss": 3450.0,
//   "takeProfit": 3650.0,
//   "confluence": 70            // optional 0-100, defaults to MIN_CONFLUENCE
// }

import { randomUUID } from 'node:crypto';
import type { Signal, Side, Candle } from '../types.js';
import { config } from '../config.js';

export class WebhookError extends Error {}

function checkSecret(b: Record<string, unknown>): void {
  if (config.webhookSecret && b.secret !== config.webhookSecret) {
    throw new WebhookError('Invalid webhook secret.');
  }
}

/**
 * Parse a bar-close feed from TradingView into 1m Candles. Configure a
 * TradingView alert on "Once Per Bar Close" with this JSON message (Pine's
 * placeholders fill it in):
 * {
 *   "secret": "<WEBHOOK_SECRET>",
 *   "symbol": "ETHUSDT",
 *   "time": "{{time}}",        // ISO-8601 or unix epoch
 *   "open": {{open}}, "high": {{high}}, "low": {{low}}, "close": {{close}},
 *   "volume": {{volume}}
 * }
 * A batch (an array, or {bars:[…]}) is also accepted for backfills.
 */
export function parseTradingViewCandles(body: unknown): Candle[] {
  if (typeof body !== 'object' || body === null) throw new WebhookError('Body must be JSON.');
  const top = body as Record<string, unknown>;
  const list: unknown[] = Array.isArray(body)
    ? (body as unknown[])
    : Array.isArray(top.bars)
      ? (top.bars as unknown[])
      : [body];

  // Secret is checked on the envelope (batch) or on each bar (single object).
  if (!Array.isArray(body) && !Array.isArray(top.bars)) checkSecret(top);
  else if (Array.isArray(top.bars)) checkSecret(top);

  const out: Candle[] = [];
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue;
    const b = item as Record<string, unknown>;
    const time = parseTime(b.time ?? b.t ?? b.ts ?? b.timestamp);
    const open = Number(b.open ?? b.o);
    const high = Number(b.high ?? b.h);
    const low = Number(b.low ?? b.l);
    const close = Number(b.close ?? b.c);
    const volume = Number(b.volume ?? b.v ?? 0) || 0;
    if (![open, high, low, close, time].every(Number.isFinite)) {
      throw new WebhookError('Each bar needs finite time/open/high/low/close.');
    }
    out.push({ time, open, high, low, close, volume });
  }
  if (!out.length) throw new WebhookError('No bars in payload.');
  return out;
}

/** Time cell → epoch-ms. Accepts a unix number (s or ms) or an ISO string. */
function parseTime(raw: unknown): number {
  if (typeof raw === 'number') return raw < 1e12 ? raw * 1000 : raw;
  const s = String(raw ?? '').trim();
  if (!s) return NaN;
  const n = Number(s);
  if (Number.isFinite(n)) return n < 1e12 ? n * 1000 : n;
  const d = Date.parse(s);
  return Number.isFinite(d) ? d : NaN;
}

export function parseTradingViewAlert(body: unknown): Signal {
  if (typeof body !== 'object' || body === null) throw new WebhookError('Body must be JSON.');
  const b = body as Record<string, unknown>;

  if (config.webhookSecret && b.secret !== config.webhookSecret) {
    throw new WebhookError('Invalid webhook secret.');
  }

  const side = String(b.side ?? '').toLowerCase();
  if (side !== 'long' && side !== 'short') throw new WebhookError('side must be "long" or "short".');

  const entry = Number(b.entry);
  const stopLoss = Number(b.stopLoss ?? b.sl);
  const takeProfit = Number(b.takeProfit ?? b.tp);
  if (![entry, stopLoss, takeProfit].every(Number.isFinite)) {
    throw new WebhookError('entry, stopLoss and takeProfit must be numbers.');
  }

  const risk = Math.abs(entry - stopLoss);
  const reward = Math.abs(takeProfit - entry);
  const riskReward = risk > 0 ? round(reward / risk, 2) : 0;

  return {
    id: randomUUID(),
    time: Date.now(),
    symbol: String(b.symbol ?? config.symbol),
    side: side as Side,
    entry,
    stopLoss,
    takeProfit,
    riskReward,
    confluence: Number.isFinite(Number(b.confluence)) ? Number(b.confluence) : config.minConfluence,
    source: 'tradingview',
    reasons: [`TradingView alert${b.note ? `: ${String(b.note)}` : ''}`],
  };
}

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
