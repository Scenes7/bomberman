const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { Room } = require('./game.js');

const PORT = process.env.PORT || 3000;
// Comma-separated list of origins allowed to connect, if the frontend is hosted elsewhere.
const CORS_ORIGINS = process.env.CORS_ORIGINS ? process.env.CORS_ORIGINS.split(',') : [];

const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('/health', (req, res) => res.send('ok'));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: CORS_ORIGINS } });

const rooms = new Map();
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function newCode() {
  let code;
  do {
    code = Array.from({ length: 5 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function cleanName(name) {
  const s = String(name || '').trim().slice(0, 16);
  return s || 'Guest';
}

io.on('connection', socket => {
  let room = null;

  // `ack` runs before the room is told, so the client knows its own id before any
  // lobby payload arrives and can render "you", HOST and team state correctly.
  const join = (r, name, ack, extra) => {
    room = r;
    socket.join(r.code);
    ack({ ok: true, code: r.code, id: socket.id, ...extra });
    r.addPlayer(socket.id, cleanName(name));
  };

  socket.on('createLobby', ({ name, mode } = {}, ack) => {
    if (room || typeof ack !== 'function') return;
    const r = new Room(newCode(), io);
    rooms.set(r.code, r);
    // The host may pick the mode up front; an unknown value just leaves the default.
    if (mode) r.setMode(String(mode));
    join(r, name, ack);
  });

  socket.on('joinLobby', ({ code, name } = {}, ack) => {
    if (room || typeof ack !== 'function') return;
    const r = rooms.get(String(code || '').toUpperCase().trim());
    if (!r) return ack({ ok: false, error: 'Lobby not found.' });
    if (r.state !== 'lobby') return ack({ ok: false, error: 'That match is already in progress.' });
    if (r.players.size >= r.mode.maxPlayers) return ack({ ok: false, error: 'Lobby is full.' });
    join(r, name, ack);
  });

  // Host-only lobby settings.
  socket.on('setMode', ({ mode } = {}) => {
    if (!room || room.hostId !== socket.id) return;
    room.setMode(String(mode || ''));
  });

  // Any player picks their own team.
  socket.on('setTeam', ({ team } = {}) => {
    if (!room) return;
    room.setTeam(socket.id, String(team || ''));
  });

  socket.on('startGame', () => {
    if (!room || room.hostId !== socket.id || room.state !== 'lobby') return;
    if (room.startBlocker()) return;
    room.start();
  });

  socket.on('move', pos => room && room.handleMove(socket.id, pos));
  socket.on('bomb', pos => room && room.handleBomb(socket.id, pos));

  socket.on('disconnect', () => {
    if (!room) return;
    room.removePlayer(socket.id);
    if (room.players.size === 0) {
      room.destroy();
      rooms.delete(room.code);
    }
  });
});

server.listen(PORT, () => console.log(`Bomberman server on http://localhost:${PORT}`));
