// Health monitor: the bot watching itself. Every minute it runs a set of
// checks against the engine, the Polymarket bot and the log. Results are shown
// on the dashboard (HEALTH agent card, /api/health). When a check stays failed
// for HEALTH_ALERT_MIN minutes and GITHUB_TOKEN/GITHUB_REPO are set, it opens a
// GitHub issue labelled `bot-health` (one per check); a scheduled Claude routine
// watches that label and opens a fix PR. The issue is commented on at most
// hourly while the failure lasts and closed after 30 minutes of recovery.
//
// Issue bodies carry log lines and state numbers only — never config values,
// keys or tokens.

import { config } from '../config.js';
import { logger } from '../logger.js';
import { engine } from '../engine/tradeEngine.js';
import { polyBot } from '../polymarket/bot.js';

export type HealthLevel = 'ok' | 'warn' | 'fail';

export interface HealthCheck {
  id: string;
  name: string;
  level: HealthLevel;
  message: string;
  since: number; // when it entered its current level
}

export interface HealthState {
  checkedAt: number;
  overall: HealthLevel;
  checks: HealthCheck[];
  github: { enabled: boolean; repo: string; lastError: string; openIssues: Record<string, number> };
}

const CHECK_MS = 60_000;
const STARTUP_GRACE_MS = 5 * 60_000; // let the first cycles and API calls land
const WINDOW_MS = 15 * 60_000; // log look-back for error counts
const COMMENT_EVERY_MS = 60 * 60_000;
const CLOSE_AFTER_OK_MS = 30 * 60_000;
const LABEL = 'bot-health';

type Result = Omit<HealthCheck, 'since'>;

function runChecks(now: number): Result[] {
  const s = engine.state();
  const p = polyBot.state();
  const logs = logger.recent().filter((l) => l.time >= now - WINDOW_MS);
  const warming = now - s.startedAt < STARTUP_GRACE_MS;
  const out: Result[] = [];

  // Engine loop alive.
  const stallMs = Math.max(5 * config.analysisIntervalMs, 5 * 60_000);
  const since = s.lastCycleAt || s.startedAt;
  out.push(
    !s.running
      ? { id: 'engine-stalled', name: 'Engine loop', level: 'fail', message: 'engine is not running' }
      : !warming && now - since > stallMs
      ? {
          id: 'engine-stalled',
          name: 'Engine loop',
          level: 'fail',
          message: s.lastCycleAt
            ? `no completed cycle for ${Math.round((now - since) / 60_000)} min (${s.cycles} cycles total)`
            : 'no cycle has completed since start',
        }
      : { id: 'engine-stalled', name: 'Engine loop', level: 'ok', message: `${s.cycles} cycles` },
  );

  // Cycle errors.
  const cycleErrs = logs.filter((l) => l.level === 'error' && l.msg.startsWith('Cycle error'));
  out.push({
    id: 'cycle-errors',
    name: 'Cycle errors',
    level: cycleErrs.length >= 3 ? 'fail' : cycleErrs.length ? 'warn' : 'ok',
    message: cycleErrs.length ? `${cycleErrs.length} in 15 min — last: ${cycleErrs[0].msg}` : 'none in 15 min',
  });

  // Market data.
  const candles = engine.getCandles();
  const lastBar = candles.length ? candles[candles.length - 1].time : 0;
  const barAgeMin = lastBar ? (now - lastBar) / 60_000 : Infinity;
  out.push(
    warming
      ? { id: 'market-data', name: 'Market data', level: 'ok', message: 'warming up' }
      : !(s.lastPrice > 0) || !candles.length
      ? { id: 'market-data', name: 'Market data', level: 'fail', message: 'no price / candles from the feed' }
      : barAgeMin > 60
      ? { id: 'market-data', name: 'Market data', level: 'fail', message: `latest 15m bar is ${Math.round(barAgeMin)} min old` }
      : { id: 'market-data', name: 'Market data', level: 'ok', message: `${s.symbol} ${s.lastPrice}` },
  );

  // Signals that never get through — the "why didn't it trade" failure.
  const recent = s.recentSignals.filter((x) => x.time >= now - 24 * 3_600_000);
  const rejected = recent.filter((x) => x.rejectReason);
  const killed = s.killSwitch.daily || s.killSwitch.weekly;
  if (recent.length >= 8 && rejected.length === recent.length && !killed) {
    const hist = new Map<string, number>();
    for (const x of rejected) {
      const r = (x.rejectReason ?? '').replace(/[\d.]+/g, '#').slice(0, 80);
      hist.set(r, (hist.get(r) ?? 0) + 1);
    }
    const top = [...hist.entries()].sort((a, b) => b[1] - a[1]).map(([r, n]) => `${n}× ${r}`).join('; ');
    out.push({
      id: 'signals-rejected',
      name: 'Signal approvals',
      level: 'fail',
      message: `all ${recent.length} signals in 24h rejected by risk: ${top}`,
    });
  } else {
    out.push({
      id: 'signals-rejected',
      name: 'Signal approvals',
      level: recent.length && rejected.length === recent.length ? 'warn' : 'ok',
      message: `${recent.length - rejected.length}/${recent.length} approved in 24h`,
    });
  }

  // Kill switch — working as designed, so a warning, not an alert.
  out.push({
    id: 'kill-switch',
    name: 'Kill switch',
    level: killed ? 'warn' : 'ok',
    message: s.killSwitch.reason,
  });

  // Polymarket feed.
  if (p.enabled) {
    const downMs = now - (p.lastOkAt || s.startedAt);
    out.push(
      p.lastError && downMs > 30 * 60_000
        ? { id: 'polymarket', name: 'Polymarket feed', level: 'fail', message: `failing for ${Math.round(downMs / 60_000)} min: ${p.lastError}` }
        : p.lastError
        ? { id: 'polymarket', name: 'Polymarket feed', level: 'warn', message: p.lastError }
        : { id: 'polymarket', name: 'Polymarket feed', level: 'ok', message: `${p.quotes.length} live quotes` },
    );
  }

  // Overall error rate (anything logged at error level).
  const errs = logs.filter((l) => l.level === 'error');
  out.push({
    id: 'error-rate',
    name: 'Error log',
    level: errs.length >= 10 ? 'fail' : errs.length >= 3 ? 'warn' : 'ok',
    message: `${errs.length} errors in 15 min`,
  });

  // Live mode asked for but not possible (missing keys etc.).
  if (s.mode === 'live' && !s.liveEnabled) {
    out.push({ id: 'live-blocked', name: 'Live trading', level: 'fail', message: 'mode is live but live trading is not enabled (keys / LIVE_TRADING)' });
  }

  return out;
}

