// The trade engine: orchestrates strategy -> risk -> execution -> journal, and
// exposes state for the dashboard. Holds all in-memory runtime state.

import { EventEmitter } from 'node:events';
import type { Candle, Position, Signal, Trade } from '../types.js';
import { config } from '../config.js';
import { runtime, canTradeLive } from '../runtime.js';
import { logger } from '../logger.js';
import { generateSignal, type MarketSnapshot } from '../strategy/signal.js';
import { buildBias } from '../strategy/bias.js';
import { loadLearned, saveLearned, type LearnedParams } from '../learning/store.js';
import { buildProfile } from '../learning/profile.js';
import { optimize } from '../learning/optimizer.js';
import { USER_TRADES } from '../learning/history.js';
import { buildLiquidityMap, type LiquidityMap } from '../strategy/liquidityMap.js';

const RELEARN_EVERY = 10; // closed trades between online relearn passes
const MIN_RELEARN_BUFFER = 2000; // 1m candles needed before a relearn is trusted
const KLINE_BUFFER_CAP = 60_000; // ~41 days of 1m held for online learning
const LIVE_FEED_MIN = 250; // 1m bars from the live feed before it drives the engine
const LIVE_FEED_CAP = 60_000; // bound the live 1m tail we keep in memory
import { assessRisk, type RiskContext } from '../risk/riskManager.js';
import { openPaperPosition, evaluatePosition, closePosition } from '../exchange/paperBroker.js';
import { placeLiveOrder } from '../exchange/bitunix.js';
import { loadSnapshot, snapshotFromM1, lastPrice } from './marketData.js';
import { Journal } from './journal.js';
import { resample } from '../backtest/resample.js';
import { buildContext } from '../advisor/context.js';
import { askAdvisor } from '../advisor/advisor.js';
import { randomUUID } from 'node:crypto';

const ADVISOR_MIN_INTERVAL_MS = Number(process.env.ADVISOR_MIN_INTERVAL_MS ?? 15 * 60_000);

export interface EngineState {
  running: boolean;
  mode: string;
  liveEnabled: boolean;
  symbol: string;
  startEquity: number;
  equity: number;
  lastPrice: number;
  killSwitch: { daily: boolean; weekly: boolean; reason: string };
  bias: string;
  openPositions: Position[];
  recentSignals: Signal[];
  stats: ReturnType<Journal['stats']>;
  liquidity: LiquidityMap | null; // hourly liquidity map: nearest buy/sell pools
  learned: {
    targetMode: string;
    stopMode: string;
    minConfluence: number;
    minRiskReward: number;
    liqProximityPct: number;
    channelFilter: boolean;
    exit: string;
    trainedAt: number | null;
  };
  updatedAt: number;
}

export class TradeEngine extends EventEmitter {
  private journal = new Journal();
  private openPositions: Position[] = [];
  private recentSignals: Signal[] = [];
  private lastPx = 0;
  private lastBias = 'n/a';
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  // The learned "trade like me" config — loaded from learned.json, applied to
  // every signal and gate. Re-taught by learn CLI or this.relearn().
  private learned: LearnedParams = loadLearned();
  private lastLiquidity: LiquidityMap | null = null;
  private klineBuffer: Candle[] = []; // accumulated 1m history for online relearn
  private lastKlineTime = 0;
  private closedSinceRelearn = 0;
  // Live 1m bars pushed in from a TradingView bar-close webhook (or any 1m
  // source). Once it has enough history it drives the engine instead of the
  // exchange fetch — the higher timeframes are resampled from it.
  private liveM1: Candle[] = [];
  private lastAdvisorCallAt = 0;
  private advisorBusy = false;

  /** Base equity comes from settings so it reflects UI changes on restart. */
  get startEquity(): number {
    return runtime.accountEquityUsdt;
  }

  get equity(): number {
    return this.startEquity + this.journal.stats().netPnlUsdt;
  }

  start(): void {
    if (this.running || config.analysisIntervalMs <= 0) return;
    this.running = true;
    this.applyLearned();
    logger.info(`Engine started in ${runtime.tradingMode.toUpperCase()} mode (live ${canTradeLive() ? 'ENABLED' : 'disabled'}).`);
    void this.cycle();
    this.timer = setInterval(() => void this.cycle(), config.analysisIntervalMs);
  }

