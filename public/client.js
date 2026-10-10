(() => {
  const { stepPlayer, overlappedTiles, POWERUP, MODE, MODES } = Shared;
  const socket = io(window.SERVER_URL || undefined);
  const $ = id => document.getElementById(id);

  let myId = null;
  let lobby = null;   // last 'lobby' payload
  let game = null;    // active match state, see onStart

  // ---------- screens ----------
  function show(name) {
    document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === `screen-${name}`));
  }

  // ---------- home ----------
  const nameInput = $('name');
  try { nameInput.value = localStorage.getItem('bomberman-name') || ''; } catch {}

  // Arriving through an invite link, there is only one sensible thing to do, so the
  // page offers only that: join. Lobby codes are A-Z/2-9, so anything else in the
  // query string isn't a real invite and the normal home screen stays put.
  const inviteCode = (new URLSearchParams(location.search).get('lobby') || '')
    .toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
  let invited = false;

  function setInvited(on) {
    invited = on;
    $('screen-home').classList.toggle('invited', on);
    $('join').classList.toggle('primary', on);
    $('join').textContent = on ? 'Join lobby' : 'Join';
    $('invite').hidden = !on;
    if (!on) $('create-instead').hidden = true;
  }

  if (inviteCode) {
    $('code').value = inviteCode;
    const tag = document.createElement('strong');
    tag.className = 'code';
    tag.textContent = inviteCode;
    $('invite').textContent = 'You\u2019ve been invited to lobby ';
    $('invite').append(tag);
    setInvited(true);
  }
  (nameInput.value ? $(invited ? 'join' : 'create') : nameInput).focus();

  function playerName() {
    const name = nameInput.value.trim() || 'Guest';
    try { localStorage.setItem('bomberman-name', name); } catch {}
    return name;
  }

  function entered(res) {
    if (!res.ok) {
      $('home-error').textContent = res.error;
      // The invite is stale (lobby gone, full, or already playing) and the create
      // button is hidden, so offer the way out rather than stranding them here.
      if (invited) $('create-instead').hidden = false;
      return;
    }
    myId = res.id;
    history.replaceState(null, '', `?lobby=${res.code}`);
    show('lobby');
    // The lobby broadcast can arrive before this ack, in which case it was painted
    // without knowing which player is us. Repaint now that we do.
    paintLobby(lobby);
  }

  // Mode picker on the home screen. Built from the shared mode table, so a new mode
  // shows up here without touching this code.
  let createMode = MODE.FFA;
  const createModeBox = $('create-mode-buttons');
  for (const m of Object.values(MODES)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.mode = m.id;
    b.textContent = m.label;
    b.onclick = () => { createMode = m.id; paintCreateMode(); };
    createModeBox.appendChild(b);
  }
  function paintCreateMode() {
    for (const b of createModeBox.children) b.classList.toggle('on', b.dataset.mode === createMode);
    $('create-mode-note').textContent = MODES[createMode].blurb;
  }
  paintCreateMode();

  const createLobby = () => {
    $('home-error').textContent = '';
    socket.emit('createLobby', { name: playerName(), mode: createMode }, entered);
  };
  $('create').onclick = createLobby;
  $('create-instead').onclick = () => { setInvited(false); createLobby(); };
  $('join').onclick = () => {
    const code = $('code').value.trim();
    if (!code) { $('home-error').textContent = 'Enter a lobby code.'; return; }
    socket.emit('joinLobby', { code, name: playerName() }, entered);
  };
  $('code').addEventListener('keydown', e => { if (e.key === 'Enter') $('join').click(); });
  nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') $(invited ? 'join' : 'create').click(); });

  // ---------- lobby ----------
  socket.on('lobby', data => { lobby = data; paintLobby(data); });

  function paintLobby(data) {
    if (!data) return;
    $('lobby-code').textContent = data.code;
    $('link').value = `${location.origin}${location.pathname}?lobby=${data.code}`;

    const isHost = data.hostId === myId;
    renderModePicker(data, isHost);
    renderPlayerList(data);
    renderTeamPicker(data);

    $('start').hidden = !isHost;
    $('start').disabled = !!data.blocker;
    $('lobby-status').textContent = data.blocker ? data.blocker
      : isHost ? 'Everyone is here. Start when ready!'
      : 'Waiting for the host to start…';
  }

  // One button per mode the server offers. A mode that cannot seat everyone already
  // in the lobby comes back unavailable, which is what stops a 5+ player team lobby
  // from dropping to free-for-all.
  function renderModePicker(data, isHost) {
    const current = data.modes.find(m => m.id === data.mode) || { label: data.mode, blurb: '' };
    $('mode-label').textContent = current.label;
    $('mode-note').textContent = current.blurb;
    const box = $('mode-buttons');
    box.hidden = !isHost;
    box.innerHTML = '';
    if (!isHost) return;
    for (const m of data.modes) {
      const b = document.createElement('button');
      b.type = 'button';
      const active = m.id === data.mode;
      b.className = active ? 'on' : '';
      b.textContent = m.label;
      b.disabled = !m.available && !active;
      b.title = b.disabled ? `Too many players for ${m.label} (max ${m.maxPlayers}).` : m.blurb;
      b.onclick = () => socket.emit('setMode', { mode: m.id });
      box.appendChild(b);
    }
  }

  // Filled seats, grouped by team when there are teams, then a single line for the
  // room that's left -- eight "waiting" rows would just be noise.
  function renderPlayerList(data) {
    const list = $('player-list');
    list.innerHTML = '';
    const ordered = data.teams
      ? data.teams.flatMap(t => data.players.filter(p => p.team === t))
      : data.players;
    for (const p of ordered) {
      const li = document.createElement('li');
      if (data.teams) {
        const dot = document.createElement('span');
        dot.className = `team-dot ${p.team}`;
        li.appendChild(dot);
      }
      li.appendChild(document.createTextNode(p.name + (p.id === myId ? ' (you)' : '')));
      if (p.id === data.hostId) {
        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = 'HOST';
        li.appendChild(tag);
      }
      list.appendChild(li);
    }
    const room = data.maxPlayers - data.players.length;
    if (room > 0) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = `Waiting for players… room for ${room} more`;
      list.appendChild(li);
    }
  }

  function renderTeamPicker(data) {
    $('team-picker').hidden = !data.teams;
    const box = $('team-buttons');
    box.innerHTML = '';
    if (!data.teams) return;
    const me = data.players.find(p => p.id === myId);
    for (const t of data.teams) {
      const count = data.players.filter(p => p.team === t).length;
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.team = t;
      b.className = `team-btn ${t}` + (me && me.team === t ? ' on' : '');
      b.textContent = `${t.toUpperCase()} (${count})`;
      b.onclick = () => socket.emit('setTeam', { team: t });
      box.appendChild(b);
    }
  }

  $('copy').onclick = async () => {
    try { await navigator.clipboard.writeText($('link').value); }
    catch { $('link').select(); document.execCommand('copy'); }
    $('copy').textContent = 'Copied!';
    setTimeout(() => { $('copy').textContent = 'Copy'; }, 1200);
  };
  $('start').onclick = () => socket.emit('startGame');

  socket.on('disconnect', () => {
    game = null;
    overlay(`<div class="big lose">DISCONNECTED</div><button class="primary" onclick="location.reload()">Reload</button>`);
  });

  // ---------- match ----------
  const canvas = $('canvas');
  const ctx = canvas.getContext('2d');
  const keys = [];            // held direction keys, most recent last
  const DIRS = {
    w: { x: 0, y: -1 }, a: { x: -1, y: 0 }, s: { x: 0, y: 1 }, d: { x: 1, y: 0 },
    arrowup: { x: 0, y: -1 }, arrowleft: { x: -1, y: 0 }, arrowdown: { x: 0, y: 1 }, arrowright: { x: 1, y: 0 },
  };

  socket.on('start', data => {
    const n = data.config.GRID_SIZE;
    game = {
      cfg: data.config,
      mode: data.mode,
      teams: data.teams || null,
      n,
      grid: [...data.grid].map(Number),
      players: new Map(data.players.map(p => [p.id, { ...p, rx: p.x, ry: p.y }])),
      bombs: [],
      bombTiles: new Set(),
      flames: [],
      powerups: [],
      hudSig: '',
      passable: new Set(),   // bombs I'm standing on and may walk off of
      startAt: performance.now() + data.countdown,
      lastSent: 0,
      sentX: null, sentY: null,
      over: false,
    };
    keys.length = 0;
    $('eliminated').hidden = true;
    Render.setup(canvas, n);
    renderHud();
    show('game');
    showCountdown();
  });

  socket.on('state', s => {
    if (!game) return;
    const now = performance.now();
    if (s.grid) game.grid = [...s.grid].map(Number);
    if (s.powerups) game.powerups = s.powerups;
    game.flames = s.flames;

    for (const sp of s.players) {
      const p = game.players.get(sp.id);
      if (!p) continue;
      p.alive = sp.alive;
      // Stats change when a powerup is picked up; my own speed feeds prediction below.
      p.maxBombs = sp.maxBombs; p.blastRange = sp.blastRange; p.speed = sp.speed; p.levels = sp.levels;
      if (sp.id !== myId) { p.x = sp.x; p.y = sp.y; }
    }
    const sig = s.players.map(p => `${p.id}${p.alive}${p.maxBombs}${p.blastRange}${p.speed}`).join('|');
    if (sig !== game.hudSig) { game.hudSig = sig; renderHud(); }

    // Any bomb that appears under me is one I'm allowed to walk off of.
    const me = game.players.get(myId);
    const under = me ? new Set(overlappedTiles(me.x, me.y, game.cfg.PLAYER_SIZE, game.n)) : new Set();
    const tiles = new Set();
    for (const b of s.bombs) {
      const i = b.y * game.n + b.x;
      tiles.add(i);
      if (!game.bombTiles.has(i) && under.has(i)) game.passable.add(i);
    }
    game.bombTiles = tiles;
    game.bombs = s.bombs.map(b => ({ ...b, explodeAt: now + b.explodeAt }));

    if (me && !me.alive && !game.over) {
      // In a team match, being knocked out isn't the end of the match: keep watching
      // and only show the result once the whole team is gone.
      if (teamStillFighting(me)) {
        $('eliminated').textContent = 'You were eliminated \~ your team is still in it';
        $('eliminated').hidden = false;
      } else {
        game.over = true;
        setTimeout(() => showResult({ lost: true }), 700);
      }
    }
  });

  socket.on('correction', pos => {
    const me = game && game.players.get(myId);
    if (me) { me.x = pos.x; me.y = pos.y; }
  });

  function teamStillFighting(me) {
    if (!game.teams || !me.team) return false;
    return [...game.players.values()].some(p => p.team === me.team && p.alive);
  }

  socket.on('gameOver', ({ winnerId, winnerName, winnerTeam }) => {
    if (!game) return;
    game.over = true;
    $('eliminated').hidden = true;
    const me = game.players.get(myId);
    const result = winnerTeam ? (me && me.team === winnerTeam
        ? { won: true, team: winnerTeam }
        : { lost: true, team: winnerTeam })
      : winnerId === null ? { draw: true }
      : winnerId === myId ? { won: true }
      : { lost: true, winnerName };
    setTimeout(() => showResult(result), 700);
  });

  // Powerup tiers, read off any member of the side that owns them.
  function statChips(source) {
    const stats = document.createElement('span');
    stats.className = 'stats';
    const max = game.cfg.MAX_POWERUP_LEVEL;
    const lv = source.levels || {};
    for (const [type, value] of [
      [POWERUP.BOMBS, source.maxBombs],
      [POWERUP.RANGE, source.blastRange],
      [POWERUP.SPEED, lv[POWERUP.SPEED] || 0],
    ]) {
      const chip = document.createElement('span');
      chip.className = `stat ${type}` + ((lv[type] || 0) >= max ? ' maxed' : '');
      chip.title = `${type} ~ level ${lv[type] || 0} of ${max}`;
      chip.textContent = value;
      stats.appendChild(chip);
    }
    return stats;
  }

  function renderHud() {
    const hud = $('hud');
    hud.innerHTML = '';
    // One block per side. In a team mode the tiers are shared, so the chips belong to
    // the team and are shown once rather than repeated under every member.
    const groups = game.teams
      ? game.teams.map(t => ({ label: t, players: [...game.players.values()].filter(p => p.team === t) }))
      : [...game.players.values()].map(p => ({ label: null, players: [p] }));

    for (const g of groups) {
      if (!g.players.length) continue;
      const el = document.createElement('div');
      el.className = 'hud-group' + (g.players.some(p => p.alive) ? '' : ' out');
      if (g.label) {
        const tag = document.createElement('span');
        tag.className = `team-tag ${g.label}`;
        tag.textContent = g.label.toUpperCase();
        el.appendChild(tag);
      }
      for (const p of g.players) {
        const who = document.createElement('span');
        who.className = 'hud-player' + (p.alive ? '' : ' dead');
        const sw = document.createElement('span');
        sw.className = 'swatch';
        sw.style.background = (p.appearance && p.appearance.color) || '#888';
        who.append(sw, p.name + (p.id === myId ? ' (you)' : ''));
        el.appendChild(who);
      }
      el.appendChild(statChips(g.players[0]));
      hud.appendChild(el);
    }
  }

  function overlay(html) {
    const el = $('overlay');
    if (html === null) { el.hidden = true; return; }
    el.innerHTML = html;
    el.hidden = false;
  }

  function showCountdown() {
    const c = game.cfg;
    const tick = () => {
      if (!game) return;
      const left = Math.ceil((game.startAt - performance.now()) / 1000);
      if (left <= 0) {
        overlay('<div class="big">GO!</div>');
        setTimeout(() => { if (game && !game.over) overlay(null); }, 600);
        return;
      }
      overlay(`
        <div class="big">${left}</div>
        <div class="keys">
          <span><kbd>W</kbd> <kbd>A</kbd> <kbd>S</kbd> <kbd>D</kbd></span><span>Move</span>
          <span><kbd>SPACE</kbd></span><span>Drop a bomb</span>
        </div>
        <p class="hint">Blow up the bricks and catch your opponent in a blast.<br>
          Bombs explode after ${(c.FUSE_TIME / 1000).toFixed(1)}s · range ${c.BLAST_RANGE} · max ${c.MAX_BOMBS} at a time<br>
          Bricks can drop powerups ~ <b class="pu-bombs">more bombs</b>,
          <b class="pu-range">bigger blast</b>, <b class="pu-speed">more speed</b>
          ${game.teams ? '<br>Powerups are shared with your team ~ and friendly fire is on.' : ''}</p>`);
      setTimeout(tick, 100);
    };
    tick();
  }

  function showResult({ won, draw, lost, winnerName, team }) {
    const teamName = team ? escapeHtml(team.toUpperCase()) : null;
    if (won) {
      overlay(teamName
        ? `<div class="big team-${team}">${teamName} WINS!</div><p>Your team took it.</p>`
        : '<div class="big">YOU WIN!</div><p>Last one standing.</p>');
    } else if (draw) overlay('<div class="big lose">DRAW</div><p>Nobody survived.</p>');
    else if (teamName) overlay(`<div class="big team-${team}">${teamName} WINS!</div><p>Your team was wiped out.</p>`);
    else overlay(`<div class="big lose">GAME OVER</div><p>${winnerName ? `${escapeHtml(winnerName)} wins.` : 'You got blown up.'}</p>`);
    const btn = document.createElement('button');
    btn.className = 'primary';
    btn.textContent = 'Back to lobby';
    btn.onclick = () => { game = null; overlay(null); show('lobby'); };
    $('overlay').appendChild(btn);
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------- input ----------
  addEventListener('keydown', e => {
    const k = e.key.toLowerCase();
    if (!game) return;
    if (DIRS[k]) {
      e.preventDefault();
      if (!keys.includes(k)) keys.push(k);
    } else if (k === ' ') {
      e.preventDefault();
      if (!e.repeat && canAct()) {
        const me = game.players.get(myId);
        socket.emit('bomb', { x: me.x, y: me.y });
      }
    }
  });
  addEventListener('keyup', e => {
    const i = keys.indexOf(e.key.toLowerCase());
    if (i >= 0) keys.splice(i, 1);
  });
  addEventListener('blur', () => { keys.length = 0; });

  // ---------- touch ----------
  // Left half: a floating stick that spawns under the finger and stays anchored there
  // until it lifts. Movement is 4-way, so the dominant axis picks the direction.
  const joy = $('joy'), knob = $('joy-knob'), gameScreen = $('screen-game');
  const bombBtn = $('bomb-btn'), BOMB_PAD = 30;
  const JOY_R = 60, JOY_DEAD = 14;
  let joyId = null, joyX = 0, joyY = 0;
  function joyMove(t) {
    let dx = t.clientX - joyX, dy = t.clientY - joyY;
    const len = Math.hypot(dx, dy);
    if (len > JOY_R) { dx *= JOY_R / len; dy *= JOY_R / len; }
    knob.style.transform = `translate(${dx}px, ${dy}px)`;
    keys.length = 0;
    if (len > JOY_DEAD) {
      keys.push(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'd' : 'a') : (dy > 0 ? 's' : 'w'));
    }
  }
  function joyEnd() {
    joyId = null; keys.length = 0;
    joy.style.left = joy.style.top = '';      // back to the resting spot
    knob.style.transform = '';
  }
  gameScreen.addEventListener('touchstart', e => {
    if (!game || e.target.closest('button')) return;
    const r = bombBtn.getBoundingClientRect();
    const bx = r.left + r.width / 2, by = r.top + r.height / 2;
    for (const t of e.changedTouches) {
      // A touch close to the bomb button counts as pressing it; anywhere else starts the stick.
      if (Math.hypot(t.clientX - bx, t.clientY - by) < r.width / 2 + BOMB_PAD) { dropBomb(); continue; }
      if (joyId === null) {
        joyId = t.identifier; joyX = t.clientX; joyY = t.clientY;
        joy.style.left = joyX + 'px'; joy.style.top = joyY + 'px';
        joyMove(t);
      }
    }
    e.preventDefault();
  }, { passive: false });
  gameScreen.addEventListener('touchmove', e => {
    for (const t of e.changedTouches) if (t.identifier === joyId) joyMove(t);
    e.preventDefault();
  }, { passive: false });
  for (const ev of ['touchend', 'touchcancel']) {
    gameScreen.addEventListener(ev, e => {
      for (const t of e.changedTouches) if (t.identifier === joyId) joyEnd();
    });
  }
  function dropBomb() {
    if (game && canAct()) {
      const me = game.players.get(myId);
      socket.emit('bomb', { x: me.x, y: me.y });
    }
  }
  bombBtn.addEventListener('touchstart', e => { e.preventDefault(); dropBomb(); }, { passive: false });

  function canAct() {
    const me = game && game.players.get(myId);
    return me && me.alive && !game.over && performance.now() >= game.startAt;
  }

  // ---------- loop ----------
  let last = performance.now();
  function frame(now) {
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    if (game) {
      update(dt, now);
      Render.draw(ctx, game, myId, now);
    }
    requestAnimationFrame(frame);
  }

  function update(dt, now) {
    const me = game.players.get(myId);

    if (me && canAct() && keys.length) {
      // Drop passes for bombs I've fully walked off.
      const under = new Set(overlappedTiles(me.x, me.y, game.cfg.PLAYER_SIZE, game.n));
      for (const i of game.passable) if (!under.has(i)) game.passable.delete(i);
      const blocking = new Set([...game.bombTiles].filter(i => !game.passable.has(i)));

      stepPlayer(me, DIRS[keys[keys.length - 1]], dt, {
        grid: game.grid, n: game.n, bombs: blocking,
        speed: me.speed || game.cfg.PLAYER_SPEED, size: game.cfg.PLAYER_SIZE,
      });
    }

    if (me && (me.x !== game.sentX || me.y !== game.sentY) && now - game.lastSent > 50) {
      socket.emit('move', { x: me.x, y: me.y });
      game.sentX = me.x; game.sentY = me.y; game.lastSent = now;
    }

    // Smooth other players toward their latest server position.
    const k = Math.min(1, dt * 15);
    for (const p of game.players.values()) {
      if (p.id === myId) continue;
      if (Math.hypot(p.x - p.rx, p.y - p.ry) > 2) { p.rx = p.x; p.ry = p.y; }
      p.rx += (p.x - p.rx) * k;
      p.ry += (p.y - p.ry) * k;
    }
  }

  requestAnimationFrame(frame);
})();
