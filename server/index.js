const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { CONFIG } = require('../public/shared.js');
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

  const join = (r, name) => {
    room = r;
    socket.join(r.code);
    r.addPlayer(socket.id, cleanName(name));
  };

  socket.on('createLobby', ({ name } = {}, ack) => {
    if (room || typeof ack !== 'function') return;
    const r = new Room(newCode(), io);
    rooms.set(r.code, r);
    join(r, name);
    ack({ ok: true, code: r.code, id: socket.id });
  });

  socket.on('joinLobby', ({ code, name } = {}, ack) => {
    if (room || typeof ack !== 'function') return;
    const r = rooms.get(String(code || '').toUpperCase().trim());
    if (!r) return ack({ ok: false, error: 'Lobby not found.' });
    if (r.state !== 'lobby') return ack({ ok: false, error: 'That match is already in progress.' });
    if (r.players.size >= CONFIG.MAX_PLAYERS) return ack({ ok: false, error: 'Lobby is full.' });
    join(r, name);
    ack({ ok: true, code: r.code, id: socket.id });
  });

  socket.on('startGame', () => {
    if (!room || room.hostId !== socket.id || room.state !== 'lobby') return;
    if (room.players.size < 2) return;
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
