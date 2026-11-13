# ADEYBINGO Firestore Security Specification (Phase 0 TDD)

## 1. Data Invariants
1. **Default-Deny Catch-All**: Any path not explicitly matched is denied (`allow read, write: if false;`).
2. **Verified Identity**: Standard writes require an authenticated, email-verified user (`request.auth != null && request.auth.token.email_verified == true`) or bootstrapped admin (`abelbimrew868@gmail.com`).
3. **Wallet Balance Immutability (`/users/{userId}`)**: A player can create their own profile with the standard starting demo balance (`demoBalanceEtb == 250`), and can NEVER modify `demoBalanceEtb`, `uid`, `telegramUserId`, or `createdAt` on subsequent client updates.
4. **PII Split-Collection Isolation (`/users/{userId}/private/{docId}`)**: Personal phone numbers (`phoneNumber`) are stored strictly in `/users/{userId}/private/contact` and can ONLY be read or written by the exact owner (`request.auth.uid == userId`).
5. **Room Capacity & Card Bounds (`/rooms/{roomId}/cards/{cardId}`)**:
   - `cardId` must be an integer between `1` and `600` (`cardId.matches('^([1-9]|[1-9][0-9]|[1-5][0-9][0-9]|600)$')`).
   - Parent room `/rooms/{roomId}` must exist (`exists(...)`).
   - Atomic reservation requires that after the transaction (`getAfter`), the player's `/rooms/{roomId}/players/$(request.auth.uid)` document exists and has `cardIds.size() >= 1 && cardIds.size() <= 4` (maximum 4 cards per player).
   - Once reserved, a card reservation cannot be overwritten by another user (`allow update: if false;`, only owner can release/delete while room is not `completed`).
6. **Terminal Game State Locking (`/games/{gameId}`)**: Once `existing().status == 'completed'`, no client can mutate the game document.
7. **Append-Only Owner-Scoped Ledger (`/transactions/{transactionId}` & `/referrals/{referralId}`)**:
   - `allow list` and `allow get` strictly require `resource.data.userId == request.auth.uid` (or `inviterUid == request.auth.uid`).
   - Transactions and referrals are immutable once created (`allow update, delete: if false;`).

---

## 2. The "Dirty Dozen" Adversarial Payloads

1. **Payload 1 (Identity Spoofing on `/users/{userId}`)**: Authenticated user `user_A` attempts to create `/users/user_B` with `uid: "user_B"`. -> `PERMISSION_DENIED`.
2. **Payload 2 (Wallet Balance Inflation on `/users/{userId}`)**: Authenticated user `user_A` attempts to update `/users/user_A` setting `demoBalanceEtb: 999999`. -> `PERMISSION_DENIED`.
3. **Payload 3 (PII Blanket Read on `/users/{userId}/private/contact`)**: Authenticated user `user_B` attempts `get` on `/users/user_A/private/contact` to steal `phoneNumber`. -> `PERMISSION_DENIED`.
4. **Payload 4 (Shadow Field Injection on `/users/{userId}`)**: Authenticated user `user_A` sends valid fields plus `"isAdmin": true` on `/users/user_A`. -> `PERMISSION_DENIED`.
5. **Payload 5 (Unverified Email Spoof)**: User with `email: "abelbimrew868@gmail.com"` but `email_verified: false` attempts to write to `/rooms/adey-main`. -> `PERMISSION_DENIED`.
6. **Payload 6 (Card Out-of-Range 601 on `/rooms/adey-main/cards/601`)**: User attempts to reserve card `#601` (exceeding 600-card room capacity). -> `PERMISSION_DENIED`.
7. **Payload 7 (5th Card Overbooking on `/rooms/adey-main/players/user_A`)**: User attempts to write `cardIds: [1, 2, 3, 4, 5]` (exceeding max 4 cards per player). -> `PERMISSION_DENIED`.
8. **Payload 8 (Orphaned Card Reservation without Atomic Player Record)**: User attempts to create `/rooms/adey-main/cards/12` without atomically writing `/rooms/adey-main/players/user_A`. -> `PERMISSION_DENIED`.
9. **Payload 9 (Hijacking Another Player's Reserved Card)**: User `user_B` attempts to `update` or `delete` `/rooms/adey-main/cards/1` owned by `user_A`. -> `PERMISSION_DENIED`.
10. **Payload 10 (Terminal State Mutation on Completed Game)**: User attempts to update `calledNumbers` or `winnerUid` on `/games/game_1` after `status == 'completed'`. -> `PERMISSION_DENIED`.
11. **Payload 11 (Cross-User Transaction Scraping via `list`)**: User `user_B` runs an unfiltered `list` query on `/transactions` or queries `where('userId', '==', 'user_A')`. -> `PERMISSION_DENIED`.
12. **Payload 12 (Timestamp Forgery / Past Timestamp Injection)**: User attempts to create `/transactions/tx_1` with a forged past `createdAt` instead of `request.time`. -> `PERMISSION_DENIED`.
