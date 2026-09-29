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
  };
  // Seats are a per-mode rule, so the cap lives on the mode, not here.

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

  // Apply a pickup to a stats block. A stat already at the cap still swallows the
  // powerup but gains nothing, so the caller removes it from the ground either way.
  // `stats` may be shared by several players (see statsKeyFor), which is how a team
  // levels up together.
  function applyPowerup(stats, type, cfg) {
    if (stats.levels[type] >= cfg.MAX_POWERUP_LEVEL) return false;
    stats.levels[type]++;
    if (type === POWERUP.BOMBS) stats.maxBombs++;
    else if (type === POWERUP.RANGE) stats.blastRange++;
    else stats.speed = cfg.PLAYER_SPEED * (1 + cfg.SPEED_STEP * stats.levels[type]);
    return true;
  }

  // ------------------------------------------------------------------ teams

  const TEAM = { RED: 'red', BLUE: 'blue' };
  const TEAMS = [TEAM.RED, TEAM.BLUE];

  // ------------------------------------------------------------------ avatars

  // A player's look. Only `color` matters today; keeping it an object means avatar
  // options (hats, faces, trails) can be added later without touching call sites.
  // Each palette has eight shades so even a lopsided 7-v-1 team still gives
  // everyone their own, while staying recognisably red or blue.
  const PALETTES = {
    solo: ['#f5f5f5', '#222222', '#3b82f6', '#ef4444', '#a3e635', '#f5b301', '#e879f9', '#14b8a6'],
    [TEAM.RED]:  ['#ef4444', '#fb7185', '#f97316', '#e11d48', '#dc2626', '#fda4af', '#ea580c', '#9f1239'],
    [TEAM.BLUE]: ['#3b82f6', '#22d3ee', '#8b5cf6', '#2563eb', '#0ea5e9', '#a5b4fc', '#7c3aed', '#1e40af'],
  };

  // `seat` is the player's index within their own group (their team, or the whole
  // lobby in a solo mode), so colours don't collide.
  function appearanceFor(mode, team, seat) {
    const palette = PALETTES[mode.teams ? team : 'solo'] || PALETTES.solo;
    return { color: palette[seat % palette.length] };
  }

  // ------------------------------------------------------------------ modes

  // A mode is the one place a variant's rules live: how many can play, whether
  // players are split into teams, where everyone spawns, and which tiles the map
  // generator must leave walkable. Adding a mode means adding an entry here.

  // Evenly spaced columns, so any number of players fits one row without overlapping.
  function spreadAcross(n, count) {
    return Array.from({ length: count }, (_, i) =>
      Math.max(0, Math.min(n - 1, Math.round((i + 0.5) * (n / count) - 0.5))));
  }

  const CORNER_OFFSETS = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]];

  // Corners, diagonally opposite pairs first, so a two-player match starts as far
  // apart as the map allows.
  const corners = n => [
    { x: 0, y: 0 }, { x: n - 1, y: n - 1 }, { x: n - 1, y: 0 }, { x: 0, y: n - 1 },
  ];

  function soloSpawns(n, roster) {
    const c = corners(n);
    return roster.map((_, i) => c[i % c.length]);
  }

  function soloClearZones(n) {
    const out = [];
    for (const s of corners(n)) {
      for (const [dx, dy] of CORNER_OFFSETS) {
        const x = s.x + dx, y = s.y + dy;
        if (x >= 0 && y >= 0 && x < n && y < n) out.push(y * n + x);
      }
    }
    return out;
  }

  // Red along the top row, blue along the bottom. Both rows are cleared outright,
  // so a lopsided team still has room to line up.
  function teamSpawns(n, roster) {
    const rows = { [TEAM.RED]: 0, [TEAM.BLUE]: n - 1 };
    const counts = { [TEAM.RED]: 0, [TEAM.BLUE]: 0 };
    for (const p of roster) counts[normalizeTeam(p.team)]++;
    const cols = {
      [TEAM.RED]: spreadAcross(n, counts[TEAM.RED]),
      [TEAM.BLUE]: spreadAcross(n, counts[TEAM.BLUE]),
    };
    const taken = { [TEAM.RED]: 0, [TEAM.BLUE]: 0 };
    return roster.map(p => {
      const t = normalizeTeam(p.team);
      return { x: cols[t][taken[t]++], y: rows[t] };
    });
  }

  function teamClearZones(n) {
    const out = [];
    for (let x = 0; x < n; x++) { out.push(x); out.push((n - 1) * n + x); }
    return out;
  }

  const normalizeTeam = t => (TEAMS.includes(t) ? t : TEAM.RED);

  const MODE = { FFA: 'ffa', TEAM: 'team' };

  const MODES = {
    [MODE.FFA]: {
      id: MODE.FFA,
      label: 'Free-for-all',
      blurb: 'Everyone for themselves \u2014 last one standing wins.',
      maxPlayers: 4,
      teams: null,                 // null = each player is their own side
      spawns: soloSpawns,
      clearZones: soloClearZones,
    },
    [MODE.TEAM]: {
      id: MODE.TEAM,
      label: 'Teams',
      blurb: 'Red vs Blue \u2014 powerups are shared and friendly fire is on.',
      maxPlayers: 8,
      teams: TEAMS,
      spawns: teamSpawns,
      clearZones: teamClearZones,
    },
  };

  const modeById = id => MODES[id] || MODES[MODE.FFA];

  // Which side a player counts for when deciding who has won: their team in a team
  // mode, otherwise just themselves.
  function factionOf(mode, p) {
    return mode.teams ? normalizeTeam(p.team) : p.id;
  }

  // Whose powerup tiers a player draws on. Teammates share one key, so they share
  // one stats block and level up together.
  function statsKeyFor(mode, p) {
    return mode.teams ? `team:${normalizeTeam(p.team)}` : `player:${p.id}`;
  }

  // Enough players, and at least two sides with someone on them.
  function startBlocker(mode, roster) {
    if (roster.length < 2) return 'Waiting for one more player \u2014 two is the minimum.';
    const sides = new Set(roster.map(p => factionOf(mode, p)));
    if (sides.size < 2) return 'Both teams need at least one player.';
    return null;
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
           TEAM, TEAMS, normalizeTeam, PALETTES, appearanceFor,
           MODE, MODES, modeById, factionOf, statsKeyFor, startBlocker, spreadAcross,
           isSolid, overlappedTiles, collides, stepPlayer };
});
