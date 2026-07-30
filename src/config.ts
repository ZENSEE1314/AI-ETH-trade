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
