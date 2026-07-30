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
import type { Signal, Side } from '../types.js';
import { config } from '../config.js';

export class WebhookError extends Error {}

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
