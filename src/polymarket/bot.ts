// Polymarket complete-set bot — PAPER ONLY. It reads live public order books
// and simulates fills; it has no wallet and never sends an order.
//
// Each scan, for every asset (BTC, ETH) it looks up the current short
// "up or down" window, reads both books, and if UP ask + DOWN ask + fees < $1
// by at least POLY_MIN_EDGE it "buys" sets at the best asks. When the window
// ends the set pays exactly $1 (one side always wins), booking the edge.
//
// Paper caveats (shown on the dashboard too): fills assume both legs execute
// at the displayed best ask with no queue or partial-fill risk, and the fee is
// an assumption (POLY_FEE_PCT). Live, one leg can fill without the other.

import { EventEmitter } from 'node:events';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { readJson, writeJson } from '../store.js';
import { fetchBook, fetchMarketBySlug, type PolyMarket } from './client.js';
import { quoteSet, setsToBuy, windowSlug, type SetQuote } from './sets.js';

export interface PolySetPosition {
  id: string;
  asset: string;
  slug: string;
  question: string;
  endMs: number;
  sets: number;
  costPerSet: number; // including fee
  openedAt: number;
  settledAt?: number;
  winner?: string; // "Up" / "Down" when known
  pnl?: number;
}

export interface PolyQuoteView extends SetQuote {
  asset: string;
  slug: string;
  endMs: number;
  at: number;
}

export interface PolyEdgePoint {
  t: number;
  asset: string;
  cost: number;
  edge: number;
}

interface PolyStore {
  cash: number;
  positions: PolySetPosition[];
}

const MAX_EDGE_POINTS = 600;
const MAX_POSITIONS_KEPT = 300;

class PolyBot extends EventEmitter {
  private cash: number;
  private positions: PolySetPosition[];
  private quotes = new Map<string, PolyQuoteView>();
  private markets = new Map<string, PolyMarket>();
  private edgeHistory: PolyEdgePoint[] = [];
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private lastError = '';
  private lastErrorAt = 0;
  private lastOkAt = 0;

  constructor() {
    super();
    const saved = readJson<PolyStore>('polymarket', { cash: config.polyBankrollUsdc, positions: [] });
    this.cash = saved.cash;
    this.positions = saved.positions;
  }

  start(): void {
    if (!config.polyEnabled || this.timer) return;
    logger.info(`Polymarket set bot started (PAPER) — assets ${config.polyAssets.join(',')}, ${config.polyWindowMin}m windows.`);
    void this.scan();
    this.timer = setInterval(() => void this.scan(), Math.max(1000, config.polyScanMs));
  }

  private save(): void {
    writeJson('polymarket', { cash: this.cash, positions: this.positions.slice(-MAX_POSITIONS_KEPT) });
  }