// --- GitHub reporter ------------------------------------------------------

async function gh(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`https://api.github.com/repos/${config.githubRepo}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${config.githubToken}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'ai-eth-trade-health',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`GitHub ${method} ${path}: ${res.status} ${res.statusText}`);
  return res.status === 204 ? null : res.json();
}

function marker(id: string): string {
  return `<!-- bot-health:${id} -->`;
}

function context(check: HealthCheck): string {
  const s = engine.state();
  const p = polyBot.state();
  const logs = logger
    .recent()
    .filter((l) => l.level === 'error' || l.level === 'warn')
    .slice(0, 25)
    .map((l) => `${new Date(l.time).toISOString()} ${l.level.toUpperCase()} ${l.msg}`)
    .join('\n')
    .replace(/`{3,}/g, "'''");
  const sigs = s.recentSignals
    .slice(0, 10)
    .map((x) => `- ${new Date(x.time).toISOString()} ${x.symbol} ${x.side} @ ${x.entry} → ${x.rejectReason ? `REJECTED: ${x.rejectReason}` : 'approved'}`)
    .join('\n');
  return [
    `**Check:** \`${check.id}\` (${check.name}) — **${check.level.toUpperCase()}** since ${new Date(check.since).toISOString()}`,
    `**Message:** ${check.message}`,
    '',
    `**Commit:** \`${process.env.RAILWAY_GIT_COMMIT_SHA ?? 'unknown'}\` · strategy \`${s.strategy}\` · mode \`${s.mode}\` · ${s.symbol} ${s.lastPrice}`,
    `cycles ${s.cycles}, last cycle ${s.lastCycleAt ? new Date(s.lastCycleAt).toISOString() : 'never'}, open positions ${s.openPositions.length}, equity ${s.equity}, kill switch: ${s.killSwitch.reason}`,
    `last scan: ${s.lastScan || '—'}`,
    `polymarket: ${p.enabled ? (p.lastError || 'ok') : 'disabled'}`,
    '',
    '<details><summary>Recent signals</summary>\n\n' + (sigs || '_none_') + '\n</details>',
    '',
    '<details><summary>Recent warn/error log</summary>\n\n```\n' + (logs || 'none') + '\n```\n</details>',
  ].join('\n');
}

