const { CONFIG, TILE, spawnPoints, collides } = require('../public/shared.js');

const TICK_MS = 1000 / 30;
const COLORS = ['#f5f5f5', '#222222', '#3b82f6', '#ef4444'];

// Random tiles, spawn corners (and the tiles next to them) kept clear, and any
// open area cut off by hard walls sealed so both players can always reach each other.
function generateMap(cfg) {
  const n = cfg.GRID_SIZE;
  const spawns = spawnPoints(n);

  for (let attempt = 0; attempt < 200; attempt++) {
    const grid = new Array(n * n);
    for (let i = 0; i < grid.length; i++) {
      const r = Math.random();
      grid[i] = r < cfg.HARD_WALL_CHANCE ? TILE.HARD
        : r < cfg.HARD_WALL_CHANCE + cfg.SOFT_BLOCK_CHANCE ? TILE.SOFT
        : TILE.EMPTY;
    }

    for (const s of spawns) {
      for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const x = s.x + dx, y = s.y + dy;
        if (x >= 0 && y >= 0 && x < n && y < n) grid[y * n + x] = TILE.EMPTY;
      }
    }

    // Flood fill through everything that isn't a hard wall.
    const seen = new Uint8Array(n * n);
    const stack = [spawns[0].y * n + spawns[0].x];
    seen[stack[0]] = 1;
    while (stack.length) {
      const i = stack.pop();
      const x = i % n, y = (i / n) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
        const j = ny * n + nx;
        if (!seen[j] && grid[j] !== TILE.HARD) { seen[j] = 1; stack.push(j); }
      }
    }

    if (!spawns.every(s => seen[s.y * n + s.x])) continue;
    for (let i = 0; i < grid.length; i++) if (!seen[i]) grid[i] = TILE.HARD;
    return grid;
  }
  throw new Error('Could not generate a connected map');
}

class Room {
  constructor(code, io) {
    this.code = code;
    this.io = io;
    this.players = new Map(); // socket id -> { id, name }
    this.hostId = null;
    this.state = 'lobby';     // 'lobby' | 'playing'
    this.match = null;
  }

  broadcastLobby() {
    this.io.to(this.code).emit('lobby', {
      code: this.code,
      hostId: this.hostId,
      state: this.state,
      maxPlayers: CONFIG.MAX_PLAYERS,
      players: [...this.players.values()].map(p => ({ id: p.id, name: p.name })),
    });
  }

  addPlayer(id, name) {
    this.players.set(id, { id, name });
    if (!this.hostId) this.hostId = id;
    this.broadcastLobby();
  }

  removePlayer(id) {
    this.players.delete(id);
    if (this.hostId === id) this.hostId = this.players.keys().next().value || null;
    if (this.match) {
      const mp = this.match.players.get(id);
      if (mp) mp.alive = false;
      this.checkGameOver();
    }
    this.broadcastLobby();
  }

