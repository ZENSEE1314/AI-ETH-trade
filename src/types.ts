// Shared domain types for the trading engine.

export type Side = 'long' | 'short';
export type TradingMode = 'paper' | 'live';

/** One OHLCV candle. `time` is the open time in ms epoch. */
export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** A detected swing point (fractal high or low). */
export interface Swing {
  index: number;
  time: number;
  price: number;
  kind: 'high' | 'low';
}

/** Market-structure read for one timeframe. */
export interface StructureState {
  trend: 'bullish' | 'bearish' | 'ranging';
  lastSwingHigh: Swing | null;
  lastSwingLow: Swing | null;
  bos: boolean; // break of structure in trend direction
  choch: boolean; // change of character (reversal)
  label: string; // human-readable, e.g. "HH-HL uptrend, BOS confirmed"
}

/** A fair value gap / imbalance. */
export interface FVG {
  side: Side; // bullish or bearish gap
  top: number;
  bottom: number;
  time: number;
  mitigated: boolean;
}

/** Key liquidity levels the market gravitates toward. */
export interface LiquidityLevels {
  pdh: number | null; // previous day high
  pdl: number | null; // previous day low
  op: number | null; // session/day opening price
  pwh: number | null; // previous week high
  pwl: number | null; // previous week low
  equalHighs: number[];
  equalLows: number[];
}

/**
 * The higher-timeframe "draw on liquidity" read: price has swept a resting
 * liquidity pool on one side and is now drawn toward an opposing resting pool.
 * On the 4H this is often the clearest tell of the day's high-probability
 * direction — the sweep sets the side, the opposing pool sets the target.
 */
export interface DrawOnLiquidity {
  side: Side; // long after a sell-side sweep, short after a buy-side sweep
  sweptLevel: number; // the resting liquidity that was grabbed (stop hunt)
  sweepExtreme: number; // the wick extreme of the sweep (protective-stop anchor)
  drawTarget: number; // opposing resting liquidity we're drawn toward (take-profit)
  reasons: string[];
}

/** VWAP with standard-deviation bands. */
export interface VwapState {
  vwap: number;
  upper: number;
  lower: number;
}

/** The daily directional bias. */
export interface Bias {
  direction: Side | 'neutral';
  premiumDiscount: 'premium' | 'discount' | 'equilibrium';
  reasons: string[];
}

/** A fully-formed trade idea produced by the strategy pipeline. */
export interface Signal {
  id: string;
  time: number;
  symbol: string;
  side: Side;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  riskReward: number;
  confluence: number; // 0-100
  source: 'engine' | 'tradingview';
  reasons: string[]; // the Bias>Context>Liquidity>Structure>Timing trail
  // Draw-on-liquidity context, when a sweep drove the setup (for the dashboard).
  sweepSide?: 'buy-side' | 'sell-side'; // which resting pool was already swept
  sweptLevel?: number; // the level that was swept
  drawTarget?: number; // the opposing unswept pool price is drawn toward
  drawTimeframe?: '4H' | '15M'; // where the driving draw was read
}

export interface RiskDecision {
  approved: boolean;
  reason: string;
  positionSizeContracts: number;
  notionalUsdt: number;
  marginUsdt: number;
  riskUsdt: number;
  liquidationPrice: number;
}

export interface Position {
  id: string;
  symbol: string;
  side: Side;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  sizeContracts: number;
  leverage: number;
  liquidationPrice: number;
  openedAt: number;
  mode: TradingMode;
}

export interface Trade {
  id: string;
  symbol: string;
  side: Side;
  entry: number;
  exit: number;
  stopLoss: number;
  takeProfit: number;
  sizeContracts: number;
  pnlUsdt: number;
  rMultiple: number;
  openedAt: number;
  closedAt: number;
  outcome: 'win' | 'loss' | 'breakeven';
  reason: string; // exit reason: tp / sl / manual
  mode: TradingMode;
}
