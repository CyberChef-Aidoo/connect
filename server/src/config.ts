import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const DEV_SESSION_SECRET = 'dev-only-session-secret-not-for-lan';

export type HttpsOptions =
  | { pfx: Buffer; passphrase: string }
  | { key: Buffer; cert: Buffer };

export type AppConfig = {
  repoRoot: string;
  host: string;
  port: number;
  storageDir: string;
  databasePath: string;
  maxFileBytes: number;
  maxStorageBytes: number;
  sessionSecret: string;
  sessionTtlMs: number;
  https: HttpsOptions | null;
  staticDir: string | null;
  loginRateLimit: number;
  maxUploadsPerUser: number;
  maxUploadsGlobal: number;
  usingDevSessionSecret: boolean;
  openAccess: boolean;
};

export function repoRootFromHere(metaUrl: string): string {
  return path.resolve(path.dirname(fileURLToPath(metaUrl)), '../..');
}

export function loadConfig(metaUrl = import.meta.url): AppConfig {
  const repoRoot = repoRootFromHere(metaUrl);
  dotenv.config({ path: path.join(repoRoot, '.env') });
  return resolveConfig(process.env, repoRoot);
}

export function resolveConfig(env: NodeJS.ProcessEnv, repoRoot: string): AppConfig {
  const host = readString(env, 'HOST') || '127.0.0.1';
  const port = readInteger(env, 'PORT', 3000);
  if (port < 1 || port > 65535) {
    throw new Error('PORT must be between 1 and 65535.');
  }

  const storageDir = resolvePath(repoRoot, readString(env, 'STORAGE_DIR') || 'data/storage');
  const databasePath = resolvePath(repoRoot, readString(env, 'DATABASE_PATH') || 'data/app.db');
  const maxFileBytes = readInteger(env, 'MAX_FILE_BYTES', 2 * 1024 * 1024 * 1024);
  const maxStorageBytes = readInteger(env, 'MAX_STORAGE_BYTES', 50 * 1024 * 1024 * 1024);
  if (maxFileBytes < 1) throw new Error('MAX_FILE_BYTES must be at least 1.');
  if (maxStorageBytes < maxFileBytes) {
    throw new Error('MAX_STORAGE_BYTES must be at least MAX_FILE_BYTES.');
  }

  const ttlHours = readInteger(env, 'SESSION_TTL_HOURS', 12);
  if (ttlHours < 1 || ttlHours > 168) {
    throw new Error('SESSION_TTL_HOURS must be between 1 and 168.');
  }

  const loopback = isLoopback(host);
  const configuredSecret = readString(env, 'SESSION_SECRET');
  if (!configuredSecret && !loopback) {
    throw new Error('Set SESSION_SECRET in .env before listening on a network address.');
  }
  const usingDevSessionSecret = !configuredSecret;
  const sessionSecret = configuredSecret || DEV_SESSION_SECRET;

  const https = readHttps(env, repoRoot);
  assertStorageIsPrivate(repoRoot, storageDir);

  const staticOverride = readString(env, 'STATIC_DIR');
  const staticDir = staticOverride
    ? resolvePath(repoRoot, staticOverride)
    : path.join(repoRoot, 'client', 'dist');

  return {
    repoRoot,
    host,
    port,
    storageDir,
    databasePath,
    maxFileBytes,
    maxStorageBytes,
    sessionSecret,
    sessionTtlMs: ttlHours * 60 * 60 * 1000,
    https,
    staticDir,
    loginRateLimit: 20,
    maxUploadsPerUser: 3,
    maxUploadsGlobal: 8,
    usingDevSessionSecret,
    openAccess: readFlag(env, 'OPEN_ACCESS'),
  };
}

export function assertBindSafety(config: AppConfig): void {
  if (!isLoopback(config.host) && !config.https) {
    throw new Error(
      'Refusing to listen on a network address without HTTPS. Create a certificate and set HTTPS_PFX_PATH, or use HOST=127.0.0.1 for development on this computer only.',
    );
  }
  if (!isLoopback(config.host) && config.usingDevSessionSecret) {
    throw new Error('Set SESSION_SECRET in .env before listening on a network address.');
  }
}

export function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

function readHttps(env: NodeJS.ProcessEnv, repoRoot: string): HttpsOptions | null {
  const pfxPath = readString(env, 'HTTPS_PFX_PATH');
  const keyPath = readString(env, 'HTTPS_KEY_PATH');
  const certPath = readString(env, 'HTTPS_CERT_PATH');
  if (pfxPath && (keyPath || certPath)) {
    throw new Error('Set either HTTPS_PFX_PATH or the PEM pair HTTPS_KEY_PATH and HTTPS_CERT_PATH, not both.');
  }
  if (pfxPath) {
    const passphrase = env.HTTPS_PFX_PASSPHRASE ?? '';
    if (!passphrase) {
      throw new Error('Set HTTPS_PFX_PASSPHRASE for the certificate file.');
    }
    return { pfx: readRequiredFile(resolvePath(repoRoot, pfxPath), 'HTTPS_PFX_PATH'), passphrase };
  }
  if (keyPath || certPath) {
    if (!keyPath || !certPath) {
      throw new Error('Set both HTTPS_KEY_PATH and HTTPS_CERT_PATH.');
    }
    return {
      key: readRequiredFile(resolvePath(repoRoot, keyPath), 'HTTPS_KEY_PATH'),
      cert: readRequiredFile(resolvePath(repoRoot, certPath), 'HTTPS_CERT_PATH'),
    };
  }
  return null;
}

function assertStorageIsPrivate(repoRoot: string, storageDir: string): void {
  const forbidden = [
    path.join(repoRoot, 'client', 'dist'),
    path.join(repoRoot, 'client', 'public'),
    path.join(repoRoot, 'server', 'dist'),
  ];
  for (const root of forbidden) {
    if (isInside(root, storageDir) || isInside(storageDir, root)) {
      throw new Error('STORAGE_DIR must be outside the website folders (client/dist, client/public, and server/dist).');
    }
  }
}

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function resolvePath(repoRoot: string, value: string): string {
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(repoRoot, value);
}

function readRequiredFile(filePath: string, label: string): Buffer {
  if (!existsSync(filePath)) {
    throw new Error(`${label} does not exist: ${filePath}`);
  }
  return readFileSync(filePath);
}

function readFlag(env: NodeJS.ProcessEnv, key: string): boolean {
  const value = readString(env, key).toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

function readString(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  return typeof value === 'string' ? value.trim() : '';
}

function readInteger(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = readString(env, key);
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${key} must be a whole number.`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${key} is too large.`);
  }
  return value;
}
