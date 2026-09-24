(() => {
  const { stepPlayer, overlappedTiles } = Shared;
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

  const inviteCode = new URLSearchParams(location.search).get('lobby');
  if (inviteCode) {
    $('code').value = inviteCode.toUpperCase();
    $('invite').hidden = false;
    $('invite').textContent = `You've been invited to lobby ${inviteCode.toUpperCase()} — enter your name and hit Join.`;
  }
  (nameInput.value ? $(inviteCode ? 'join' : 'create') : nameInput).focus();

  function playerName() {
    const name = nameInput.value.trim() || 'Guest';
    try { localStorage.setItem('bomberman-name', name); } catch {}
    return name;
  }

  function entered(res) {
    if (!res.ok) { $('home-error').textContent = res.error; return; }
    myId = res.id;
    history.replaceState(null, '', `?lobby=${res.code}`);
    show('lobby');
  }

  $('create').onclick = () => socket.emit('createLobby', { name: playerName() }, entered);
  $('join').onclick = () => {
    const code = $('code').value.trim();
    if (!code) { $('home-error').textContent = 'Enter a lobby code.'; return; }
    socket.emit('joinLobby', { code, name: playerName() }, entered);
  };
  $('code').addEventListener('keydown', e => { if (e.key === 'Enter') $('join').click(); });
  nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') $(inviteCode ? 'join' : 'create').click(); });

  // ---------- lobby ----------
  socket.on('lobby', data => {
    lobby = data;
    $('lobby-code').textContent = data.code;
    $('link').value = `${location.origin}${location.pathname}?lobby=${data.code}`;

    const list = $('player-list');
    list.innerHTML = '';
    for (let i = 0; i < data.maxPlayers; i++) {
      const p = data.players[i];
      const li = document.createElement('li');
      if (p) {
        li.textContent = p.name + (p.id === myId ? ' (you)' : '');
        if (p.id === data.hostId) {
          const tag = document.createElement('span');
          tag.className = 'tag';
          tag.textContent = 'HOST';
          li.appendChild(tag);
        }
      } else {
        li.className = 'empty';
        li.textContent = 'Waiting for player…';
      }
      list.appendChild(li);
    }

    const isHost = data.hostId === myId;
    const ready = data.players.length >= 2;
    $('start').hidden = !isHost;
    $('start').disabled = !ready;
    $('lobby-status').textContent = !ready ? 'Share the link — the match can start once 2 players are here.'
      : isHost ? 'Everyone is here. Start when ready!'
      : 'Waiting for the host to start…';
  });

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
      n,
      grid: [...data.grid].map(Number),
      players: new Map(data.players.map(p => [p.id, { ...p, rx: p.x, ry: p.y }])),
      bombs: [],
      bombTiles: new Set(),
      flames: [],
      passable: new Set(),   // bombs I'm standing on and may walk off of
      startAt: performance.now() + data.countdown,
      lastSent: 0,
      sentX: null, sentY: null,
      over: false,
    };
    keys.length = 0;
    Render.setup(canvas, n);
    renderHud();
    show('game');
    showCountdown();
  });

  socket.on('state', s => {
    if (!game) return;
    const now = performance.now();
    if (s.grid) game.grid = [...s.grid].map(Number);
    game.flames = s.flames;

    for (const sp of s.players) {
      const p = game.players.get(sp.id);
      if (!p) continue;
      if (p.alive !== sp.alive) { p.alive = sp.alive; renderHud(); }
      if (sp.id !== myId) { p.x = sp.x; p.y = sp.y; }
    }

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
      game.over = true;
      setTimeout(() => showResult({ lost: true }), 700);
    }
  });

  socket.on('correction', pos => {
    const me = game && game.players.get(myId);
    if (me) { me.x = pos.x; me.y = pos.y; }
  });

  socket.on('gameOver', ({ winnerId, winnerName }) => {
    if (!game) return;
    game.over = true;
    const result = winnerId === myId ? { won: true }
      : winnerId === null ? { draw: true }
      : { lost: true, winnerName };
    setTimeout(() => showResult(result), 700);
  });

  function renderHud() {
    $('hud').innerHTML = '';
    for (const p of game.players.values()) {
      const el = document.createElement('div');
      el.className = 'hud-player' + (p.alive ? '' : ' dead');
      const sw = document.createElement('span');
      sw.className = 'swatch';
      sw.style.background = p.color;
      el.append(sw, p.name + (p.id === myId ? ' (you)' : ''));
      $('hud').appendChild(el);
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
          Bombs explode after ${(c.FUSE_TIME / 1000).toFixed(1)}s · range ${c.BLAST_RANGE} · max ${c.MAX_BOMBS} at a time</p>`);
      setTimeout(tick, 100);
    };
    tick();
  }

  function showResult({ won, draw, lost, winnerName }) {
    if (won) overlay('<div class="big">YOU WIN!</div><p>Last one standing.</p>');
    else if (draw) overlay('<div class="big lose">DRAW</div><p>Nobody survived.</p>');
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
        speed: game.cfg.PLAYER_SPEED, size: game.cfg.PLAYER_SIZE,
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
