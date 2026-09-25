// Shared between the browser and the Node server.
// All gameplay tuning lives in CONFIG — the server sends its copy to clients
// when a match starts, so editing it here (and restarting the server) is enough.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Shared = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const CONFIG = {
    GRID_SIZE: 20,           // map is GRID_SIZE x GRID_SIZE tiles
    PLAYER_SPEED: 4,         // tiles per second
    FUSE_TIME: 2500,         // ms from placing a bomb to explosion
    MAX_BOMBS: 1,            // bombs a player can have on the map at once, before powerups
    BLAST_RANGE: 1,          // tiles the flame reaches in each direction, before powerups
    EXPLOSION_DURATION: 500, // ms flames stay deadly
    POWERUP_DROP_CHANCE: 0.25,  // chance a destroyed block leaves a powerup behind
    MAX_POWERUP_LEVEL: 7,       // times each stat can be upgraded; further pickups do nothing
    SPEED_STEP: 0.2,            // each speed powerup adds 20% of the BASE speed (see note below)
    COUNTDOWN: 5000,         // ms of frozen "get ready" time at match start
    SOFT_BLOCK_CHANCE: 0.55, // chance a tile starts as a breakable block
    HARD_WALL_CHANCE: 0.12,  // chance a tile starts as an unbreakable wall
    PLAYER_SIZE: 0.7,        // hitbox width as a fraction of a tile
    MAX_PLAYERS: 4,          // one per corner; spawnPoints() must supply this many
  };

  const TILE = { EMPTY: 0, HARD: 1, SOFT: 2 };

  // Powerup kinds. The values double as the keys of a player's `levels` object,
  // so a pickup needs no type -> field mapping.
  //
  // Speed stacks on the base rather than compounding: at the level-7 cap that is
  // 2.4x base (9.6 tiles/s). Compounding 1.2^7 would be 3.58x -- fast enough to
  // cross the whole map in under a second and a half.
  const POWERUP = { BOMBS: 'bombs', RANGE: 'range', SPEED: 'speed' };
  const POWERUP_TYPES = [POWERUP.BOMBS, POWERUP.RANGE, POWERUP.SPEED];

  // Starting stats for a player, before any powerup.
  function baseStats(cfg) {
    return {
      maxBombs: cfg.MAX_BOMBS,
      blastRange: cfg.BLAST_RANGE,
      speed: cfg.PLAYER_SPEED,
      levels: { [POWERUP.BOMBS]: 0, [POWERUP.RANGE]: 0, [POWERUP.SPEED]: 0 },
    };
  }

  // Apply a pickup. A stat already at the cap still swallows the powerup but
  // gains nothing, so the caller removes it from the ground either way.
  function applyPowerup(p, type, cfg) {
    if (p.levels[type] >= cfg.MAX_POWERUP_LEVEL) return false;
    p.levels[type]++;
    if (type === POWERUP.BOMBS) p.maxBombs++;
    else if (type === POWERUP.RANGE) p.blastRange++;
    else p.speed = cfg.PLAYER_SPEED * (1 + cfg.SPEED_STEP * p.levels[type]);
    return true;
  }

  // Spawn tiles, in join order: the four corners. Diagonally opposite pairs come
  // first so a two-player match starts as far apart as the map allows.
  function spawnPoints(n) {
    return [
      { x: 0, y: 0 },
      { x: n - 1, y: n - 1 },
      { x: n - 1, y: 0 },
      { x: 0, y: n - 1 },
    ];
  }

  // Is tile (tx, ty) impassable? `bombs` is a Set of tile indices that block,
  // already excluding any bombs this player is allowed to walk off of.
  function isSolid(grid, n, tx, ty, bombs) {
    if (tx < 0 || ty < 0 || tx >= n || ty >= n) return true;
    const i = ty * n + tx;
    if (grid[i] !== TILE.EMPTY) return true;
    return bombs ? bombs.has(i) : false;
  }

  // Tile indices overlapped by a player hitbox centred at (x, y).
  function overlappedTiles(x, y, size, n) {
    const h = size / 2, eps = 1e-6;
    const out = [];
    for (let ty = Math.floor(y - h); ty <= Math.floor(y + h - eps); ty++) {
      for (let tx = Math.floor(x - h); tx <= Math.floor(x + h - eps); tx++) {
        out.push(ty * n + tx);
      }
    }
    return out;
  }

  function collides(grid, n, x, y, size, bombs) {
    const h = size / 2, eps = 1e-6;
    for (let ty = Math.floor(y - h); ty <= Math.floor(y + h - eps); ty++) {
      for (let tx = Math.floor(x - h); tx <= Math.floor(x + h - eps); tx++) {
        if (isSolid(grid, n, tx, ty, bombs)) return true;
      }
    }
    return false;
  }

  // Move a player along one axis. When blocked, snap flush against the wall
  // and nudge toward the centre of the current lane so corners are easy to take.
  function stepPlayer(p, dir, dt, world) {
    const { grid, n, bombs, speed, size } = world;
    const h = size / 2;
    const dist = speed * dt;
    const horizontal = dir.x !== 0;
    const sign = horizontal ? dir.x : dir.y;
    const main = horizontal ? 'x' : 'y';
    const cross = horizontal ? 'y' : 'x';

    const tryPos = (m, c) => horizontal
      ? !collides(grid, n, m, c, size, bombs)
      : !collides(grid, n, c, m, size, bombs);

    const target = p[main] + sign * dist;
    if (tryPos(target, p[cross])) {
      p[main] = target;
      return;
    }

    // Snap flush against whatever is in the way.
    const flush = sign > 0 ? Math.ceil(p[main] + h) - h : Math.floor(p[main] - h) + h;
    if (Math.abs(flush - p[main]) < dist && tryPos(flush, p[cross])) p[main] = flush;

    // Corner assist: if the tile ahead in our lane is open, slide toward the lane centre.
    const lane = Math.floor(p[cross]);
    const ahead = Math.floor(p[main]) + sign;
    const aheadOpen = horizontal
      ? !isSolid(grid, n, ahead, lane, bombs)
      : !isSolid(grid, n, lane, ahead, bombs);
    if (!aheadOpen) return;

    const off = lane + 0.5 - p[cross];
    const shift = Math.sign(off) * Math.min(dist, Math.abs(off));
    if (shift !== 0 && tryPos(p[main], p[cross] + shift)) p[cross] += shift;
  }

  return { CONFIG, TILE, POWERUP, POWERUP_TYPES, baseStats, applyPowerup,
           spawnPoints, isSolid, overlappedTiles, collides, stepPlayer };
});