class HealthMonitor {
  private checks = new Map<string, HealthCheck>();
  private okSince = new Map<string, number>();
  private issues = new Map<string, number>(); // check id → open issue number
  private lastComment = new Map<string, number>();
  private ghLoaded = false;
  private ghError = '';
  private checkedAt = 0;
  private timer: NodeJS.Timeout | null = null;
  private busy = false;

  start(): void {
    if (this.timer) return;
    const gh = this.ghEnabled() ? `alerts → GitHub issues on ${config.githubRepo}` : 'dashboard only (set GITHUB_TOKEN + GITHUB_REPO for alerts)';
    logger.info(`Health monitor started — ${gh}.`);
    this.timer = setInterval(() => void this.tick(), CHECK_MS);
    void this.tick();
  }

  private ghEnabled(): boolean {
    return Boolean(config.githubToken && /^[\w.-]+\/[\w.-]+$/.test(config.githubRepo));
  }

  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const now = Date.now();
      for (const r of runChecks(now)) {
        const prev = this.checks.get(r.id);
        const since = prev && prev.level === r.level ? prev.since : now;
        if (prev && prev.level !== r.level && r.level !== 'ok') {
          logger.warn(`HEALTH ${r.name}: ${r.level.toUpperCase()} — ${r.message}`);
        }
        if (r.level === 'ok' && !this.okSince.has(r.id)) this.okSince.set(r.id, now);
        if (r.level !== 'ok') this.okSince.delete(r.id);
        this.checks.set(r.id, { ...r, since });
      }
      this.checkedAt = now;
      if (this.ghEnabled()) await this.report(now);
    } catch (err) {
      this.ghError = (err as Error).message;
      logger.warn(`Health monitor: ${this.ghError}`);
    } finally {
      this.busy = false;
    }
  }

  /** Re-attach to issues opened before a restart so we don't duplicate them. */
  private async loadIssues(): Promise<void> {
    if (this.ghLoaded) return;
    const list = (await gh('GET', `/issues?state=open&labels=${LABEL}&per_page=100`)) as { number: number; body?: string; pull_request?: unknown }[];
    for (const i of list) {
      if (i.pull_request) continue;
      const m = /<!-- bot-health:([\w-]+) -->/.exec(i.body ?? '');
      if (m) this.issues.set(m[1], i.number);
    }
    this.ghLoaded = true;
  }

  private async report(now: number): Promise<void> {
    await this.loadIssues();
    const alertMs = Math.max(1, config.healthAlertMin) * 60_000;
    for (const c of this.checks.values()) {
      const num = this.issues.get(c.id);
      if (c.level === 'fail' && now - c.since >= alertMs) {
        if (!num) {
          const issue = await gh('POST', '/issues', {
            title: `[bot-health] ${c.name}: ${c.message}`.slice(0, 200),
            labels: [LABEL],
            body:
              `${marker(c.id)}\nThe trading bot's health monitor flagged a failure that has lasted ${Math.round((now - c.since) / 60_000)} min.\n\n` +
              context(c) +
              '\n\n_Opened automatically by the health monitor. It will be closed automatically after 30 min of recovery._',
          });
          this.issues.set(c.id, issue.number);
          this.lastComment.set(c.id, now);
          logger.warn(`HEALTH opened GitHub issue #${issue.number} for ${c.id}`);
        } else if (now - (this.lastComment.get(c.id) ?? 0) >= COMMENT_EVERY_MS) {
          await gh('POST', `/issues/${num}/comments`, { body: `Still failing.\n\n${context(c)}` });
          this.lastComment.set(c.id, now);
        }
      } else if (num && c.level === 'ok' && now - (this.okSince.get(c.id) ?? now) >= CLOSE_AFTER_OK_MS) {
        await gh('POST', `/issues/${num}/comments`, { body: `Recovered — \`${c.id}\` has been OK for 30 min (${c.message}). Closing.` });
        await gh('PATCH', `/issues/${num}`, { state: 'closed', state_reason: 'completed' });
        this.issues.delete(c.id);
        logger.info(`HEALTH closed GitHub issue #${num} (${c.id} recovered)`);
      }
    }
    this.ghError = '';
  }

  state(): HealthState {
    const checks = [...this.checks.values()];
    const overall: HealthLevel = checks.some((c) => c.level === 'fail') ? 'fail' : checks.some((c) => c.level === 'warn') ? 'warn' : 'ok';
    return {
      checkedAt: this.checkedAt,
      overall,
      checks,
      github: {
        enabled: this.ghEnabled(),
        repo: this.ghEnabled() ? config.githubRepo : '',
        lastError: this.ghError,
        openIssues: Object.fromEntries(this.issues),
      },
    };
  }
}

export const healthMonitor = new HealthMonitor();
