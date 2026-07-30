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

export const config = {
  port: num('PORT', 3000),
  symbol: str('SYMBOL', 'ETHUSDT'),

  tradingMode: mode as TradingMode,

  // Risk
  accountEquityUsdt: num('ACCOUNT_EQUITY_USDT', 1000),
  leverage: num('LEVERAGE', 50),
  riskPerTradePct: num('RISK_PER_TRADE_PCT', 1.0),
  maxDailyLossPct: num('MAX_DAILY_LOSS_PCT', 3.0),
  maxWeeklyLossPct: num('MAX_WEEKLY_LOSS_PCT', 8.0),
  minRiskReward: num('MIN_RISK_REWARD', 2.0),
  maxOpenPositions: num('MAX_OPEN_POSITIONS', 1),

  // Strategy
  minConfluence: num('MIN_CONFLUENCE', 60),
  analysisIntervalMs: num('ANALYSIS_INTERVAL_MS', 60000),

  // Integrations / auth
  webhookSecret: str('WEBHOOK_SECRET', ''),
  dashboardToken: str('DASHBOARD_TOKEN', ''),
  bitunixApiKey: str('BITUNIX_API_KEY', ''),
  bitunixApiSecret: str('BITUNIX_API_SECRET', ''),
} as const;

/** True only when live mode is requested AND credentials are present. */
export const canTradeLive =
  config.tradingMode === 'live' && !!config.bitunixApiKey && !!config.bitunixApiSecret;
