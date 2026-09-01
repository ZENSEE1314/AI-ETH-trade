// The learned strategy configuration — what the optimizer teaches the engine.
// Persisted as `learned.json` under DATA_DIR so the paper engine trades the
// learned way across restarts, and each `npm run learn` run updates it.

import type { SignalOptions } from '../strategy/signal.js';
import { config } from '../config.js';
import { readJson, writeJson } from '../store.js';

export interface LearnedParams {
  signal: Required<Pick<SignalOptions, 'targetMode' | 'stopMode' | 'entryMode'>>;
  minConfluence: number; // selectivity gate
  minRiskReward: number; // R:R gate
  liqProximityPct: number; // hourly-liquidity sweep gate (0 = off)
  channelFilter: boolean; // only trade with the trend-channel slope
  channelTarget: boolean; // target the leading channel band instead of the draw
  partial: boolean; // scale out at the near pool + breakeven runner
  beAtR: number; // move stop to breakeven after this many R (0 = off)
  meta?: {
    trainedAt: number;
    dataPoints: number;
    fitness: number;
    winRate: number;
    avgR: number;
    hitDrawRate: number;
    note: string;
  };
}

/** The engine's shipping default before anything is learned. Seeded from env
 *  config so gates/entry mode are tunable on the deploy without a learned.json
 *  (which isn't shipped — it lives under the ephemeral DATA_DIR). */
export function defaultLearned(): LearnedParams {
  return {
    signal: {
      targetMode: config.targetMode,
      stopMode: config.stopMode,
      entryMode: config.entryMode,
    },
    minConfluence: config.minConfluence,
    minRiskReward: config.minRiskReward,
    liqProximityPct: 0,
    channelFilter: false,
    channelTarget: false,
    partial: false,
    beAtR: 0,
  };
}

export function loadLearned(): LearnedParams {
  const stored = readJson<LearnedParams | null>('learned', null);
  return stored ?? defaultLearned();
}

export function saveLearned(p: LearnedParams): void {
  writeJson('learned', p);
}
