// The learner. It searches the strategy's parameter space and picks the config
// that best reproduces the user's trading profile while staying profitable on
// the data — this IS the "self-learning": run it again on new data (or the
// growing paper journal) and it re-teaches the engine.
//
// This is parameter optimization, not supervised ML — with a handful of
// all-winner reference trades there is no labelled loss surface to fit. What it
// does is honest and useful: score every candidate config by expectancy plus
// how close its behaviour sits to how the user trades, and keep the best.

import type { Candle } from '../types.js';
import { backtest, type BacktestStats } from '../backtest/backtest.js';
import type { LearnedParams } from './store.js';
import type { TradeProfile } from './profile.js';

export interface Candidate {
  params: LearnedParams;
  stats: BacktestStats;
  fitness: number;
}

type ExitMode = 'tp' | 'partial' | 'be';
const EXIT: Record<ExitMode, { partial: boolean; beAtR: number }> = {
  tp: { partial: false, beAtR: 0 },
  partial: { partial: true, beAtR: 0 },
  be: { partial: false, beAtR: 1.5 },
};

export interface SearchGrid {
  targetMode: Array<'near' | 'draw'>;
  stopMode: Array<'swing' | 'sweep'>;
  exit: ExitMode[];
  minConfluence: number[];
  minRiskReward: number[];
  liqProximityPct: number[]; // hourly-liquidity sweep gate (0 = off)
  channelFilter: boolean[]; // trade only with the trend-channel slope
}

/** Default grid — starts biased toward the user's profile (draw target, both stops). */
export function defaultGrid(profile: TradeProfile): SearchGrid {
  return {
    targetMode: profile.targetStyle === 'near' ? ['near', 'draw'] : ['draw', 'near'],
    stopMode: ['swing', 'sweep'],
    exit: ['tp', 'partial', 'be'],
    // Fees reward fewer, higher-quality, bigger-R trades — the opposite of
    // scalping. Bias selectivity high and R:R toward the user's journal (avg ~6R).
    minConfluence: [75, 85],
    minRiskReward: profile.medianR >= 3 ? [2, 3, 4] : [1.5, 2, 3],
    liqProximityPct: [0], // real-data testing showed the sweep gate adds no edge
    // Search the channel FILTER only; the band TARGET tested worse on real data
    // (it caps the fat-tail trend legs the draw/sweep edge depends on).
    channelFilter: [false, true],
  };
}

/**
 * Fitness: expectancy first (a config must make money), then a bonus for trading
 * the way the user does — banking the move (reached-draw rate) and a healthy
 * profit factor. Configs with too few trades to trust are pushed to the bottom.
 */
export function fitness(stats: BacktestStats, profile: TradeProfile): number {
  if (stats.trades < 20) return -999 + stats.trades; // need a real sample
  let f = stats.avgR; // expectancy in R — the core
  f += 0.3 * stats.hitDrawRate; // reward reaching the draw, as the user's trades do
  f += 0.2 * Math.min(stats.profitFactor, 3); // reward a solid profit factor
  // Nudge toward the user's win-rate band without letting it override expectancy.
  f -= 0.25 * Math.abs(stats.winRate - profile.winRate);
  return f;
}

/** Run the search over `m1` and return every candidate, best first. `costBps` is
 *  the per-side fee+slippage the backtest charges — pass it so the learner tunes
 *  on net-of-cost results (a thin gross edge can invert once fees are real). */
export function optimize(
  m1: Candle[],
  profile: TradeProfile,
  grid = defaultGrid(profile),
  costBps = 0,
): Candidate[] {
  const out: Candidate[] = [];
  for (const targetMode of grid.targetMode) {
    for (const stopMode of grid.stopMode) {
      for (const exit of grid.exit) {
        for (const minConfluence of grid.minConfluence) {
          for (const minRiskReward of grid.minRiskReward) {
            for (const liqProximityPct of grid.liqProximityPct) {
              for (const channelFilter of grid.channelFilter) {
                const { partial, beAtR } = EXIT[exit];
                const { stats } = backtest(m1, {
                  minConfluence,
                  minRiskReward,
                  signal: { targetMode, stopMode, liqProximityPct, channelFilter },
                  partial,
                  beAtR,
                  costBps,
                });
                const params: LearnedParams = {
                  signal: { targetMode, stopMode },
                  minConfluence,
                  minRiskReward,
                  liqProximityPct,
                  channelFilter,
                  channelTarget: false,
                  partial,
                  beAtR,
                };
                out.push({ params, stats, fitness: fitness(stats, profile) });
              }
            }
          }
        }
      }
    }
  }
  out.sort((a, b) => b.fitness - a.fitness);
  return out;
}
