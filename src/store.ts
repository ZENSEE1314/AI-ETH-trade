// Tiny JSON persistence. Each collection is one file under config.dataDir.
// On Railway, mount a volume at that path so data survives redeploys.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';
import { logger } from './logger.js';

function pathFor(name: string): string {
  return join(config.dataDir, `${name}.json`);
}

export function readJson<T>(name: string, fallback: T): T {
  try {
    const file = pathFor(name);
    if (!existsSync(file)) return fallback;
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch (err) {
    logger.warn(`store: failed to read ${name}: ${(err as Error).message}`);
    return fallback;
  }
}

export function writeJson(name: string, data: unknown): void {
  try {
    mkdirSync(config.dataDir, { recursive: true });
    writeFileSync(pathFor(name), JSON.stringify(data, null, 2));
  } catch (err) {
    logger.error(`store: failed to write ${name}: ${(err as Error).message}`);
  }
}
