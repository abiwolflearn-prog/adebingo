# ADEYBINGO Firestore Security Specification (Stage 2 Remediation)

## 1. Data Invariants
1. **Default-Deny Catch-All**: Any path not explicitly matched is denied (`allow read, write: if false;`).
2. **Verified Identity (Telegram Custom Token + Verified Email)**:
   - Telegram Mini App users authenticate via server-signed Firebase Custom Tokens carrying `request.auth.token.telegram_verified == true`, integer `request.auth.token.telegram_id`, and `request.auth.uid == 'tg_' + string(request.auth.token.telegram_id)`.
   - Email users must satisfy `request.auth.token.email_verified == true`.
   - Administrative operations (`isAdmin()`) are strictly restricted to email-verified admins (`abelbimrew868@gmail.com` or `/admins/$(request.auth.uid)`), never Telegram custom claims.
3. **Server-Only Telegram Account Bindings (`/telegramBindings/{telegramUserId}`) & Strict Profile Binding (`/users/{userId}`)**:
   - Client writes (`create`, `update`, `delete`) to `/telegramBindings/{telegramUserId}` are strictly denied (`if false`). Only Firebase Admin SDK can bind a Telegram ID to its deterministic `tg_<id>` UID.
   - Email-authenticated users cannot claim Telegram IDs or create `/users/{userId}` documents; only `isVerifiedTelegramUser()` with an existing matching `/telegramBindings/$(request.auth.uid)` record may create `/users/{userId}` with `demoBalanceEtb == 250`.
   - Players can NEVER modify `demoBalanceEtb`, `uid`, `telegramUserId`, or `createdAt` on updates.
4. **PII Split-Collection Isolation (`/users/{userId}/private/{docId}`)**: Personal phone numbers (`phoneNumber`) are stored strictly in `/users/{userId}/private/contact` and can ONLY be read or written by the exact owner (`request.auth.uid == userId`).
5. **Server-Only Card & Room Authority (`/rooms/{roomId}`, `/rooms/{roomId}/players/{playerId}`, `/rooms/{roomId}/cards/{cardId}`)**:
   - Client writes (`create`, `update`, `delete`) to `/rooms/{roomId}/players/{playerId}` and `/rooms/{roomId}/cards/{cardId}` are strictly denied (`if false`).
   - Client `create` and `update` on `/rooms/{roomId}` are restricted to `isAdmin()`.
   - All card reservations/releases execute inside atomic Admin SDK transactions enforcing 1..600 card bounds, max 4 cards/player, 600 cards/room, pre-live room status, sufficient `demoBalanceEtb`, and atomic ledger entries.
6. **Server-Only Game Sessions & Winner Finalization (`/games/{gameId}`)**:
   - Client writes (`create`, `update`, `delete`) to `/games/{gameId}` are strictly denied (`if false`).
   - Only trusted Firebase Admin backend code creates games, draws cryptographic numbers, resets rounds, verifies winners against authoritative `calledNumbers`, credits `demoBalanceEtb`, and writes deterministic `bingo_win` ledger entries.
7. **Append-Only Owner-Scoped Ledger & Server-Only Rewards (`/transactions/{transactionId}` & `/referrals/{referralId}`)**:
   - `allow list` and `allow get` strictly require `resource.data.userId == request.auth.uid` (or `inviterUid == request.auth.uid`).
   - Clients cannot create `'bingo_win'` or `'referral_bonus'` transactions, nor `'qualified'` referrals; these are written exclusively by server-side Admin SDK.
   - Transactions and referrals are immutable once created (`allow update, delete: if false;`).
8. **Server-Only Backend State (`/replayGuards/{guardId}`, `/botPlayers/{telegramUserId}`, `/botOutbox/{notificationId}`, `/admins/{adminUid}`)**:
   - All client reads and writes are explicitly denied (`allow read, write: if false;`). Accessed exclusively via Firebase Admin SDK.

---

## 2. Adversarial Payloads Blocked

1. **Identity Spoofing on `/users/{userId}`**: Authenticated user `user_A` attempts to create `/users/user_B` with `uid: "user_B"`. -> `PERMISSION_DENIED`.
2. **Wallet Balance Inflation on `/users/{userId}`**: Authenticated user `user_A` attempts to update `/users/user_A` setting `demoBalanceEtb: 999999`. -> `PERMISSION_DENIED`.
3. **PII Blanket Read on `/users/{userId}/private/contact`**: Authenticated user `user_B` attempts `get` on `/users/user_A/private/contact`. -> `PERMISSION_DENIED`.
4. **Shadow Field Injection on `/users/{userId}`**: Authenticated user `user_A` sends `"isAdmin": true` on `/users/user_A`. -> `PERMISSION_DENIED`.
5. **Email User Telegram Binding Pre-Hijacking**: Email-verified user attempts to create `/telegramBindings/tg_123456` or `/users/{uid}` with `telegramUserId: "tg_123456"`. -> `PERMISSION_DENIED`.
6. **Direct Card Reservation / 4-Card Limit Bypass**: Client attempts to create `/rooms/adey-main/cards/*` or delete `/rooms/adey-main/players/{uid}` directly to exceed 4 cards. -> `PERMISSION_DENIED`.
7. **Client Game Creation / `hostUid` Self-Assignment**: Client attempts to create `/games/game_1` with `hostUid: attackerUid`. -> `PERMISSION_DENIED`.
8. **Client `calledNumbers` Rewrite**: Client attempts to update `/games/game_1` to alter `calledNumbers` to match their card. -> `PERMISSION_DENIED`.
9. **Client Winner / Game Result Forgery**: Client attempts to set `status: 'completed'` or `winnerUid` on `/games/game_1`. -> `PERMISSION_DENIED`.
10. **Forged Winnings / Referral Payouts**: Client queries another user's `/transactions` or creates `bingo_win` / `referral_bonus` / `qualified` referral docs. -> `PERMISSION_DENIED`.
11. **Server-Only Collection Probe**: Client attempts to read/write `/replayGuards/*`, `/botPlayers/*`, `/botOutbox/*`, `/admins/*`. -> `PERMISSION_DENIED`.
12. **Timestamp Forgery**: Client creates `/transactions/tx_1` with forged past `createdAt` instead of `request.time`. -> `PERMISSION_DENIED`.

