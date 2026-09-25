// Canvas drawing. Everything is in tile units scaled by T; the map is drawn
// inside a one-tile border of hard walls.
const Render = (() => {
  const T = 32;
  const { TILE, POWERUP } = Shared;

  function setup(canvas, n) {
    canvas.width = canvas.height = (n + 2) * T;
  }

  function hardWall(ctx, px, py) {
    ctx.fillStyle = '#9aa0a6';
    ctx.fillRect(px, py, T, T);
    ctx.fillStyle = '#d3d7db';
    ctx.fillRect(px, py, T, 4);
    ctx.fillRect(px, py, 4, T);
    ctx.fillStyle = '#5b6066';
    ctx.fillRect(px, py + T - 4, T, 4);
    ctx.fillRect(px + T - 4, py, 4, T);
  }

  function softBlock(ctx, px, py) {
    ctx.fillStyle = '#5d6166';
    ctx.fillRect(px, py, T, T);
    ctx.fillStyle = '#a7abb0';
    const rowH = T / 4;
    for (let r = 0; r < 4; r++) {
      const offset = r % 2 ? T / 4 : 0;
      for (let c = -1; c < 2; c++) {
        const bx = px + offset + c * (T / 2) + 1;
        const x0 = Math.max(bx, px), x1 = Math.min(bx + T / 2 - 2, px + T);
        if (x1 > x0) ctx.fillRect(x0, py + r * rowH + 1, x1 - x0, rowH - 2);
      }
    }
  }

  function floor(ctx, px, py, checker) {
    ctx.fillStyle = checker ? '#2f8a3a' : '#33943f';
    ctx.fillRect(px, py, T, T);
  }

  function bomb(ctx, b, now) {
    const cx = (b.x + 1.5) * T, cy = (b.y + 1.5) * T;
    const left = Math.max(0, b.explodeAt - now);
    const pulse = 1 + 0.08 * Math.sin(now / (60 + left / 20));
    const r = T * 0.34 * pulse;
    ctx.fillStyle = '#111';
    ctx.beginPath(); ctx.arc(cx, cy + 2, r, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.beginPath(); ctx.arc(cx - r * 0.35, cy - r * 0.25, r * 0.22, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#c8a26b'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(cx + r * 0.5, cy - r * 0.6); ctx.lineTo(cx + r * 0.8, cy - r * 1.05); ctx.stroke();
    ctx.fillStyle = Math.floor(now / 80) % 2 ? '#ffdf5a' : '#ff7a00';
    ctx.beginPath(); ctx.arc(cx + r * 0.85, cy - r * 1.1, 3, 0, Math.PI * 2); ctx.fill();
  }

  // Powerups: a coloured plate with a glyph, bobbing gently so they read as pickups.
  // Colours match the HUD chips for the same stat.
  const PU = {
    [POWERUP.BOMBS]: { plate: '#1f2a44', edge: '#5b8def', mark: '#dfe7ff' },
    [POWERUP.RANGE]: { plate: '#3d1a12', edge: '#ff8a3c', mark: '#ffd9a0' },
    [POWERUP.SPEED]: { plate: '#0f3a33', edge: '#2fd6a8', mark: '#c9fff1' },
  };

  function powerup(ctx, pu, now) {
    const style = PU[pu.t] || PU[POWERUP.BOMBS];
    const bob = Math.sin(now / 320 + pu.x * 1.7 + pu.y) * 1.5;
    const px = (pu.x + 1) * T, py = (pu.y + 1) * T + bob;
    const pad = 5, size = T - pad * 2;

    ctx.fillStyle = style.plate;
    ctx.fillRect(px + pad, py + pad, size, size);
    ctx.strokeStyle = style.edge;
    ctx.lineWidth = 2;
    ctx.strokeRect(px + pad + 1, py + pad + 1, size - 2, size - 2);

    const cx = px + T / 2, cy = py + T / 2;
    ctx.fillStyle = style.mark;
    ctx.strokeStyle = style.mark;
    ctx.lineWidth = 2;
    if (pu.t === POWERUP.BOMBS) {
      // two stacked bombs
      ctx.beginPath(); ctx.arc(cx - 3, cy + 2, 4, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(cx + 4, cy - 2, 3, 0, Math.PI * 2); ctx.fill();
    } else if (pu.t === POWERUP.RANGE) {
      // outward arrows
      ctx.beginPath();
      ctx.moveTo(cx - 7, cy); ctx.lineTo(cx + 7, cy);
      ctx.moveTo(cx, cy - 7); ctx.lineTo(cx, cy + 7);
      ctx.stroke();
      ctx.beginPath(); ctx.arc(cx, cy, 2.5, 0, Math.PI * 2); ctx.fill();
    } else {
      // double chevron
      ctx.beginPath();
      ctx.moveTo(cx - 6, cy - 5); ctx.lineTo(cx - 1, cy); ctx.lineTo(cx - 6, cy + 5);
      ctx.moveTo(cx + 1, cy - 5); ctx.lineTo(cx + 6, cy); ctx.lineTo(cx + 1, cy + 5);
      ctx.stroke();
    }
  }

  function flame(ctx, i, n) {
    const px = (i % n + 1) * T, py = (Math.floor(i / n) + 1) * T;
    ctx.fillStyle = '#ff6a00'; ctx.fillRect(px + 1, py + 1, T - 2, T - 2);
    ctx.fillStyle = '#ffc230'; ctx.fillRect(px + 6, py + 6, T - 12, T - 12);
    ctx.fillStyle = '#fff7cf'; ctx.fillRect(px + 11, py + 11, T - 22, T - 22);
  }

  function player(ctx, p, isMe) {
    const cx = (p.x + 1) * T, cy = (p.y + 1) * T;
    ctx.globalAlpha = p.alive ? 1 : 0.3;
    // body
    ctx.fillStyle = p.color;
    ctx.strokeStyle = '#000'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(cx, cy + 5, T * 0.26, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    // head
    ctx.fillStyle = '#f5f5f5';
    ctx.beginPath(); ctx.arc(cx, cy - 5, T * 0.24, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    // visor + eyes
    ctx.fillStyle = '#f7a1b5';
    ctx.fillRect(cx - 7, cy - 8, 14, 7);
    ctx.fillStyle = '#000';
    ctx.fillRect(cx - 4, cy - 7, 2, 5);
    ctx.fillRect(cx + 2, cy - 7, 2, 5);
    // antenna
    ctx.fillStyle = '#ff4d6d';
    ctx.beginPath(); ctx.arc(cx, cy - 5 - T * 0.3, 3, 0, Math.PI * 2); ctx.fill();
    // name tag
    ctx.font = '10px "Press Start 2P", monospace';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#000';
    ctx.fillText(p.name, cx + 1, cy - T * 0.55 + 1);
    ctx.fillStyle = isMe ? '#f5b301' : '#fff';
    ctx.fillText(p.name, cx, cy - T * 0.55);
    ctx.globalAlpha = 1;
  }

  function draw(ctx, g, myId, now) {
    const n = g.n;
    for (let y = -1; y <= n; y++) {
      for (let x = -1; x <= n; x++) {
        const px = (x + 1) * T, py = (y + 1) * T;
        if (x < 0 || y < 0 || x >= n || y >= n) { hardWall(ctx, px, py); continue; }
        const t = g.grid[y * n + x];
        if (t === TILE.HARD) hardWall(ctx, px, py);
        else if (t === TILE.SOFT) softBlock(ctx, px, py);
        else floor(ctx, px, py, (x + y) % 2 === 0);
      }
    }
    for (const pu of g.powerups) powerup(ctx, pu, now);
    for (const b of g.bombs) bomb(ctx, b, now);
    for (const i of g.flames) flame(ctx, i, n);
    for (const p of g.players.values()) {
      if (p.id === myId) continue;
      player(ctx, { ...p, x: p.rx, y: p.ry }, false);
    }
    const me = g.players.get(myId);
    if (me) player(ctx, me, true);
  }

  return { setup, draw };
})();
