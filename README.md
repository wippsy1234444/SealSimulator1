# SealSimulator — Multiplayer Deployment

This package is the single-server version of SealSimulator.

It serves the website and multiplayer server from the same app, so one public URL can handle:
- Seal clicking
- Real-player ranked matchmaking
- Friend room codes
- Ranked battles
- Online leaderboard
- Socket.IO real-time battle scores

There are **no bots**. A ranked match only starts when two real connected players are paired.

## Run locally

```bash
npm install
npm start
```

Open http://localhost:3000

## Deploy as one URL on Render

1. Create a new GitHub repository.
2. Upload **everything in this folder** to the repository. `package.json` and `server.js` must be in the repository root.
3. On Render, create a **Web Service** and connect the GitHub repository.
4. Build command: `npm install`
5. Start command: `npm start`
6. Render will give you a public `.onrender.com` URL.
7. Open that URL in your browser. The website and Socket.IO multiplayer are served from the same URL.

## Important multiplayer notes

The current leaderboard is held in server memory, so it is an online leaderboard for the currently connected players and resets when the server restarts. For permanent accounts, persistent global leaderboard data, and production matchmaking across server restarts, add a database such as Postgres and authentication.