  /** Push the learned selectivity/target/stop config into the live gates. */
  private applyLearned(): void {
    runtime.minConfluence = this.learned.minConfluence;
    runtime.minRiskReward = this.learned.minRiskReward;
    logger.info(
      `Learned config: target=${this.learned.signal.targetMode} stop=${this.learned.signal.stopMode} ` +
        `conf≥${this.learned.minConfluence} rr≥${this.learned.minRiskReward}`,
    );
  }

  /**
   * Self-learning step: re-run the optimizer on fresh 1m data against the user's
   * profile, save the winner, and apply it live. Feed it recent klines (the
   * engine's own history, or a replay) to keep teaching the engine over time.
   */
  relearn(m1: Candle[]): LearnedParams {
    const profile = buildProfile(USER_TRADES);
    const ranked = optimize(m1.slice(-45_000), profile);
    if (ranked.length && ranked[0].fitness > -900) {
      this.learned = {
        ...ranked[0].params,
        meta: {
          trainedAt: Date.now(),
          dataPoints: m1.length,
          fitness: ranked[0].fitness,
          winRate: ranked[0].stats.winRate,
          avgR: ranked[0].stats.avgR,
          hitDrawRate: ranked[0].stats.hitDrawRate,
          note: 'relearned online from recent klines',
        },
      };
      saveLearned(this.learned);
      this.applyLearned();
      logger.info('Engine relearned from recent data.');
    }
    return this.learned;
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    logger.info('Engine stopped.');
  }

  private riskContext(): RiskContext {
    return {
      equityUsdt: this.equity,
      dayPnlUsdt: this.journal.dayPnl(),
      weekPnlUsdt: this.journal.weekPnl(),
      openPositions: this.openPositions.length,
    };
  }

  /** One analysis + management cycle. */
  async cycle(): Promise<void> {
    try {
      // Prefer the live TradingView feed once it has enough history; otherwise
      // fall back to the exchange fetch. This lets the engine run purely off a
      // bar-close webhook where the exchange API isn't reachable.
      const snap =
        this.liveM1.length >= LIVE_FEED_MIN
          ? snapshotFromM1(config.symbol, this.liveM1)
          : await loadSnapshot(config.symbol);
      this.lastPx = lastPrice(snap);
      this.lastBias = buildBias(snap.h4.length ? snap.h4 : snap.h1).direction;
      this.accumulateKlines(snap.m1);
      // Hourly liquidity map — the nearest buy/sell pools to read entries from.
      this.lastLiquidity = buildLiquidityMap(snap.h1.length ? snap.h1 : snap.m15);

      this.manageOpenPositions(snap);
      this.maybeRelearn();

      if (runtime.advisorMode) {
        // The LLM advisor is the trader — it decides entry / stop / target.
        void this.maybeAskAdvisor(snap);
      } else {
        const signal = generateSignal(snap, {
          ...this.learned.signal,
          liqProximityPct: this.learned.liqProximityPct,
          channelFilter: this.learned.channelFilter,
          channelTarget: this.learned.channelTarget,
        });
        if (signal) this.processSignal(signal);
      }

      this.emit('update', this.state());
    } catch (err) {
      logger.error(`Cycle error: ${(err as Error).message}`);
    }
  }

  /** Append new 1m candles to the online-learning buffer (deduped, capped). */
  private accumulateKlines(m1: Candle[]): void {
    for (const c of m1) {
      if (c.time > this.lastKlineTime) {
        this.klineBuffer.push(c);
        this.lastKlineTime = c.time;
      }
    }
    if (this.klineBuffer.length > KLINE_BUFFER_CAP) {
      this.klineBuffer = this.klineBuffer.slice(-KLINE_BUFFER_CAP);
    }
  }

