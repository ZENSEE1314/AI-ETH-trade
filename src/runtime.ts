// Runtime settings: the single source of truth for trading config that can
// change at runtime (via the Settings UI). Seeded from env/config, then
// overlaid with anything persisted, and updatable while the server runs.

import type { TradingMode } from './types.js';
import { config } from './config.js';
import { readJson, writeJson } from './store.js';
import { encryptSecret, decryptSecret } from './auth/crypto.js';
import { logger } from './logger.js';

interface StoredSettings {
  tradingMode: TradingMode;
  apiKey: string;
  apiSecretEnc: string; // AES-GCM encrypted
  leverage: number;
  riskPerTradePct: number;
  maxDailyLossPct: number;
  minConfluence: number;
  accountEquityUsdt: number;
}

// In-memory effective settings (apiSecret held decrypted for signing requests).
export const runtime = {
  tradingMode: config.tradingMode as TradingMode,
  apiKey: config.bitunixApiKey,
  apiSecret: config.bitunixApiSecret,
  leverage: config.leverage,
  riskPerTradePct: config.riskPerTradePct,
  maxDailyLossPct: config.maxDailyLossPct,
  minConfluence: config.minConfluence,
  minRiskReward: config.minRiskReward, // learnable gate (see learning/)
  accountEquityUsdt: config.accountEquityUsdt,
};

export function canTradeLive(): boolean {
  return runtime.tradingMode === 'live' && !!runtime.apiKey && !!runtime.apiSecret;
}

/** Load persisted settings over the env-derived defaults. Call once at boot. */
export function loadSettings(): void {
  const s = readJson<StoredSettings | null>('settings', null);
  if (!s) return;
  runtime.tradingMode = s.tradingMode === 'live' ? 'live' : 'paper';
  runtime.apiKey = s.apiKey ?? runtime.apiKey;
  runtime.apiSecret = s.apiSecretEnc ? decryptSecret(s.apiSecretEnc) : runtime.apiSecret;
  runtime.leverage = pos(s.leverage, runtime.leverage);
  runtime.riskPerTradePct = pos(s.riskPerTradePct, runtime.riskPerTradePct);
  runtime.maxDailyLossPct = pos(s.maxDailyLossPct, runtime.maxDailyLossPct);
  runtime.minConfluence = pos(s.minConfluence, runtime.minConfluence);
  runtime.accountEquityUsdt = pos(s.accountEquityUsdt, runtime.accountEquityUsdt);
  logger.info(`Settings loaded (mode=${runtime.tradingMode}, apiKey=${runtime.apiKey ? 'set' : 'unset'}).`);
}

export interface SettingsUpdate {
  tradingMode?: TradingMode;
  apiKey?: string;
  apiSecret?: string; // plaintext from the form; blank = leave unchanged
  leverage?: number;
  riskPerTradePct?: number;
  maxDailyLossPct?: number;
  minConfluence?: number;
  accountEquityUsdt?: number;
}

/** Apply a settings update from the UI and persist it. */
export function updateSettings(u: SettingsUpdate): void {
  if (u.tradingMode) runtime.tradingMode = u.tradingMode === 'live' ? 'live' : 'paper';
  if (u.apiKey !== undefined) runtime.apiKey = u.apiKey.trim();
  if (u.apiSecret) runtime.apiSecret = u.apiSecret.trim(); // only overwrite if provided
  if (u.leverage !== undefined) runtime.leverage = pos(u.leverage, runtime.leverage);
  if (u.riskPerTradePct !== undefined) runtime.riskPerTradePct = pos(u.riskPerTradePct, runtime.riskPerTradePct);
  if (u.maxDailyLossPct !== undefined) runtime.maxDailyLossPct = pos(u.maxDailyLossPct, runtime.maxDailyLossPct);
  if (u.minConfluence !== undefined) runtime.minConfluence = clamp(u.minConfluence, 0, 100, runtime.minConfluence);
  if (u.accountEquityUsdt !== undefined) runtime.accountEquityUsdt = pos(u.accountEquityUsdt, runtime.accountEquityUsdt);
  persist();
  logger.info(`Settings updated (mode=${runtime.tradingMode}, live=${canTradeLive()}).`);
}

/** Masked, secret-free view for the client. */
export function publicSettings() {
  return {
    tradingMode: runtime.tradingMode,
    liveEnabled: canTradeLive(),
    apiKeyMasked: mask(runtime.apiKey),
    apiSecretSet: !!runtime.apiSecret,
    leverage: runtime.leverage,
    riskPerTradePct: runtime.riskPerTradePct,
    maxDailyLossPct: runtime.maxDailyLossPct,
    minConfluence: runtime.minConfluence,
    accountEquityUsdt: runtime.accountEquityUsdt,
  };
}

function persist(): void {
  const stored: StoredSettings = {
    tradingMode: runtime.tradingMode,
    apiKey: runtime.apiKey,
    apiSecretEnc: runtime.apiSecret ? encryptSecret(runtime.apiSecret) : '',
    leverage: runtime.leverage,
    riskPerTradePct: runtime.riskPerTradePct,
    maxDailyLossPct: runtime.maxDailyLossPct,
    minConfluence: runtime.minConfluence,
    accountEquityUsdt: runtime.accountEquityUsdt,
  };
  writeJson('settings', stored);
}

function mask(v: string): string {
  if (!v) return '';
  if (v.length <= 6) return '••••';
  return `${v.slice(0, 3)}••••${v.slice(-3)}`;
}

function pos(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function clamp(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}
