# SealSimulator — Clean Multiplayer Rebuild

One Node/Express app serves the website and Socket.IO multiplayer server.

## Render
Build command: `npm install`
Start command: `npm start`

Environment variables:
- `DATABASE_URL` — Render Postgres Internal Database URL
- `JWT_SECRET` — a long random secret

The app creates its PostgreSQL tables automatically on first start.

Features included: accounts, unique profile names, persistent progress, ranks, real-player ranked queue, friend rooms, global chat, private chat, online presence, leaderboard, upgrades, cosmetics and clean click UI.


### Render note
If you deploy manually rather than through the Blueprint, add a `JWT_SECRET` environment variable in Render with a long random value. Never commit that secret to GitHub. The server uses Express 5-compatible catch-all routing.