  /**
   * Ingest one or more live 1m bars from the TradingView bar-close webhook.
   * Upserts by bar time (a re-sent in-progress bar replaces the last one), keeps
   * the series sorted and bounded, and reports how many bars are held so far.
   * When the same cycle interval fires it will pick these up automatically.
   */
  ingestCandles(bars: Candle[]): { accepted: number; total: number; ready: boolean } {
    let accepted = 0;
    for (const bar of bars) {
      if (![bar.open, bar.high, bar.low, bar.close, bar.time].every(Number.isFinite)) continue;
      const last = this.liveM1.at(-1);
      if (last && bar.time === last.time) {
        this.liveM1[this.liveM1.length - 1] = bar; // same bar re-sent → replace
      } else if (!last || bar.time > last.time) {
        this.liveM1.push(bar); // new, later bar
      } else {
        continue; // out-of-order / stale bar — ignore
      }
      accepted++;
    }
    if (this.liveM1.length > LIVE_FEED_CAP) this.liveM1 = this.liveM1.slice(-LIVE_FEED_CAP);
    return { accepted, total: this.liveM1.length, ready: this.liveM1.length >= LIVE_FEED_MIN };
  }

  /**
   * Advisor mode: hand the market to the LLM and let it make the call. Throttled
   * (ADVISOR_MIN_INTERVAL_MS, default 15m) and skipped while a position is open,
   * so free-tier API limits are respected. Non-blocking — the call runs while
   * the cycle continues.
   */
  private async maybeAskAdvisor(snap: MarketSnapshot): Promise<void> {
    if (this.advisorBusy || this.openPositions.length > 0) return;
    if (Date.now() - this.lastAdvisorCallAt < ADVISOR_MIN_INTERVAL_MS) return;
    this.advisorBusy = true;
    this.lastAdvisorCallAt = Date.now();
    try {
      const d1 = this.klineBuffer.length > 1440 ? resample(this.klineBuffer, 1440) : resample(snap.m1, 1440);
      const context = await buildContext({
        symbol: snap.symbol,
        d1: d1.slice(-60),
        h4: snap.h4.slice(-120),
        h1: snap.h1.slice(-250),
        m15: snap.m15.slice(-200),
        m1: snap.m1.slice(-250),
      });
      const rec = await askAdvisor(context);
      logger.info(`Advisor [${rec.model}]: ${rec.verdict.toUpperCase()} (${rec.confidence}) — ${rec.reasoning.slice(0, 180)}`);
      if (rec.verdict === 'wait') return;
      if (rec.stopLoss == null || rec.takeProfit == null) {
        logger.warn('Advisor gave a direction but no stop/target — skipping.');
        return;
      }
      const entry = rec.entry ?? this.lastPx;
      const risk = Math.abs(entry - rec.stopLoss);
      const reward = Math.abs(rec.takeProfit - entry);
      const signal: Signal = {
        id: randomUUID(),
        time: Date.now(),
        symbol: snap.symbol,
        side: rec.verdict,
        entry: round(entry, 2),
        stopLoss: round(rec.stopLoss, 2),
        takeProfit: round(rec.takeProfit, 2),
        riskReward: risk > 0 ? round(reward / risk, 2) : 0,
        // Advisor IS the confluence check — clamp so the engine gate passes.
        confluence: Math.max(rec.confidence, runtime.minConfluence),
        source: 'engine',
        reasons: [`ADVISOR: ${rec.reasoning}`, ...rec.warnings.map((w) => `⚠ ${w}`)],
      };
      this.processSignal(signal);
    } catch (err) {
      logger.warn(`Advisor call failed: ${(err as Error).message}`);
    } finally {
      this.advisorBusy = false;
    }
  }

  /** Online self-learning: after enough closed trades, retune on the buffer. */
  private maybeRelearn(): void {
    if (this.closedSinceRelearn < RELEARN_EVERY) return;
    if (this.klineBuffer.length < MIN_RELEARN_BUFFER) return;
    this.closedSinceRelearn = 0;
    try {
      this.relearn(this.klineBuffer);
    } catch (err) {
      logger.warn(`Relearn skipped: ${(err as Error).message}`);
    }
  }

