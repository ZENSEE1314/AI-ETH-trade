// HTTP server: dashboard, JSON API, TradingView webhook, and an SSE stream.

import express, { type Request, type Response, type NextFunction } from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { config, canTradeLive } from './config.js';
import { logger } from './logger.js';
import { engine } from './engine/tradeEngine.js';
import { parseTradingViewAlert, WebhookError } from './webhooks/tradingview.js';
import { CURRICULUM, PHILOSOPHY } from './knowledge/curriculum.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, '..', 'public');

const app = express();
app.use(express.json({ limit: '64kb' }));
// TradingView sometimes posts text/plain; accept raw and JSON-parse ourselves.
app.use(express.text({ type: ['text/plain', 'text/*'] }));

// --- Optional dashboard/API auth ------------------------------------------
function requireDashboardAuth(req: Request, res: Response, next: NextFunction): void {
  if (!config.dashboardToken) return next();
  const token = req.header('x-dashboard-token') ?? (req.query.token as string | undefined);
  if (token === config.dashboardToken) return next();
  res.status(401).json({ error: 'unauthorized' });
}

// --- Health & static ------------------------------------------------------
app.get('/healthz', (_req, res) => res.json({ ok: true, mode: config.tradingMode, live: canTradeLive }));

// --- JSON API -------------------------------------------------------------
app.get('/api/state', requireDashboardAuth, (_req, res) => res.json(engine.state()));
app.get('/api/journal', requireDashboardAuth, (_req, res) => res.json(engine.getJournal()));
app.get('/api/logs', requireDashboardAuth, (_req, res) => res.json(logger.recent()));
app.get('/api/curriculum', requireDashboardAuth, (_req, res) =>
  res.json({ philosophy: PHILOSOPHY, modules: CURRICULUM }),
);

app.post('/api/close/:id', requireDashboardAuth, (req, res) => {
  const ok = engine.closePositionManually(req.params.id);
  res.status(ok ? 200 : 404).json({ ok });
});

// --- Server-Sent Events for live dashboard updates ------------------------
app.get('/api/stream', requireDashboardAuth, (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send('update', engine.state());

  const onUpdate = (s: unknown) => send('update', s);
  const onSignal = (s: unknown) => send('signal', s);
  const onTrade = (t: unknown) => send('trade', t);
  engine.on('update', onUpdate);
  engine.on('signal', onSignal);
  engine.on('trade', onTrade);

  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(ping);
    engine.off('update', onUpdate);
    engine.off('signal', onSignal);
    engine.off('trade', onTrade);
  });
});

// --- TradingView webhook --------------------------------------------------
app.post('/webhook/tradingview', (req, res) => {
  try {
    const raw = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body;
    const signal = parseTradingViewAlert(raw);
    logger.info(`Webhook signal received: ${signal.side} ${signal.symbol} @ ${signal.entry}`);
    engine.processSignal(signal);
    res.json({ ok: true, id: signal.id });
  } catch (err) {
    const status = err instanceof WebhookError ? 400 : 500;
    logger.warn(`Webhook rejected: ${(err as Error).message}`);
    res.status(status).json({ ok: false, error: (err as Error).message });
  }
});

app.use(express.static(publicDir));
app.get('/', (_req, res) => res.sendFile(join(publicDir, 'index.html')));

app.listen(config.port, () => {
  logger.info(`AI-ETH-trade listening on :${config.port} (${config.tradingMode} mode)`);
  if (!canTradeLive && config.tradingMode === 'live') {
    logger.warn('TRADING_MODE=live but Bitunix credentials are missing — staying in paper mode.');
  }
  engine.start();
});