  private async scan(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const now = Date.now();
      for (const asset of config.polyAssets) {
        try {
          await this.scanAsset(asset, now);
          this.lastOkAt = Date.now();
        } catch (err) {
          this.noteError(`${asset}: ${(err as Error).message}`);
        }
      }
      await this.settleDue();
      this.emit('update', this.state());
    } finally {
      this.busy = false;
    }
  }

  private noteError(msg: string): void {
    // Log at most once a minute so a blocked API doesn't flood the log.
    if (msg !== this.lastError || Date.now() - this.lastErrorAt > 60_000) logger.warn(`Polymarket: ${msg}`);
    this.lastError = msg;
    this.lastErrorAt = Date.now();
  }

  private async scanAsset(asset: string, now: number): Promise<void> {
    const { slug } = windowSlug(config.polySlugTemplate, asset, config.polyWindowMin, now);
    let market = this.markets.get(slug);
    if (!market) {
      const found = await fetchMarketBySlug(slug);
      if (!found) throw new Error(`no market for slug ${slug}`);
      market = found;
      this.markets.set(slug, market);
      // Keep the cache small: drop markets that ended over an hour ago.
      for (const [k, m] of this.markets) if (m.endMs < now - 3_600_000) this.markets.delete(k);
    }
    if (market.closed || market.endMs <= now) return;

    const upIdx = Math.max(0, market.outcomes.findIndex((o) => /up|yes/i.test(o)));
    const downIdx = 1 - upIdx;
    const [upBook, downBook] = await Promise.all([
      fetchBook(market.tokenIds[upIdx]),
      fetchBook(market.tokenIds[downIdx]),
    ]);
    const q = quoteSet(upBook, downBook, config.polyFeePct);
    if (!q) return;
    this.quotes.set(asset, { ...q, asset, slug, endMs: market.endMs, at: now });
    this.edgeHistory.push({ t: now, asset, cost: q.cost, edge: q.edge });
    if (this.edgeHistory.length > MAX_EDGE_POINTS) this.edgeHistory.splice(0, this.edgeHistory.length - MAX_EDGE_POINTS);

    if ((market.endMs - now) / 1000 < config.polyMinSecondsLeft) return;
    const spent = this.positions
      .filter((p) => p.slug === slug)
      .reduce((s, p) => s + p.sets * p.costPerSet, 0);
    const n = setsToBuy(q, {
      minEdge: config.polyMinEdge,
      budgetLeft: config.polyMaxUsdcPerWindow - spent,
      cash: this.cash,
    });
    if (n <= 0) return;

    const costPerSet = q.cost + q.fee;
    this.cash -= n * costPerSet;
    this.positions.push({
      id: `${slug}-${now}`,
      asset,
      slug,
      question: market.question,
      endMs: market.endMs,
      sets: n,
      costPerSet,
      openedAt: now,
    });
    this.save();
    logger.trade(
      `POLY paper BUY ${n} sets ${asset.toUpperCase()} ${slug} @ ${q.upAsk.toFixed(3)}+${q.downAsk.toFixed(3)} ` +
        `(edge ${(q.edge * 100).toFixed(2)}¢/set, locked +$${(n * q.edge).toFixed(2)})`,
    );
  }

  /** A set pays $1 whatever the outcome, so settle at window end; fetch the winner just for the record. */
  private async settleDue(): Promise<void> {
    const now = Date.now();
    let changed = false;
    for (const p of this.positions) {
      if (p.settledAt || p.endMs > now) continue;
      p.settledAt = now;
      p.pnl = p.sets * (1 - p.costPerSet);
      this.cash += p.sets; // $1 per set
      changed = true;
      try {
        const m = await fetchMarketBySlug(p.slug);
        const i = m?.outcomePrices.findIndex((x) => x >= 0.99) ?? -1;
        if (m && i >= 0) p.winner = m.outcomes[i];
      } catch {
        /* winner is cosmetic; payout doesn't depend on it */
      }
      logger.trade(`POLY settled ${p.sets} sets ${p.slug}: +$${p.pnl.toFixed(2)}`);
    }
    if (changed) this.save();
  }

  state() {
    const settled = this.positions.filter((p) => p.settledAt);
    const open = this.positions.filter((p) => !p.settledAt);
    const realized = settled.reduce((s, p) => s + (p.pnl ?? 0), 0);
    const locked = open.reduce((s, p) => s + p.sets * (1 - p.costPerSet), 0);
    return {
      enabled: config.polyEnabled,
      paper: true,
      assets: config.polyAssets,
      windowMin: config.polyWindowMin,
      feePct: config.polyFeePct,
      minEdge: config.polyMinEdge,
      bankroll: config.polyBankrollUsdc,
      cash: Math.round(this.cash * 100) / 100,
      realizedPnl: Math.round(realized * 100) / 100,
      lockedPnl: Math.round(locked * 100) / 100,
      setsBought: this.positions.reduce((s, p) => s + p.sets, 0),
      quotes: [...this.quotes.values()],
      open,
      recent: settled.slice(-40).reverse(),
      edgeHistory: this.edgeHistory.slice(-300),
      lastOkAt: this.lastOkAt,
      lastError: this.lastErrorAt > this.lastOkAt ? this.lastError : '',
    };
  }
}

export type PolyState = ReturnType<PolyBot['state']>;
export const polyBot = new PolyBot();
