// Paper broker: simulated fills and position tracking. Default execution path.
// No network, no funds — safe to run anywhere.

import { randomUUID } from 'node:crypto';
import type { Candle, Position, RiskDecision, Signal, Trade } from '../types.js';
import { runtime } from '../runtime.js';

export function openPaperPosition(signal: Signal, risk: RiskDecision): Position {
  return {
    id: randomUUID(),
    symbol: signal.symbol,
    side: signal.side,
    entry: signal.entry,
    stopLoss: signal.stopLoss,
    takeProfit: signal.takeProfit,
    sizeContracts: risk.positionSizeContracts,
    leverage: runtime.leverage,
    liquidationPrice: risk.liquidationPrice,
    openedAt: Date.now(),
    mode: 'paper',
  };
}

/**
 * Evaluate an open position against a freshly-closed candle. Closes on stop,
 * target, or liquidation. If the candle straddles both stop and target we
 * assume the worse (stop) outcome — never flatter the backtest.
 */
export function evaluatePosition(pos: Position, candle: Candle): Trade | null {
  const hitStop = pos.side === 'long' ? candle.low <= pos.stopLoss : candle.high >= pos.stopLoss;
  const hitTarget = pos.side === 'long' ? candle.high >= pos.takeProfit : candle.low <= pos.takeProfit;
  const hitLiq = pos.side === 'long' ? candle.low <= pos.liquidationPrice : candle.high >= pos.liquidationPrice;

  let exit: number | null = null;
  let reason = '';
  if (hitLiq) {
    exit = pos.liquidationPrice;
    reason = 'liquidation';
  } else if (hitStop) {
    exit = pos.stopLoss;
    reason = 'sl';
  } else if (hitTarget) {
    exit = pos.takeProfit;
    reason = 'tp';
  }
  if (exit === null) return null;

  return closePosition(pos, exit, reason);
}

export function closePosition(pos: Position, exit: number, reason: string): Trade {
  const dir = pos.side === 'long' ? 1 : -1;
  const pnlUsdt = (exit - pos.entry) * dir * pos.sizeContracts;
  const risk = Math.abs(pos.entry - pos.stopLoss) * pos.sizeContracts;
  const rMultiple = risk > 0 ? pnlUsdt / risk : 0;
  const outcome: Trade['outcome'] = pnlUsdt > 0 ? 'win' : pnlUsdt < 0 ? 'loss' : 'breakeven';

  return {
    id: pos.id,
    symbol: pos.symbol,
    side: pos.side,
    entry: pos.entry,
    exit: round(exit, 2),
    stopLoss: pos.stopLoss,
    takeProfit: pos.takeProfit,
    sizeContracts: pos.sizeContracts,
    pnlUsdt: round(pnlUsdt, 2),
    rMultiple: round(rMultiple, 2),
    openedAt: pos.openedAt,
    closedAt: Date.now(),
    outcome,
    reason,
    mode: pos.mode,
  };
}

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
