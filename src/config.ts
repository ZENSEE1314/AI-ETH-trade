import dotenv from 'dotenv';
import type { TradingMode } from './types.js';

dotenv.config();

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function str(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? fallback : raw;
}

const mode = str('TRADING_MODE', 'paper').toLowerCase() === 'live' ? 'live' : 'paper';

const primarySymbol = str('SYMBOL', 'ETHUSDT');

export const config = {
  port: num('PORT', 3000),
  symbol: primarySymbol,
  // Symbols traded by the vwapbandrsi band-fade strategy (comma-separated),
  // regardless of the primary `strategy`. The primary symbol keeps using
  // `strategy` (e.g. the advisor). One position at a time across everything.
  vbrSymbols: Array.from(
    new Set(
      str('VBR_SYMBOLS', '')
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter((s) => s && s !== primarySymbol),
    ),
  ),

  // Symbols traded by the TAD (Turtle/Atom/Duck) breakout strategy, with a
  // direction suffix: `:l` long-only, `:s` short-only, `:ls` both.
  //   TAD_SYMBOLS=BTCUSDT:ls,ETHUSDT:ls,BNBUSDT:l
  // Runs alongside the primary `strategy` and VBR; one position per symbol,
  // capped globally by MAX_OPEN_POSITIONS. Multi-timeframe: 1d→4h→2h→1h, first
  // fresh signal wins.
  tadSymbols: str('TAD_SYMBOLS', ''),

  tradingMode: mode as TradingMode,

  // Risk
  accountEquityUsdt: num('ACCOUNT_EQUITY_USDT', 1000),
  leverage: num('LEVERAGE', 50),
  riskPerTradePct: num('RISK_PER_TRADE_PCT', 1.0),
  // Fixed sizing: commit this % of equity as margin per trade. 0 = risk-based.
  positionSizePct: num('POSITION_SIZE_PCT', 0),
  // Let the LLM advisor decide entries/stops/targets instead of the engine.
  advisorMode: (process.env.ADVISOR_MODE ?? '').toLowerCase() === 'true',
  // Active strategy: 'nwflip' (NW-band breakout — the main, backtest-validated
  // edge, default), 'advisor' (LLM), 'vwapbandrsi' (mechanical long-only band
  // fade), or 'signal' (the built-in draw-on-liquidity engine). Overrides
  // advisorMode when set to something other than 'advisor'.
  strategy: str('STRATEGY', 'nwflip').toLowerCase(),

  // NW-flip strategy: which symbols to trade the breakout on. Walk-forward
  // validation (4 chronological OOS folds, 1y, 1h) found the edge robust on
  // BTC (4/4, PF 1.57) and ETH (4/4, PF 1.50), marginal on SOL (3/4, PF 1.18)
  // and failing on BNB (2/4, PF 0.90 — excluded). BTC+ETH is the main default.
  // One position per symbol+TF, capped by MAX_OPEN_POSITIONS.
  nwFlipSymbols: Array.from(
    new Set(
      str('NWFLIP_SYMBOLS', 'BTCUSDT,ETHUSDT')
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean),
    ),
  ),
  // Which timeframes to trade the breakout on. Only 1h survived walk-forward
  // validation (15m loses; 4h is positive but not cross-validated), so 1h is
  // the default. The UTC entry-hour whitelist defaults to empty (all hours) —
  // hour/day filtering overfit in testing, so the validated config is all-hours.
  nwFlipTfs: str('NWFLIP_TFS', '1h')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  nwFlipHours: str('NWFLIP_HOURS', ''),
  // Fixed position size for NW-flip, as a multiple of equity (notional ÷ equity).
  // Backtest sweep (BTC+ETH 1h): 1× = +132%/28%DD, 2× = +330%/49%DD (the
  // survivable sweet spot), ~5× peaks then over-leverage drag kills it. Margin
  // committed = sizeX ÷ leverage. 0 = fall back to risk-based sizing.
  nwFlipSizeX: num('NWFLIP_SIZE_X', 2),
  // Fixed leverage for NW-flip. Liquidation (~1/lev) must sit beyond the 3% hard
  // stop; 10× liquidates at ~9.5%, safely clear.
  nwFlipLeverage: num('NWFLIP_LEVERAGE', 10),
  // Month-turn blackout: skip the first/last N calendar days (UTC) of each month
  // (month-end/start chop). 0 = off.
  nwFlipMonthEdgeDays: num('NWFLIP_SKIP_MONTH_EDGE_DAYS', 0),

  // Polymarket complete-set bot (PAPER ONLY — it never places real orders).
  // Scans the short "BTC/ETH up or down" markets and, when buying one share of
  // UP plus one of DOWN costs less than $1 after fees, simulates buying the set
  // and collecting the guaranteed $1 at resolution.
  polyEnabled: str('POLY_ENABLED', 'true').toLowerCase() === 'true',
  polyAssets: str('POLY_ASSETS', 'btc,eth')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  polyWindowMin: num('POLY_WINDOW_MIN', 5),
  // Market slug pattern; {asset}, {w} (window minutes) and {start} (window
  // start, unix seconds) are filled in. Change it if Polymarket renames them.
  polySlugTemplate: str('POLY_SLUG_TEMPLATE', '{asset}-updown-{w}m-{start}'),
  polyScanMs: num('POLY_SCAN_MS', 5000),
  polyBankrollUsdc: num('POLY_BANKROLL_USDC', 1000),
  polyMaxUsdcPerWindow: num('POLY_MAX_USDC_PER_WINDOW', 100),
  // Minimum edge per set, in dollars, AFTER fees (0.01 = 1 cent).
  polyMinEdge: num('POLY_MIN_EDGE', 0.01),
  // Assumed taker fee as a % of notional. Polymarket's fee schedule for these
  // markets changes — set this to the current published rate.
  polyFeePct: num('POLY_FEE_PCT', 1.0),
  // Don't open new sets this close to the window's end.
  polyMinSecondsLeft: num('POLY_MIN_SECONDS_LEFT', 20),
  // Kill-switch caps. Raised to fit 2× NW-flip sizing: one 2× trade stopping out
  // at the 3% hard stop loses ~6% of equity, which a 3% daily cap would reject
  // outright. 10%/20% gives the 2× setup room while still halting a bad run.
  maxDailyLossPct: num('MAX_DAILY_LOSS_PCT', 10.0),
  maxWeeklyLossPct: num('MAX_WEEKLY_LOSS_PCT', 20.0),
  minRiskReward: num('MIN_RISK_REWARD', 2.0),
  // Default 2 so the two main NW-flip coins (BTC + ETH) can each hold a
  // position at the same time.
  maxOpenPositions: num('MAX_OPEN_POSITIONS', 2),

  // Strategy
  minConfluence: num('MIN_CONFLUENCE', 60),
  analysisIntervalMs: num('ANALYSIS_INTERVAL_MS', 60000),
  // Entry trigger timeframe: '1m' drills to the 1M reaction swing (tight stop,
  // more trades — often too many after fees); '15m' enters off the 15M HL/LH.
  entryMode: (str('ENTRY_MODE', '1m') === '15m' ? '15m' : '1m') as '1m' | '15m',
  targetMode: (str('TARGET_MODE', 'draw') === 'near' ? 'near' : 'draw') as 'near' | 'draw',
  stopMode: (str('STOP_MODE', 'swing') === 'sweep' ? 'sweep' : 'swing') as 'swing' | 'sweep',

  // Integrations
  webhookSecret: str('WEBHOOK_SECRET', ''),
  bitunixApiKey: str('BITUNIX_API_KEY', ''),
  bitunixApiSecret: str('BITUNIX_API_SECRET', ''),

  // Auth & persistence
  // Signing/encryption key for sessions and stored secrets. MUST be set (and
  // stable) in production, or sessions reset and stored API secrets become
  // unreadable after every restart.
  appSecret: str('APP_SECRET', ''),
  // After the first (bootstrap) account exists, new registrations require this
  // code. Leave blank to allow only the single bootstrap owner to register.
  registrationCode: str('REGISTRATION_CODE', ''),
  // Where users/settings JSON is persisted. On Railway, point a volume here.
  dataDir: str('RAILWAY_VOLUME_MOUNT_PATH', '') || str('DATA_DIR', 'data'),
} as const;
