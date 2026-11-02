import { config as dotenv } from 'dotenv';
import { resolve } from 'node:path';
import { readConfig } from './config.js';
import { createApp } from './app.js';

try {
  dotenv({ path: process.env.KIS_ENV_FILE || resolve(process.cwd(), '.env'), quiet: true });
  const config = readConfig(process.env);
  const app = await createApp(config);
  const host = process.env.HOST || '127.0.0.1';
  const port = Number(process.env.PORT || 5197);
  await app.listen({ host, port });
  console.log(`Click Trader: http://${host}:${port} (server-side KIS credentials, password locked)`);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { void app.close().then(() => process.exit(0)); });
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Server startup failed'); process.exitCode = 1;
}
