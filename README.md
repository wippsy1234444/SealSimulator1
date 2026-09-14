# SealSimulator v6 — Accounts + Cloud Save + Multiplayer

This version keeps the simple SealSimulator design but adds real accounts and server-side progress storage.

## What changed
- Register or sign in before entering the game.
- Profile names are globally unique.
- Passwords are hashed with Node's `crypto.scrypt` and never stored as plain text.
- Sessions use an HttpOnly cookie.
- Game progress is saved to the server/database so it can follow the player across devices.
- One account can have one active game socket at a time; a newer sign-in replaces the older live session.
- Ranked and friend battles remain real-player-only.
- Global leaderboard reads saved player data.

## Render setup — important
For permanent accounts and progress, connect a Render Postgres database to this web service.

1. In Render, create a **Postgres** database.
2. Create the web service from your GitHub `SealSimulator` repo.
3. Build command: `npm install`
4. Start command: `npm start`
5. In the web service's **Environment** settings, add the database connection string as:
   - Key: `DATABASE_URL`
   - Value: use the Postgres database's **Internal Database URL** from Render.
6. Recommended environment variable:
   - `NODE_ENV=production`

The server automatically creates its `users` and `sessions` tables on first startup.

## Why the database is needed
Render web-service storage is not a reliable place for permanent player saves. The game uses Postgres so account names, password hashes, and progress survive deployments/restarts.

## Password recovery
This version does not have email-based password reset yet. A forgotten password needs an admin/database reset. Email verification and self-service password reset can be added later.

## Local development
Without `DATABASE_URL`, the server runs with temporary in-memory auth/data for testing. That data disappears when the server restarts.
