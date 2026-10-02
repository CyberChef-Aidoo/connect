import session from 'express-session';
import type { DatabaseSync } from 'node:sqlite';

type StoredSession = session.SessionData;

export class SqliteSessionStore extends session.Store {
  constructor(private readonly db: DatabaseSync) {
    super();
  }

  get(sid: string, callback: (err: unknown, sess?: StoredSession | null) => void): void {
    try {
      const row = this.db.prepare(
        'SELECT sess, expired FROM sessions WHERE sid = ?',
      ).get(sid) as { sess: string; expired: number } | undefined;
      if (!row || row.expired <= Date.now()) {
        if (row) this.db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
        callback(null, null);
        return;
      }
      callback(null, JSON.parse(row.sess) as StoredSession);
    } catch (error) {
      callback(error);
    }
  }

  set(sid: string, sess: StoredSession, callback?: (err?: unknown) => void): void {
    try {
      this.db.prepare(`
        INSERT INTO sessions (sid, sess, expired) VALUES (?, ?, ?)
        ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expired = excluded.expired
      `).run(sid, JSON.stringify(sess), expiryMs(sess));
      callback?.();
    } catch (error) {
      callback?.(error);
    }
  }

  destroy(sid: string, callback?: (err?: unknown) => void): void {
    try {
      this.db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
      callback?.();
    } catch (error) {
      callback?.(error);
    }
  }

  touch(sid: string, sess: StoredSession, callback?: (err?: unknown) => void): void {
    this.set(sid, sess, callback);
  }

  clearExpired(): void {
    this.db.prepare('DELETE FROM sessions WHERE expired <= ?').run(Date.now());
  }
}

function expiryMs(sess: StoredSession): number {
  const raw = sess.cookie?.expires;
  if (raw) {
    const time = new Date(raw).getTime();
    if (Number.isFinite(time)) return time;
  }
  if (typeof sess.cookie?.originalMaxAge === 'number') {
    return Date.now() + sess.cookie.originalMaxAge;
  }
  return Date.now() + 12 * 60 * 60 * 1000;
}