  /** Close open positions whose stop/target/liquidation was hit on the last candle. */
  private manageOpenPositions(snap: MarketSnapshot): void {
    const candle: Candle | undefined = (snap.m1.length ? snap.m1 : snap.m15).at(-1);
    if (!candle) return;
    const still: Position[] = [];
    for (const pos of this.openPositions) {
      const trade = evaluatePosition(pos, candle);
      if (trade) {
        this.journal.record(trade);
        this.closedSinceRelearn++;
        logger.trade(`Closed ${trade.side} ${trade.symbol} via ${trade.reason}: ${trade.pnlUsdt} USDT (${trade.rMultiple}R)`);
        this.emit('trade', trade);
      } else {
        still.push(pos);
      }
    }
    this.openPositions = still;
  }

  /** Run a signal through risk and, if approved, execute it. */
  processSignal(signal: Signal): void {
    this.recentSignals.unshift(signal);
    this.recentSignals = this.recentSignals.slice(0, 20);
    this.emit('signal', signal);

    const decision = assessRisk(signal, this.riskContext());
    logger.info(`Signal ${signal.side} conf=${signal.confluence} rr=${signal.riskReward} -> ${decision.reason}`);
    if (!decision.approved) {
      this.emit('rejected', { signal, decision });
      return;
    }

    const position = openPaperPosition(signal, decision);

    if (canTradeLive()) {
      placeLiveOrder({
        symbol: signal.symbol,
        side: signal.side,
        qty: decision.positionSizeContracts,
        entry: signal.entry,
        stopLoss: signal.stopLoss,
        takeProfit: signal.takeProfit,
      })
        .then(() => {
          position.mode = 'live';
        })
        .catch((err) => logger.error(`Live order failed: ${(err as Error).message}`));
    }

    this.openPositions.push(position);
    logger.trade(`Opened ${position.side} ${position.symbol} @ ${position.entry} (${position.mode}) size=${position.sizeContracts}`);
    this.emit('opened', position);
  }

  /** Manually flatten a position at the current price (dashboard control). */
  closePositionManually(id: string): boolean {
    const idx = this.openPositions.findIndex((p) => p.id === id);
    if (idx === -1) return false;
    const pos = this.openPositions[idx];
    const trade = closePosition(pos, this.lastPx || pos.entry, 'manual');
    this.journal.record(trade);
    this.openPositions.splice(idx, 1);
    logger.trade(`Manually closed ${pos.side} ${pos.symbol}: ${trade.pnlUsdt} USDT`);
    this.emit('trade', trade);
    return true;
  }

  state(): EngineState {
    const ctx = this.riskContext();
    const dailyLimit = ctx.equityUsdt * (runtime.maxDailyLossPct / 100);
    const weeklyLimit = ctx.equityUsdt * (config.maxWeeklyLossPct / 100);
    const dailyHit = -ctx.dayPnlUsdt >= dailyLimit;
    const weeklyHit = -ctx.weekPnlUsdt >= weeklyLimit;

    return {
      running: this.running,
      mode: runtime.tradingMode,
      liveEnabled: canTradeLive(),
      symbol: config.symbol,
      startEquity: this.startEquity,
      equity: round(this.equity, 2),
      lastPrice: this.lastPx,
      killSwitch: {
        daily: dailyHit,
        weekly: weeklyHit,
        reason: dailyHit ? 'Daily loss cap reached' : weeklyHit ? 'Weekly loss cap reached' : 'clear',
      },
      bias: this.lastBias,
      openPositions: this.openPositions,
      recentSignals: this.recentSignals,
      stats: this.journal.stats(),
      liquidity: this.lastLiquidity,
      learned: {
        targetMode: this.learned.signal.targetMode,
        stopMode: this.learned.signal.stopMode,
        minConfluence: this.learned.minConfluence,
        minRiskReward: this.learned.minRiskReward,
        liqProximityPct: this.learned.liqProximityPct,
        channelFilter: this.learned.channelFilter,
        exit: this.learned.partial ? 'partial' : this.learned.beAtR ? `be@${this.learned.beAtR}R` : 'tp',
        trainedAt: this.learned.meta?.trainedAt ?? null,
      },
      updatedAt: Date.now(),
    };
  }

  getJournal(): Trade[] {
    return this.journal.all();
  }
}

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

export const engine = new TradeEngine();
