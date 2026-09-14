const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const leaderboard = new Map();
const queue = [];
const rooms = new Map();
const players = new Map();

const ranks = [
  { name: 'Bronze', min: 0 },
  { name: 'Silver', min: 100 },
  { name: 'Gold', min: 300 },
  { name: 'Platinum', min: 650 },
  { name: 'Diamond', min: 1200 },
  { name: 'Master', min: 2200 }
];

function rankFor(elo) {
  return ranks.slice().reverse().find(r => elo >= r.min) || ranks[0];
}
function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  do {
    code = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}
function removeFromQueue(id) {
  const idx = queue.indexOf(id);
  if (idx >= 0) queue.splice(idx, 1);
}
function makeRoom(a, b, ranked) {
  const id = `r_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  rooms.set(id, { id, players: [a, b], ranked, started: false, clicks: { [a.id]: 0, [b.id]: 0 }, endsAt: 0 });
  a.join(id); b.join(id);
  return rooms.get(id);
}
function pairRanked() {
  while (queue.length >= 2) {
    const a = players.get(queue.shift());
    const b = players.get(queue.shift());
    if (!a || !b || a.socket.disconnected || b.socket.disconnected) continue;
    const room = makeRoom(a, b, true);
    a.socket.emit('match:found', { roomId: room.id, opponent: b.name, ranked: true });
    b.socket.emit('match:found', { roomId: room.id, opponent: a.name, ranked: true });
    setTimeout(() => startRoom(room), 1200);
  }
}
function startRoom(room) {
  if (!rooms.has(room.id) || room.started || room.players.length !== 2) return;
  room.started = true;
  room.endsAt = Date.now() + 30000;
  io.to(room.id).emit('battle:start', { duration: 30, endsAt: room.endsAt });
  setTimeout(() => finishRoom(room.id), 30050);
}
function finishRoom(id) {
  const room = rooms.get(id);
  if (!room) return;
  const [a, b] = room.players;
  const aScore = room.clicks[a.id] || 0;
  const bScore = room.clicks[b.id] || 0;
  let result = 'draw';
  if (aScore !== bScore) result = aScore > bScore ? a.id : b.id;
  const payload = { result, scores: { [a.id]: aScore, [b.id]: bScore } };
  if (room.ranked && result !== 'draw') {
    const winner = players.get(result);
    const loser = players.get(result === a.id ? b.id : a.id);
    if (winner) winner.elo += 25;
    if (loser) loser.elo = Math.max(0, loser.elo - 15);
    for (const p of [winner, loser]) {
      if (!p) continue;
      leaderboard.set(p.id, { id: p.id, name: p.name, elo: p.elo, rank: rankFor(p.elo).name, clicks: p.totalClicks });
    }
    payload.elo = {};
    if (winner) payload.elo[winner.id] = +25;
    if (loser) payload.elo[loser.id] = -15;
  }
  io.to(room.id).emit('battle:end', payload);
  setTimeout(() => rooms.delete(id), 5000);
}

app.get('/api/leaderboard', (_req, res) => {
  const list = [...leaderboard.values()].sort((a, b) => b.elo - a.elo).slice(0, 50);
  res.json({ players: list });
});

io.on('connection', socket => {
  const state = { id: socket.id, socket, name: 'Player', elo: 0, totalClicks: 0 };
  players.set(socket.id, state);
  leaderboard.set(socket.id, { id: socket.id, name: state.name, elo: 0, rank: 'Bronze', clicks: 0 });

  socket.on('profile:set', name => {
    const clean = String(name || 'Player').trim().slice(0, 18) || 'Player';
    state.name = clean;
    leaderboard.set(state.id, { id: state.id, name: clean, elo: state.elo, rank: rankFor(state.elo).name, clicks: state.totalClicks });
  });

  socket.on('player:click', () => {
    state.totalClicks += 1;
    const entry = leaderboard.get(state.id);
    if (entry) entry.clicks = state.totalClicks;
  });

  socket.on('ranked:queue', () => {
    removeFromQueue(socket.id);
    queue.push(socket.id);
    socket.emit('match:searching', { queued: true });
    pairRanked();
  });
  socket.on('ranked:cancel', () => removeFromQueue(socket.id));

  socket.on('friend:create', () => {
    const code = makeCode();
    rooms.set(code, { id: code, players: [state], ranked: false, started: false, clicks: { [state.id]: 0 }, endsAt: 0 });
    socket.emit('friend:created', { code });
  });
  socket.on('friend:join', rawCode => {
    const code = String(rawCode || '').trim().toUpperCase();
    const room = rooms.get(code);
    if (!room || room.players.length !== 1) return socket.emit('friend:error', 'Room not available.');
    room.players.push(state);
    const [a, b] = room.players;
    const battleRoom = makeRoom(a, b, false);
    rooms.delete(code);
    a.socket.emit('match:found', { roomId: battleRoom.id, opponent: b.name, ranked: false });
    b.socket.emit('match:found', { roomId: battleRoom.id, opponent: a.name, ranked: false });
    setTimeout(() => startRoom(battleRoom), 1200);
  });

  socket.on('battle:click', roomId => {
    const room = rooms.get(roomId);
    if (!room || !room.started || Date.now() >= room.endsAt || !room.players.some(p => p.id === socket.id)) return;
    room.clicks[socket.id] = (room.clicks[socket.id] || 0) + 1;
    io.to(roomId).emit('battle:score', { id: socket.id, score: room.clicks[socket.id] });
  });

  socket.on('disconnect', () => {
    removeFromQueue(socket.id);
    players.delete(socket.id);
    leaderboard.delete(socket.id);
    for (const [id, room] of rooms.entries()) {
      if (room.players?.some(p => p.id === socket.id)) {
        if (room.started) io.to(id).emit('battle:cancelled', { reason: 'Player disconnected.' });
        rooms.delete(id);
      }
    }
  });
});

app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
server.listen(PORT, () => console.log(`SealSimulator running on http://localhost:${PORT}`));