  start() {
    const cfg = { ...CONFIG };
    const n = cfg.GRID_SIZE;
    const spawns = spawnPoints(n);
    const players = new Map();
    [...this.players.values()].forEach((p, i) => {
      players.set(p.id, {
        id: p.id, name: p.name, color: COLORS[i % COLORS.length],
        x: spawns[i].x + 0.5, y: spawns[i].y + 0.5,
        alive: true, activeBombs: 0, lastMoveAt: 0,
      });
    });

    this.state = 'playing';
    this.match = {
      cfg, n,
      grid: generateMap(cfg),
      gridDirty: false,
      players,
      bombs: new Map(),  // tile index -> { x, y, owner, explodeAt }
      flames: [],        // { tiles: [index], until }
      startAt: Date.now() + cfg.COUNTDOWN,
      over: false,
    };

    this.io.to(this.code).emit('start', {
      config: cfg,
      countdown: cfg.COUNTDOWN,
      grid: this.match.grid.join(''),
      players: [...players.values()].map(publicPlayer),
    });
    this.broadcastLobby();
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  handleMove(id, pos) {
    const m = this.match;
    if (!m || m.over || Date.now() < m.startAt) return;
    const p = m.players.get(id);
    if (!p || !p.alive || !pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) return;

    // Light sanity check: reject teleports and walking into walls/blocks.
    const now = Date.now();
    const elapsed = Math.min(now - (p.lastMoveAt || now - TICK_MS), 500) / 1000;
    const maxDist = m.cfg.PLAYER_SPEED * elapsed * 1.5 + 0.25;
    const dist = Math.hypot(pos.x - p.x, pos.y - p.y);
    if (dist > maxDist || collides(m.grid, m.n, pos.x, pos.y, m.cfg.PLAYER_SIZE, null)) {
      this.io.to(id).emit('correction', { x: p.x, y: p.y });
      return;
    }
    p.x = pos.x;
    p.y = pos.y;
    p.lastMoveAt = now;
  }

  handleBomb(id, pos) {
    if (pos) this.handleMove(id, pos);
    const m = this.match;
    if (!m || m.over || Date.now() < m.startAt) return;
    const p = m.players.get(id);
    if (!p || !p.alive || p.activeBombs >= m.cfg.MAX_BOMBS) return;
    const tx = Math.floor(p.x), ty = Math.floor(p.y);
    const i = ty * m.n + tx;
    if (m.bombs.has(i)) return;
    m.bombs.set(i, { x: tx, y: ty, owner: id, explodeAt: Date.now() + m.cfg.FUSE_TIME });
    p.activeBombs++;
  }

  tick() {
    const m = this.match;
    const now = Date.now();

    // Detonate due bombs; flames that reach other bombs set them off in the same tick.
    let due;
    while ((due = [...m.bombs.entries()].find(([, b]) => b.explodeAt <= now))) {
      this.explode(due[0], due[1], now);
    }
    m.flames = m.flames.filter(f => f.until > now);

    const burning = new Set();
    for (const f of m.flames) for (const t of f.tiles) burning.add(t);
    for (const p of m.players.values()) {
      if (p.alive && burning.has(Math.floor(p.y) * m.n + Math.floor(p.x))) p.alive = false;
    }

    const state = {
      players: [...m.players.values()].map(publicPlayer),
      bombs: [...m.bombs.values()].map(b => ({ x: b.x, y: b.y, explodeAt: b.explodeAt - now })),
      flames: [...burning],
    };
    if (m.gridDirty) { state.grid = m.grid.join(''); m.gridDirty = false; }
    this.io.to(this.code).emit('state', state);

    this.checkGameOver();
  }

  explode(index, bomb, now) {
    const m = this.match;
    m.bombs.delete(index);
    const owner = m.players.get(bomb.owner);
    if (owner) owner.activeBombs--;

    const tiles = [index];
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      for (let r = 1; r <= m.cfg.BLAST_RANGE; r++) {
        const x = bomb.x + dx * r, y = bomb.y + dy * r;
        if (x < 0 || y < 0 || x >= m.n || y >= m.n) break;
        const i = y * m.n + x;
        if (m.grid[i] === TILE.HARD) break;
        tiles.push(i);
        if (m.grid[i] === TILE.SOFT) {
          m.grid[i] = TILE.EMPTY;
          m.gridDirty = true;
          break;
        }
        const other = m.bombs.get(i);
        if (other) other.explodeAt = now;
      }
    }
    m.flames.push({ tiles, until: now + m.cfg.EXPLOSION_DURATION });
  }

  checkGameOver() {
    const m = this.match;
    if (!m || m.over) return;
    const alive = [...m.players.values()].filter(p => p.alive && this.players.has(p.id));
    if (alive.length > 1) return;

    m.over = true;
    clearInterval(this.timer);
    const winner = alive[0] || null;
    this.io.to(this.code).emit('gameOver', {
      winnerId: winner ? winner.id : null,
      winnerName: winner ? winner.name : null,
    });
    this.state = 'lobby';
    this.match = null;
    this.broadcastLobby();
  }

  destroy() {
    clearInterval(this.timer);
  }
}

function publicPlayer(p) {
  return { id: p.id, name: p.name, color: p.color, x: p.x, y: p.y, alive: p.alive };
}

module.exports = { Room };
