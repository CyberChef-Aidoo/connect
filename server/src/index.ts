import http from 'node:http';
import https from 'node:https';
import { assertBindSafety, isLoopback, loadConfig } from './config.js';
import { createApp } from './app.js';
import { formatBytes } from './format.js';
import { reconcileStorage } from './reconcile.js';

const config = loadConfig();
assertBindSafety(config);

const handle = await createApp(config);
const recovery = await reconcileStorage(handle.db, config.storageDir);
console.log(
  `Recovery: published ${recovery.publishedInterrupted}, removed incomplete ${recovery.removedIncomplete}, missing ${recovery.removedMissing}, corrupt ${recovery.removedCorrupt}, orphans ${recovery.removedOrphans}, temp ${recovery.removedTemp}.`,
);

const server = config.https
  ? https.createServer(config.https, handle.app)
  : http.createServer(handle.app);

server.requestTimeout = 2 * 60 * 60 * 1000;
server.headersTimeout = 60 * 1000;
server.timeout = 0;

server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${config.port} is already in use. Choose another PORT in .env or stop the other program.`);
  } else {
    console.error(`The server could not start (${error.code ?? 'unknown'}).`);
  }
  handle.close();
  process.exit(1);
});

server.listen(config.port, config.host, () => {
  const scheme = config.https ? 'https' : 'http';
  console.log(`File portal listening on ${scheme}://${config.host}:${config.port}`);
  console.log(`Storage: ${config.storageDir}`);
  console.log(`Database: ${config.databasePath}`);
  console.log(`Limits: ${formatBytes(config.maxFileBytes)} per file, ${formatBytes(config.maxStorageBytes)} total.`);
  if (config.usingDevSessionSecret) {
    console.log('Set SESSION_SECRET in .env before other computers use this portal.');
  }
  if (isLoopback(config.host)) {
    console.log('This address accepts connections only from this computer.');
  } else {
    console.log('Other computers on this network can connect to this PC’s LAN address on the same port.');
  }
});

function shutdown(): void {
  server.close(() => {
    handle.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
