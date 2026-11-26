import crypto from 'node:crypto';
import type { Firestore } from 'firebase-admin/firestore';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';

export const REPLAY_GUARDS_COLLECTION = 'replayGuards';

export interface ReplayConsumeResult {
  fresh: boolean;
  reason?: 'invalid_key' | 'replay_detected';
  keyHash?: string;
  expiresAtMs?: number;
}

/**
 * Minimal Firestore transactional interface so replay protection works against
 * real Firebase Admin Firestore and deterministic transactional test harnesses.
 */
export interface ReplayFirestoreAdapter {
  isConsumedInStore?(params: {
    keyHash: string;
    nowMs: number;
  }): Promise<boolean>;
  consumeInTransaction(params: {
    keyHash: string;
    scope: string;
    nowMs: number;
    ttlMs: number;
  }): Promise<boolean>;
  cleanupExpired(nowMs: number, maxDeletes: number): Promise<number>;
}

export function hashReplayKey(scope: string, rawKey: string): string {
  return crypto
    .createHash('sha256')
    .update(`${scope}:${rawKey}`)
    .digest('hex');
}

export function createFirestoreReplayAdapter(db: Firestore): ReplayFirestoreAdapter {
  const col = db.collection(REPLAY_GUARDS_COLLECTION);

  return {
    async isConsumedInStore({ keyHash, nowMs }): Promise<boolean> {
      const snap = await col.doc(keyHash).get();
      if (!snap.exists) return false;
      const existingExpiresAtMs = Number(snap.get('expiresAtMs') ?? 0);
      return existingExpiresAtMs >= nowMs;
    },

    async consumeInTransaction({ keyHash, scope, nowMs, ttlMs }): Promise<boolean> {
      const docRef = col.doc(keyHash);
      return await db.runTransaction(async (tx) => {
        const snap = await tx.get(docRef);
        if (snap.exists) {
          const existingExpiresAtMs = Number(snap.get('expiresAtMs') ?? 0);
          if (existingExpiresAtMs >= nowMs) {
            return false;
          }
        }

        const expiresAtMs = nowMs + ttlMs;
        tx.set(docRef, {
          keyHash,
          scope,
          expiresAtMs,
          expireAt: Timestamp.fromMillis(expiresAtMs),
          createdAt: FieldValue.serverTimestamp(),
        });
        return true;
      });
    },

    async cleanupExpired(nowMs: number, maxDeletes: number): Promise<number> {
      const expiredSnap = await col
        .where('expiresAtMs', '<', nowMs)
        .limit(Math.max(1, Math.min(200, maxDeletes)))
        .get();

      if (expiredSnap.empty) {
        return 0;
      }

      const batch = db.batch();
      for (const docSnap of expiredSnap.docs) {
        batch.delete(docSnap.ref);
      }
      await batch.commit();
      return expiredSnap.size;
    },
  };
}

/**
 * Persistent Firestore-backed replay protection for Telegram initData hashes,
 * Telegram Bot update_ids, and game action nonces across Vercel serverless instances.
 */
export class PersistentReplayGuard {
  private readonly adapter: ReplayFirestoreAdapter;
  private readonly defaultTtlSeconds: number;

  constructor(adapter: ReplayFirestoreAdapter, defaultTtlSeconds = 3600) {
    this.adapter = adapter;
    this.defaultTtlSeconds = defaultTtlSeconds;
  }

  public async isConsumed(
    scope: 'init_data' | 'tg_update' | 'tg_cb' | 'game_draw' | 'card_tx' | 'bot_action_dedup' | 'custom',
    rawKey: string,
    options: {
      nowUnixSeconds?: number;
    } = {}
  ): Promise<boolean> {
    if (!rawKey || rawKey.trim() === '' || typeof this.adapter.isConsumedInStore !== 'function') {
      return false;
    }
    const nowMs =
      typeof options.nowUnixSeconds === 'number'
        ? options.nowUnixSeconds * 1000
        : Date.now();
    const keyHash = hashReplayKey(scope, rawKey.trim());
    return await this.adapter.isConsumedInStore({ keyHash, nowMs });
  }

  public async consumeOnce(
    scope: 'init_data' | 'tg_update' | 'tg_cb' | 'game_draw' | 'card_tx' | 'bot_action_dedup' | 'custom',
    rawKey: string,
    options: {
      nowUnixSeconds?: number;
      ttlSeconds?: number;
    } = {}
  ): Promise<ReplayConsumeResult> {
    if (!rawKey || rawKey.trim() === '') {
      return { fresh: false, reason: 'invalid_key' };
    }

    const nowMs =
      typeof options.nowUnixSeconds === 'number'
        ? options.nowUnixSeconds * 1000
        : Date.now();
    const ttlSeconds = Math.max(60, options.ttlSeconds ?? this.defaultTtlSeconds);
    const ttlMs = ttlSeconds * 1000;
    const keyHash = hashReplayKey(scope, rawKey.trim());

    const fresh = await this.adapter.consumeInTransaction({
      keyHash,
      scope,
      nowMs,
      ttlMs,
    });

    if (!fresh) {
      return { fresh: false, reason: 'replay_detected', keyHash };
    }

    return {
      fresh: true,
      keyHash,
      expiresAtMs: nowMs + ttlMs,
    };
  }

  public async cleanupExpired(nowUnixSeconds?: number, maxDeletes = 50): Promise<number> {
    const nowMs =
      typeof nowUnixSeconds === 'number' ? nowUnixSeconds * 1000 : Date.now();
    return await this.adapter.cleanupExpired(nowMs, maxDeletes);
  }
}
