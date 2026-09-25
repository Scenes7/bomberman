const { CONFIG, TILE, POWERUP_TYPES, baseStats, applyPowerup, spawnPoints, collides } = require('../public/shared.js');

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
        ...baseStats(cfg),
      });
    });

    this.state = 'playing';
    this.match = {
      cfg, n,
      grid: generateMap(cfg),
      gridDirty: false,
      players,
      bombs: new Map(),  // tile index -> { x, y, owner, explodeAt, range }
      flames: [],        // { tiles: [index], until }
      powerups: new Map(),    // tile index -> POWERUP type; lies there until walked over
      powerupsDirty: false,
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
    const maxDist = p.speed * elapsed * 1.5 + 0.25;
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
    if (!p || !p.alive || p.activeBombs >= p.maxBombs) return;
    const tx = Math.floor(p.x), ty = Math.floor(p.y);
    const i = ty * m.n + tx;
    if (m.bombs.has(i)) return;
    // Range is fixed when the bomb is laid, so a bomb's reach can't change under
    // the player -- and it still resolves correctly if the owner is gone by then.
    m.bombs.set(i, { x: tx, y: ty, owner: id, explodeAt: Date.now() + m.cfg.FUSE_TIME, range: p.blastRange });
    p.activeBombs++;
  }

  tick() {
    const m = this.match;
    const now = Date.now();

    // Tiles still alight from earlier ticks.
    m.flames = m.flames.filter(f => f.until > now);
    const burning = new Set();
    for (const f of m.flames) for (const t of f.tiles) burning.add(t);

    // A bomb goes off when its fuse runs out, or the moment a blast covers its tile --
    // whether that blast is from this tick or still burning from an earlier one. Each
    // explosion feeds its tiles back into `burning`, so chains resolve in this one pass.
    let due;
    while ((due = [...m.bombs.entries()].find(([i, b]) => b.explodeAt <= now || burning.has(i)))) {
      for (const t of this.explode(due[0], due[1], now)) burning.add(t);
    }
    for (const p of m.players.values()) {
      if (p.alive && burning.has(Math.floor(p.y) * m.n + Math.floor(p.x))) p.alive = false;
    }

    // Powerups sit in their own map, so blasts never touch them -- only walking
    // over one picks it up, and only the living can do that.
    for (const p of m.players.values()) {
      if (!p.alive) continue;
      const i = Math.floor(p.y) * m.n + Math.floor(p.x);
      const type = m.powerups.get(i);
      if (type === undefined) continue;
      m.powerups.delete(i);
      m.powerupsDirty = true;
      applyPowerup(p, type, m.cfg);   // a capped stat swallows it with no effect
    }

    const state = {
      players: [...m.players.values()].map(publicPlayer),
      bombs: [...m.bombs.values()].map(b => ({ x: b.x, y: b.y, explodeAt: b.explodeAt - now })),
      flames: [...burning],
    };
    if (m.gridDirty) { state.grid = m.grid.join(''); m.gridDirty = false; }
    if (m.powerupsDirty) {
      state.powerups = [...m.powerups].map(([i, t]) => ({ x: i % m.n, y: (i / m.n) | 0, t }));
      m.powerupsDirty = false;
    }
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
      for (let r = 1; r <= bomb.range; r++) {
        const x = bomb.x + dx * r, y = bomb.y + dy * r;
        if (x < 0 || y < 0 || x >= m.n || y >= m.n) break;
        const i = y * m.n + x;
        if (m.grid[i] === TILE.HARD) break;
        tiles.push(i);
        if (m.grid[i] === TILE.SOFT) {
          m.grid[i] = TILE.EMPTY;
          m.gridDirty = true;
          if (Math.random() < m.cfg.POWERUP_DROP_CHANCE) {
            m.powerups.set(i, POWERUP_TYPES[Math.floor(Math.random() * POWERUP_TYPES.length)]);
            m.powerupsDirty = true;
          }
          break;
        }
      }
    }
    m.flames.push({ tiles, until: now + m.cfg.EXPLOSION_DURATION });
    return tiles;
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
  return {
    id: p.id, name: p.name, color: p.color, x: p.x, y: p.y, alive: p.alive,
    maxBombs: p.maxBombs, blastRange: p.blastRange, speed: p.speed, levels: p.levels,
  };
}

module.exports = { Room };
