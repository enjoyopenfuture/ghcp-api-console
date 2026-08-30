import { startServer } from './server.js';

void startServer().catch((err: unknown) => {
  console.error('[proxy] failed to start', err);
  process.exitCode = 1;
});
