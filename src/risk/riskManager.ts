// Risk management — the layer that actually keeps the account alive.
// Enforces: per-trade risk, min R:R, daily & weekly loss caps (hard kill
// switch), max open positions, and the leverage/liquidation sanity guard that
// matters enormously at 50x.

import type { RiskDecision, Signal } from '../types.js';
import { config } from '../config.js';
import { runtime } from '../runtime.js';

// Bitunix cross-margin maintenance margin rate is small; we use a conservative
// buffer so a stop always sits INSIDE the liquidation price, never beyond it.
const MAINTENANCE_MARGIN_RATE = 0.005;

export interface RiskContext {
  equityUsdt: number;
  dayPnlUsdt: number; // realized PnL so far today (negative = losses)
  weekPnlUsdt: number;
  openPositions: number;
}

export function liquidationPrice(side: 'long' | 'short', entry: number, leverage: number): number {
  const move = entry * (1 / leverage - MAINTENANCE_MARGIN_RATE);
  return side === 'long' ? entry - move : entry + move;
}

export function assessRisk(signal: Signal, ctx: RiskContext): RiskDecision {
  const reject = (reason: string): RiskDecision => ({
    approved: false,
    reason,
    positionSizeContracts: 0,
    notionalUsdt: 0,
    marginUsdt: 0,
    riskUsdt: 0,
    liquidationPrice: 0,
  });

  // --- Hard kill switches ----------------------------------------------------
  const dailyLossLimit = ctx.equityUsdt * (runtime.maxDailyLossPct / 100);
  if (-ctx.dayPnlUsdt >= dailyLossLimit) {
    return reject(
      `KILL SWITCH: daily loss cap hit (${ctx.dayPnlUsdt.toFixed(2)} / -${dailyLossLimit.toFixed(2)} USDT). No new trades today.`,
    );
  }
  const weeklyLossLimit = ctx.equityUsdt * (config.maxWeeklyLossPct / 100);
  if (-ctx.weekPnlUsdt >= weeklyLossLimit) {
    return reject(
      `KILL SWITCH: weekly loss cap hit (${ctx.weekPnlUsdt.toFixed(2)} / -${weeklyLossLimit.toFixed(2)} USDT). No new trades this week.`,
    );
  }

  if (ctx.openPositions >= config.maxOpenPositions) {
    return reject(`Max open positions reached (${config.maxOpenPositions}).`);
  }

  // --- Setup quality gates ---------------------------------------------------
  if (signal.confluence < runtime.minConfluence) {
    return reject(`Confluence ${signal.confluence} < required ${runtime.minConfluence}.`);
  }
  if (signal.riskReward < config.minRiskReward) {
    return reject(`R:R ${signal.riskReward} < required ${config.minRiskReward}.`);
  }

  const stopDistance = Math.abs(signal.entry - signal.stopLoss);
  if (stopDistance <= 0) return reject('Invalid stop distance.');

  // Validate stop is on the correct side of entry.
  if (signal.side === 'long' && signal.stopLoss >= signal.entry) return reject('Long stop must be below entry.');
  if (signal.side === 'short' && signal.stopLoss <= signal.entry) return reject('Short stop must be above entry.');

  // --- Leverage / liquidation guard (critical at 50x) ------------------------
  // If the stop sits beyond the liquidation price, you get liquidated BEFORE
  // your stop — meaning your "1% risk" is a lie. Reject rather than pretend.
  const stopDistancePct = stopDistance / signal.entry;
  const liquidationDistancePct = 1 / runtime.leverage - MAINTENANCE_MARGIN_RATE;
  if (stopDistancePct >= liquidationDistancePct) {
    return reject(
      `Stop is ${(stopDistancePct * 100).toFixed(2)}% away but ${runtime.leverage}x liquidates at ` +
        `~${(liquidationDistancePct * 100).toFixed(2)}%. Setup would be liquidated before the stop — ` +
        `reduce leverage or widen the invalidation. Rejected.`,
    );
  }

  // --- Position sizing (risk-based, leverage-independent for loss size) -------
  const riskUsdt = ctx.equityUsdt * (runtime.riskPerTradePct / 100);
  const positionSizeContracts = riskUsdt / stopDistance; // ETH units
  const notionalUsdt = positionSizeContracts * signal.entry;
  const marginUsdt = notionalUsdt / runtime.leverage;

  if (marginUsdt > ctx.equityUsdt) {
    return reject(`Required margin ${marginUsdt.toFixed(2)} exceeds equity ${ctx.equityUsdt.toFixed(2)}.`);
  }

  return {
    approved: true,
    reason: `Approved: risk ${riskUsdt.toFixed(2)} USDT, size ${positionSizeContracts.toFixed(4)} ETH, R:R ${signal.riskReward}.`,
    positionSizeContracts: round(positionSizeContracts, 4),
    notionalUsdt: round(notionalUsdt, 2),
    marginUsdt: round(marginUsdt, 2),
    riskUsdt: round(riskUsdt, 2),
    liquidationPrice: round(liquidationPrice(signal.side, signal.entry, runtime.leverage), 2),
  };
}

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
