// Turn the reference trades into a "trading profile" — the measurable fingerprint
// of how the user trades. The learner scores candidate strategy configs by how
// well they reproduce this profile (and stay profitable).

import type { RawTrade } from './history.js';

export interface TradeProfile {
  n: number;
  longShare: number; // 0..1 fraction of longs (≈0.5 = trades both sides)
  winRate: number; // fraction of trades that closed in profit
  avgStopPct: number; // mean stop distance as % of entry (risk width)
  avgR: number; // mean reward in R
  medianR: number;
  targetStyle: 'near' | 'draw'; // small R = bank the near pool; big R = run to the full draw
}

export function buildProfile(trades: RawTrade[]): TradeProfile {
  const n = trades.length;
  if (n === 0) {
    return { n: 0, longShare: 0.5, winRate: 0, avgStopPct: 0, avgR: 0, medianR: 0, targetStyle: 'draw' };
  }
  let longs = 0;
  let wins = 0;
  let sumStopPct = 0;
  const rs: number[] = [];
  for (const t of trades) {
    const dir = t.side === 'long' ? 1 : -1;
    const risk = Math.abs(t.entry - t.stop) || 1e-9;
    const r = (dir * (t.exit - t.entry)) / risk;
    rs.push(r);
    if (t.side === 'long') longs++;
    if (r > 0) wins++;
    sumStopPct += (risk / t.entry) * 100;
  }
  rs.sort((a, b) => a - b);
  const median = rs[Math.floor(rs.length / 2)];
  const avgR = rs.reduce((s, r) => s + r, 0) / n;
  return {
    n,
    longShare: longs / n,
    winRate: wins / n,
    avgStopPct: round(sumStopPct / n, 3),
    avgR: round(avgR, 2),
    medianR: round(median, 2),
    // A median hold beyond ~3R means the user lets price run to the further
    // draw rather than banking the first pool.
    targetStyle: median >= 3 ? 'draw' : 'near',
  };
}

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
