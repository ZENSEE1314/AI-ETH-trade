// Pure complete-set math, kept separate from I/O so it can be tested offline.
//
// A "complete set" is one UP share + one DOWN share of the same market. Exactly
// one side resolves to $1 and the other to $0, so a set always pays $1. If the
// two best asks add up to less than $1 after fees, buying both locks in the gap.

import type { Book } from './client.js';

export interface SetQuote {
  upAsk: number;
  downAsk: number;
  cost: number; // upAsk + downAsk, per set
  fee: number; // assumed taker fee, per set
  edge: number; // 1 - cost - fee, per set (positive = profitable)
  maxSets: number; // limited by the thinner of the two best ask levels
}

export function quoteSet(up: Book, down: Book, feePct: number): SetQuote | null {
  if (!up.bestAsk || !down.bestAsk) return null;
  const cost = up.bestAsk.price + down.bestAsk.price;
  const fee = cost * (feePct / 100);
  return {
    upAsk: up.bestAsk.price,
    downAsk: down.bestAsk.price,
    cost,
    fee,
    edge: 1 - cost - fee,
    maxSets: Math.min(up.bestAsk.size, down.bestAsk.size),
  };
}

/**
 * How many sets to buy: only when the edge clears the minimum, capped by the
 * book depth at the best ask, the per-window budget left, and the cash left.
 * Returns whole sets (0 when the trade isn't worth taking).
 */
export function setsToBuy(
  q: SetQuote,
  opts: { minEdge: number; budgetLeft: number; cash: number },
): number {
  if (q.edge < opts.minEdge) return 0;
  const perSet = q.cost + q.fee;
  if (perSet <= 0) return 0;
  const affordable = Math.min(opts.budgetLeft, opts.cash) / perSet;
  return Math.max(0, Math.floor(Math.min(q.maxSets, affordable)));
}

/** Slug for the window containing `nowMs`, from a template like "{asset}-updown-{w}m-{start}". */
export function windowSlug(template: string, asset: string, windowMin: number, nowMs: number): { slug: string; startSec: number } {
  const len = windowMin * 60;
  const startSec = Math.floor(nowMs / 1000 / len) * len;
  const slug = template
    .replaceAll('{asset}', asset)
    .replaceAll('{w}', String(windowMin))
    .replaceAll('{start}', String(startSec));
  return { slug, startSec };
}
