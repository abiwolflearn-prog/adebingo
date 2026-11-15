import crypto from 'node:crypto';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
export const REPLAY_GUARDS_COLLECTION = 'replayGuards';
export function hashReplayKey(scope, rawKey) {
    return crypto
        .createHash('sha256')
        .update(`${scope}:${rawKey}`)
        .digest('hex');
}
export function createFirestoreReplayAdapter(db) {
    const col = db.collection(REPLAY_GUARDS_COLLECTION);
    return {
        async consumeInTransaction({ keyHash, scope, nowMs, ttlMs }) {
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
        async cleanupExpired(nowMs, maxDeletes) {
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
    constructor(adapter, defaultTtlSeconds = 3600) {
        this.adapter = adapter;
        this.defaultTtlSeconds = defaultTtlSeconds;
    }
    async consumeOnce(scope, rawKey, options = {}) {
        if (!rawKey || rawKey.trim() === '') {
            return { fresh: false, reason: 'invalid_key' };
        }
        const nowMs = typeof options.nowUnixSeconds === 'number'
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
    async cleanupExpired(nowUnixSeconds, maxDeletes = 50) {
        const nowMs = typeof nowUnixSeconds === 'number' ? nowUnixSeconds * 1000 : Date.now();
        return await this.adapter.cleanupExpired(nowMs, maxDeletes);
    }
}
