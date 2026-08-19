// The trading curriculum the bot is built around. Each concept maps to where
// it is applied in the engine, so the strategy is auditable end-to-end.

export interface Lesson {
  topic: string;
  summary: string;
  appliedIn: string;
}

export interface Module {
  title: string;
  lessons: Lesson[];
}

export const PHILOSOPHY = 'Bias > Context > Liquidity > Market Structure > Timing > Execution > Risk Management';

export const CURRICULUM: Module[] = [
  {
    title: 'Futures & Leverage Foundations',
    lessons: [
      { topic: 'What Is Futures Trading?', summary: 'A contract to buy/sell an asset at a future price; perpetual futures track spot via funding and let you go long or short with margin.', appliedIn: 'exchange/bitunix.ts — long/short order routing' },
      { topic: 'Understanding Leverage', summary: 'Leverage multiplies exposure and risk equally. At 50x a ~2% adverse move liquidates the position — leverage never improves an edge, it only shortens your survival.', appliedIn: 'risk/riskManager.ts — liquidation guard' },
      { topic: 'Order Types', summary: 'Market (immediate), Limit (price or better), Stop (trigger). Entries at FVG midpoints suit limits; invalidations use stops.', appliedIn: 'exchange/bitunix.ts placeLiveOrder, paperBroker' },
      { topic: 'Why Most Traders Lose', summary: 'Oversizing, no stop, revenge trading, chasing, and ignoring risk-of-ruin math. Losses come from behaviour, not lack of signals.', appliedIn: 'risk caps + psychology module discipline rules' },
    ],
  },
  {
    title: 'Risk & The Mathematics of Trading',
    lessons: [
      { topic: 'Position Sizing', summary: 'Size = (equity × risk%) ÷ stop distance. Size is derived from the stop, never from how confident you feel.', appliedIn: 'risk/riskManager.ts assessRisk' },
      { topic: 'Risk Per Trade', summary: 'Cap risk to a small fixed % (default 1%) so no single trade can meaningfully dent the account.', appliedIn: 'config.riskPerTradePct' },
      { topic: 'Risk-to-Reward Ratio', summary: 'Only take setups paying ≥ 2R. With 2R and 40% win rate the system is still profitable.', appliedIn: 'config.minRiskReward, signal.ts riskReward' },
      { topic: 'Maximum Daily Loss', summary: 'Hard stop at 3% of equity per day — the kill switch halts all new trades once hit.', appliedIn: 'riskManager KILL SWITCH (daily)' },
      { topic: 'Maximum Weekly Loss', summary: 'Second circuit breaker (default 8%/week) to stop a bad streak compounding.', appliedIn: 'riskManager KILL SWITCH (weekly)' },
      { topic: 'The Mathematics of Trading', summary: 'Expectancy = (winRate × avgWin) − (lossRate × avgLoss). A positive, repeatable expectancy is the only real edge.', appliedIn: 'engine/journal.ts expectancy & profit factor' },
      { topic: 'Building Consistency', summary: 'Consistency comes from a fixed process and fixed risk, not from variable bet sizing on "high-confidence" trades.', appliedIn: 'fixed risk% + confluence gate' },
    ],
  },
  {
    title: 'Reading Candlesticks',
    lessons: [
      { topic: 'Candlestick Anatomy', summary: 'Body = conviction, wicks = rejection. Ratio of body to range measures who won the session.', appliedIn: 'strategy/candles.ts analyzeCandle' },
      { topic: 'Bullish vs Bearish Pressure', summary: 'Close vs open sets direction; successive closes into a level reveal absorption or continuation.', appliedIn: 'candles.ts bullish/bearish' },
      { topic: 'Candle Strength', summary: 'Large body + small wicks = strong displacement; small body = weak/indecisive.', appliedIn: 'candles.ts strength' },
      { topic: 'Wicks & Rejections', summary: 'A long wick beyond a level then close back inside marks rejection and often a liquidity sweep.', appliedIn: 'candles.ts rejection; liquidity.ts detectSweep' },
      { topic: 'Momentum vs Indecision', summary: 'Engulfing/displacement = momentum; dojis and inside bars = indecision, stand aside.', appliedIn: 'candles.ts isBullish/BearishEngulfing, doji' },
      { topic: 'Reading Candles in Context', summary: 'A candle only means something at a level (FVG, PDH/PDL, VWAP). Context first, candle second.', appliedIn: 'signal.ts timing stage' },
      { topic: 'Common Candlestick Mistakes', summary: 'Trading patterns in a vacuum, ignoring the higher timeframe, and acting mid-candle before close.', appliedIn: 'evaluate on closed candles only' },
      { topic: 'The Power of 3', summary: 'Accumulation → Manipulation (sweep) → Distribution (displacement). The manipulation leg traps, the distribution leg pays.', appliedIn: 'candles.ts powerOfThree' },
    ],
  },
  {
    title: 'Timeframe Analysis (Top-Down)',
    lessons: [
      { topic: 'Understanding Timeframes', summary: 'Higher timeframes set direction and dominate; lower timeframes only time the entry.', appliedIn: 'strategy/signal.ts MarketSnapshot' },
      { topic: 'Top-Down Process', summary: '4H bias → 1H confirmation → 15M setup → 1M entry. Never let a lower TF override a higher one.', appliedIn: 'signal.ts pipeline order' },
      { topic: 'Purpose of Each Timeframe', summary: '4H=Bias, 1H=Confirmation, 15M=Setup, 1M=Entry.', appliedIn: 'engine/marketData.ts loadSnapshot' },
      { topic: 'Timeframe Alignment', summary: 'Highest-probability trades occur when all timeframes point the same way.', appliedIn: 'signal.ts context alignment' },
      { topic: 'Conflicting Timeframes', summary: 'When 1H opposes the 4H bias, stand aside — no trade.', appliedIn: 'signal.ts returns null on conflict' },
    ],
  },
  {
    title: 'Market Structure',
    lessons: [
      { topic: 'Trend Basics (HH, HL, LH, LL)', summary: 'Higher highs & higher lows = uptrend; lower highs & lower lows = downtrend.', appliedIn: 'strategy/structure.ts readStructure' },
      { topic: 'Break of Structure (BOS)', summary: 'Price breaks the last swing in the trend direction = continuation confirmed.', appliedIn: 'structure.ts bos' },
      { topic: 'Change of Character (CHoCH)', summary: 'Price breaks a swing against the trend = first sign of reversal.', appliedIn: 'structure.ts choch' },
      { topic: 'Trending vs Ranging', summary: 'Trend = trade pullbacks with the trend; range = fade the edges into liquidity.', appliedIn: 'structure.ts trend classification' },
      { topic: 'Swing Highs & Lows', summary: 'Fractal pivots that define structure and where liquidity rests.', appliedIn: 'structure.ts findSwings' },
    ],
  },
  {
    title: 'Liquidity (Core Concept)',
    lessons: [
      { topic: 'What Is Liquidity?', summary: 'Clusters of resting orders (stops) that price is drawn to; institutions fill size where liquidity pools.', appliedIn: 'strategy/liquidity.ts' },
      { topic: 'Buy-Side & Sell-Side Liquidity', summary: 'Buy-side sits above highs (short stops); sell-side sits below lows (long stops).', appliedIn: 'liquidity.ts detectSweep sides' },
      { topic: 'Equal Highs / Equal Lows', summary: 'Repeated touches leave obvious pools that are prime sweep targets.', appliedIn: 'liquidity.ts equalLevels' },
      { topic: 'Liquidity Sweeps & Stop Hunts', summary: 'Price spikes beyond a level to grab stops, then reverses — our preferred entry trigger.', appliedIn: 'liquidity.ts detectSweep; signal.ts liquidity stage' },
      { topic: 'Institutional Order Flow', summary: 'Smart money accumulates against retail stops; follow the reversal after the sweep, not the breakout.', appliedIn: 'signal.ts favors post-sweep entries' },
      { topic: 'Draw on Liquidity (4H)', summary: 'On the 4H a sweep of one side plus an untapped pool on the other reveals the day’s high-probability direction: the sweep picks the side, the opposing pool is the target price is drawn toward.', appliedIn: 'strategy/drawOnLiquidity.ts detectDrawOnLiquidity; signal.ts draw stage' },
    ],
  },
  {
    title: 'Fair Value Gaps & Pricing',
    lessons: [
      { topic: 'What Is an Imbalance?', summary: 'A 3-candle gap where price moved so fast one side was unfilled; price often returns to rebalance it.', appliedIn: 'strategy/fvg.ts findFVGs' },
      { topic: 'Bullish & Bearish FVG', summary: 'Bullish gap below price = demand; bearish gap above = supply. Entries target unmitigated gaps.', appliedIn: 'fvg.ts latestUnmitigatedFVG' },
      { topic: 'Mitigation', summary: 'A gap is "used up" once price trades back into it; only unmitigated gaps are valid entries.', appliedIn: 'fvg.ts mitigated flag' },
      { topic: 'Premium vs Discount', summary: 'Sell in premium (above equilibrium), buy in discount (below). Never buy expensive.', appliedIn: 'fvg.ts premiumDiscount' },
      { topic: 'Combining FVG with Structure', summary: 'Best entries: FVG in a discount, in the direction of a fresh CHoCH/BOS.', appliedIn: 'signal.ts timing + structure stages' },
    ],
  },
  {
    title: 'VWAP',
    lessons: [
      { topic: 'What Is VWAP?', summary: 'Volume-weighted average price — the session’s fair value and institutional benchmark.', appliedIn: 'strategy/vwap.ts computeVwap' },
      { topic: 'VWAP Bands', summary: 'Upper/VWAP/Lower std-dev bands mark stretched vs fair pricing.', appliedIn: 'vwap.ts upper/lower' },
      { topic: 'Mean Reversion', summary: 'Tags of the outer bands often revert toward VWAP.', appliedIn: 'vwap.ts mean-reversion signals' },
      { topic: 'Trend Trading', summary: 'Holding above/below VWAP confirms trend direction for continuation entries.', appliedIn: 'vwap.ts trend signals' },
      { topic: 'VWAP Reclaim & Confirmation', summary: 'Crossing back over VWAP confirms a shift; used as extra confluence, never alone.', appliedIn: 'vwap.ts reclaim; signal.ts vwap stage' },
    ],
  },
  {
    title: 'Building Daily Bias',
    lessons: [
      { topic: 'PDH / PDL', summary: 'Previous day high/low are magnets and sweep targets that frame intraday range.', appliedIn: 'liquidity.ts dailyLevels' },
      { topic: 'Opening Price (OP)', summary: 'Price above/below the open reveals intraday intent.', appliedIn: 'bias.ts OP logic' },
      { topic: 'PWH / PWL', summary: 'Previous week high/low give the weekly liquidity frame.', appliedIn: 'liquidity.ts weeklyLevels' },
      { topic: 'Creating Your Daily Bias', summary: 'Combine HTF structure + OP + PDH/PDL + premium/discount into one directional lean.', appliedIn: 'strategy/bias.ts buildBias' },
    ],
  },
  {
    title: 'Execution & Trade Management',
    lessons: [
      { topic: 'The Sniper Entry System', summary: 'Top-down: the 4H draw on liquidity sets the side and target, the 15M reaction swing confirms the setup, and the 1M reaction swing times the trigger — only firing above the confluence threshold.', appliedIn: 'strategy/signal.ts generateSignal' },
      { topic: 'Stepping 15M → 1M for the Entry', summary: 'After the 4H sweep, drop to 15M for the reaction swing (HL long / LH short), then to 1M for the next reaction swing to enter on — a tight stop under it, a long runway to the draw.', appliedIn: 'structure.ts lastReactionSwing; signal.ts setup + entry stages' },
      { topic: 'Setting Stop Loss', summary: 'Stop goes just beyond the 1M reaction swing the entry is timed off (its invalidation), plus a small buffer.', appliedIn: 'signal.ts computeStop' },
      { topic: 'Take Profit Strategies', summary: 'Target the draw on liquidity — the 4H resting pool price is pulled toward — falling back to the next PDH/PDL/equal level/opposing swing when no draw is mapped.', appliedIn: 'signal.ts takeProfit / computeTarget' },
      { topic: 'Managing Winning Trades', summary: 'Let winners run to the mapped target; scaling/trailing rules plug in here when you provide them.', appliedIn: 'tradeEngine manageOpenPositions' },
      { topic: 'Managing Losing Trades', summary: 'NEVER move a stop once set. The stop is the trade’s invalidation, full stop.', appliedIn: 'paperBroker keeps stopLoss immutable' },
    ],
  },
  {
    title: 'Trading Psychology',
    lessons: [
      { topic: 'Fear', summary: 'Cutting winners early / skipping valid setups. The fixed process removes the decision.', appliedIn: 'automated confluence gate' },
      { topic: 'Greed', summary: 'Oversizing and moving targets. Fixed risk% and pre-mapped targets prevent it.', appliedIn: 'risk sizing + computeTarget' },
      { topic: 'FOMO', summary: 'Chasing extended moves. Entries require pullback into FVG/discount, not breakouts.', appliedIn: 'signal.ts premium/discount filter' },
      { topic: 'Revenge Trading', summary: 'Trading to "win back" losses. The daily-loss kill switch physically blocks it.', appliedIn: 'riskManager daily kill switch' },
      { topic: 'Overtrading', summary: 'Too many low-quality trades. MAX_OPEN_POSITIONS and confluence minimum throttle activity.', appliedIn: 'config.maxOpenPositions, minConfluence' },
      { topic: 'Discipline, Patience & Thinking Like a Pro', summary: 'Professionals wait for A+ setups and treat trading as a probability business over many trades.', appliedIn: 'high-bar signal generation' },
    ],
  },
  {
    title: 'Trading Journal & Review',
    lessons: [
      { topic: 'Recording Every Trade', summary: 'Every trade is logged with entry, exit, R multiple and outcome.', appliedIn: 'engine/journal.ts record' },
      { topic: 'Reviewing Weekly Performance', summary: 'Weekly PnL, win rate and expectancy reveal whether the edge holds.', appliedIn: 'journal.ts stats + weekPnl' },
      { topic: 'Finding Repeating Mistakes', summary: 'Tag exit reasons (sl/tp/liq/manual) to spot recurring leaks.', appliedIn: 'Trade.reason field' },
      { topic: 'Improving Win Rate', summary: 'Raise confluence / R:R thresholds and cut the setups that statistically lose.', appliedIn: 'tunable config gates' },
    ],
  },
];
