# SealSimulator v7

A simple white UI seal clicker with accounts, persistent progress, real-player ranked battles, friend room codes, a global live chat, friend invites, and private friend-to-friend messages.

## Render
Build command: `npm install`
Start command: `npm start`

Set `DATABASE_URL` to your Render Postgres Internal Database URL. The server creates the required social tables on startup.

## Social features
- Global community chat for all signed-in players.
- Unique 8-character friend codes that can be copied and shared.
- Friend requests with accept flow.
- Online/offline friend status.
- Persistent private messages between friends.
- Real-time Socket.IO message delivery.

No bot opponents are used for ranked matchmaking.


## v8 Social presence update
- Global and private chat messages show the sender's current rank.
- Online/offline presence is shown with a dot and status text.
- The Chat header shows the live number of connected players.
- Presence updates are broadcast immediately when players connect or disconnect.
