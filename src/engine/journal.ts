// Trading journal & performance review. Records every trade and computes the
// stats that reveal whether the edge is real: win rate, expectancy, avg R,
// profit factor, max drawdown.

import type { Trade } from '../types.js';
import { readJson, writeJson } from '../store.js';

// Persisted via the shared store so it lands under config.dataDir — the mounted
// volume on Railway. A hardcoded 'data/' path here would be the container's
// ephemeral disk and every redeploy would wipe the trade history.
const STORE_KEY = 'journal';
const DAY_MS = 24 * 60 * 60 * 1000;

export interface PerformanceStats {
  totalTrades: number;
  wins: number;
  losses: number;
  winRatePct: number;
  netPnlUsdt: number;
  avgRMultiple: number;
  profitFactor: number;
  expectancyR: number;
  maxDrawdownUsdt: number;
  dayPnlUsdt: number;
  weekPnlUsdt: number;
}

export class Journal {
  private trades: Trade[] = [];

  constructor() {
    this.load();
  }

  record(trade: Trade): void {
    this.trades.push(trade);
    this.save();
  }

  all(): Trade[] {
    return [...this.trades].reverse();
  }

  dayPnl(): number {
    const since = Date.now() - DAY_MS;
    return this.trades.filter((t) => t.closedAt >= since).reduce((s, t) => s + t.pnlUsdt, 0);
  }

  weekPnl(): number {
    const since = Date.now() - 7 * DAY_MS;
    return this.trades.filter((t) => t.closedAt >= since).reduce((s, t) => s + t.pnlUsdt, 0);
  }

  stats(): PerformanceStats {
    const total = this.trades.length;
    const wins = this.trades.filter((t) => t.outcome === 'win');
    const losses = this.trades.filter((t) => t.outcome === 'loss');
    const grossWin = wins.reduce((s, t) => s + t.pnlUsdt, 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnlUsdt, 0));
    const netPnl = this.trades.reduce((s, t) => s + t.pnlUsdt, 0);
    const avgR = total ? this.trades.reduce((s, t) => s + t.rMultiple, 0) / total : 0;

    return {
      totalTrades: total,
      wins: wins.length,
      losses: losses.length,
      winRatePct: total ? round((wins.length / total) * 100, 1) : 0,
      netPnlUsdt: round(netPnl, 2),
      avgRMultiple: round(avgR, 2),
      profitFactor: grossLoss > 0 ? round(grossWin / grossLoss, 2) : grossWin > 0 ? Infinity : 0,
      expectancyR: round(avgR, 2),
      maxDrawdownUsdt: round(this.maxDrawdown(), 2),
      dayPnlUsdt: round(this.dayPnl(), 2),
      weekPnlUsdt: round(this.weekPnl(), 2),
    };
  }

  private maxDrawdown(): number {
    let peak = 0;
    let equity = 0;
    let maxDd = 0;
    for (const t of this.trades) {
      equity += t.pnlUsdt;
      peak = Math.max(peak, equity);
      maxDd = Math.max(maxDd, peak - equity);
    }
    return maxDd;
  }

  private load(): void {
    this.trades = readJson<Trade[]>(STORE_KEY, []);
  }

  private save(): void {
    writeJson(STORE_KEY, this.trades);
  }
}

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
