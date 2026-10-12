// Kronos forecast filter — optional confirmation for NW-flip breakouts.
//
// When KRONOS_URL points at the kronos-service, the engine asks it to forecast
// the next few bars before taking a breakout, and only enters when the forecast
// agrees with the breakout direction. It FAILS OPEN: any timeout, HTTP error, or
// exception returns "allow" so a flaky model service never stalls the bot — only
// a clean "disagree" verdict blocks a trade.

import type { Candle, Side } from '../types.js';
import { logger } from '../logger.js';

const KRONOS_URL = process.env.KRONOS_URL ?? '';
const TIMEOUT_MS = Number(process.env.KRONOS_TIMEOUT_MS ?? 12_000);
const PRED_LEN = Number(process.env.KRONOS_PRED_LEN ?? 6);
const LOOKBACK = Number(process.env.KRONOS_LOOKBACK ?? 400);

const TF_MINUTES: Record<string, number> = { '15m': 15, '30m': 30, '1h': 60, '4h': 240 };

export function kronosEnabled(): boolean {
  return !!KRONOS_URL;
}

/**
 * Blocking vs shadow. KRONOS_MODE=filter actually vetoes a breakout the model
 * disagrees with; any other value (default 'shadow') only logs the verdict and
 * lets the trade through, so we gather paired breakout/forecast/outcome data and
 * can prove the filter helps before it starts gating real trades.
 */
export function kronosBlocking(): boolean {
  return (process.env.KRONOS_MODE ?? 'shadow').toLowerCase() === 'filter';
}

export interface KronosVerdict {
  ok: boolean; // true = agrees (or failed open); false = forecast disagrees
  note: string; // compact status for the scan log
}

/** Ask Kronos whether its forecast agrees with `side` for this timeframe. Fails OPEN. */
export async function kronosAgrees(tf: string, closedBars: Candle[], side: Side): Promise<KronosVerdict> {
  if (!KRONOS_URL) return { ok: true, note: 'kronos:off' };
  const bars = closedBars.slice(-LOOKBACK);
  try {
    const res = await fetch(`${KRONOS_URL.replace(/\/$/, '')}/forecast`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        tf_minutes: TF_MINUTES[tf] ?? 60,
        pred_len: PRED_LEN,
        lookback: LOOKBACK,
        bars: bars.map((b) => ({ t: b.time, o: b.open, h: b.high, l: b.low, c: b.close, v: b.volume ?? 0 })),
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      logger.warn(`Kronos HTTP ${res.status} — allowing ${tf} ${side}`);
      return { ok: true, note: `kronos:http${res.status}(allow)` };
    }
    const j = (await res.json()) as { direction?: string; predChangePct?: number; error?: string };
    if (j.error) {
      logger.warn(`Kronos error (${j.error}) — allowing ${tf} ${side}`);
      return { ok: true, note: 'kronos:err(allow)' };
    }
    const want = side === 'long' ? 'up' : 'down';
    const ok = j.direction === want;
    return { ok, note: `kronos:${j.direction ?? '?'}(${(j.predChangePct ?? 0).toFixed(2)}%)${ok ? '✓' : '✗'}` };
  } catch (err) {
    logger.warn(`Kronos call failed (${(err as Error).message}) — allowing ${tf} ${side}`);
    return { ok: true, note: 'kronos:fail(allow)' };
  }
}
