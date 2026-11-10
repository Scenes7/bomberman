// Cloudflare Worker entry point.
//
// Static files in public/ are served straight from Workers Static Assets; only /ws and
// /health reach this code (see run_worker_first in wrangler.jsonc). Each lobby is one
// Durable Object, addressed by its 5-character code, which owns the room's sockets and
// runs the authoritative game loop from server/game.js.
import { DurableObject } from 'cloudflare:workers';
import { Room } from '../server/game.js';
import { MODES } from '../public/shared.js';

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function newCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(5));
  return Array.from(bytes, b => CODE_CHARS[b % CODE_CHARS.length]).join('');
}

function cleanName(name) {
  const s = String(name || '').trim().slice(0, 16);
  return s || 'Guest';
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health') return new Response('ok');
    if (url.pathname !== '/ws') return env.ASSETS.fetch(request);

    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected a WebSocket upgrade', { status: 426 });
    }
    // Only pages served from this host may open game sockets.
    const origin = request.headers.get('Origin');
    if (origin && new URL(origin).host !== url.host) return new Response('Forbidden', { status: 403 });

    const create = url.searchParams.has('create');
    const code = create
      ? newCode()
      : (url.searchParams.get('code') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
    if (code.length !== 5) return new Response('Bad lobby code', { status: 400 });

    const target = new URL('https://lobby/ws');
    target.searchParams.set('code', code);
    const stub = env.LOBBY.get(env.LOBBY.idFromName(code));
    return stub.fetch(new Request(target, request));
  },
};

// One lobby. Uses the WebSocket Hibernation API so an idle lobby costs nothing: between
// matches the object can be evicted from memory and rebuilt from socket attachments and
// storage when the next message arrives. During a match the tick interval keeps it awake.
//
// Each socket's attachment is { id, seq, name, team, joined }; storage holds
// { code, hostId, mode }.
export class Lobby extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.room = null;
    this.code = null;
    this.saved = '';
    // Answered at the edge without waking the object: keeps idle sockets alive for free.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    ctx.blockConcurrencyWhile(async () => {
      const meta = await ctx.storage.get('meta');
      if (meta) this.restore(meta);
      // Everyone left while it slept: nothing to keep.
      if (meta && !this.room) await ctx.storage.deleteAll();
    });
  }

  // The tiny slice of socket.io that Room uses: io.to(code | playerId).emit(type, data).
  get io() {
    return { to: target => ({ emit: (t, d) => this.send(target, t, d) }) };
  }

  send(target, t, d) {
    const msg = JSON.stringify({ t, d });
    const sockets = target === this.code ? this.ctx.getWebSockets() : this.ctx.getWebSockets(target);
    for (const ws of sockets) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      const a = ws.deserializeAttachment();
      if (!a || !a.joined) continue;
      try { ws.send(msg); } catch {}
    }
  }

  joinedSockets() {
    return this.ctx.getWebSockets()
      .map(ws => ({ ws, a: ws.deserializeAttachment() }))
      .filter(({ ws, a }) => a && a.joined && ws.readyState === WebSocket.OPEN)
      .sort((x, y) => x.a.seq - y.a.seq);
  }

  // Rebuild the lobby after hibernation. Join order (seq) is the Map order Room relies
  // on for host succession and spawn seats.
  restore(meta) {
    this.code = meta.code;
    const room = new Room(meta.code, this.io);
    for (const { a } of this.joinedSockets()) room.players.set(a.id, { id: a.id, name: a.name, team: a.team });
    if (!room.players.size) return;
    room.hostId = room.players.has(meta.hostId) ? meta.hostId : room.players.keys().next().value;
    if (MODES[meta.mode]) room.mode = MODES[meta.mode];
    this.room = room;
    this.saved = JSON.stringify(meta);
  }

  // Write lobby state where it survives hibernation. Called after anything that can
  // change the roster, host, mode or teams -- never on the move/bomb hot path.
  async persist() {
    const room = this.room;
    if (!room || room.players.size === 0) {
      if (room) room.destroy();
      this.room = null;
      if (this.saved) { this.saved = ''; await this.ctx.storage.deleteAll(); }
      return;
    }
    for (const { ws, a } of this.joinedSockets()) {
      const p = room.players.get(a.id);
      if (p && p.team !== a.team) ws.serializeAttachment({ ...a, team: p.team });
    }
    const meta = { code: room.code, hostId: room.hostId, mode: room.mode.id };
    const json = JSON.stringify(meta);
    if (json !== this.saved) { this.saved = json; await this.ctx.storage.put('meta', meta); }
  }

  async fetch(request) {
    const code = new URL(request.url).searchParams.get('code');
    this.code = this.code || code;
    const pair = new WebSocketPair();
    const id = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
    // The player id doubles as the socket's tag, so io.to(id) is a direct lookup.
    this.ctx.acceptWebSocket(pair[1], [id]);
    pair[1].serializeAttachment({ id, joined: false });
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws, raw) {
    if (typeof raw !== 'string' || raw.length > 2048) return;
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg.t !== 'string') return;
    const d = msg.d && typeof msg.d === 'object' ? msg.d : {};
    const a = ws.deserializeAttachment() || {};
    const ack = res => ws.send(JSON.stringify({ t: 'ack', n: msg.n, d: res }));
    const room = this.room;
    const me = a.joined ? a.id : null;

    switch (msg.t) {
      case 'move': if (room && me) room.handleMove(me, d); return;
      case 'bomb': if (room && me) room.handleBomb(me, d); return;

      case 'createLobby':
        if (me) return;
        // A fresh random code landed on a live lobby: astronomically rare, just retry.
        if (room) return ack({ ok: false, error: 'Could not create a lobby, please try again.' });
        this.room = new Room(this.code, this.io);
        // The host may pick the mode up front; an unknown value just leaves the default.
        if (d.mode) this.room.setMode(String(d.mode));
        this.join(ws, a, d.name, ack);
        break;

      case 'joinLobby':
        if (me) return;
        if (!room) return ack({ ok: false, error: 'Lobby not found.' });
        if (room.state !== 'lobby') return ack({ ok: false, error: 'That match is already in progress.' });
        if (room.players.size >= room.mode.maxPlayers) return ack({ ok: false, error: 'Lobby is full.' });
        this.join(ws, a, d.name, ack);
        break;

      // Host-only lobby settings.
      case 'setMode':
        if (!room || room.hostId !== me) return;
        room.setMode(String(d.mode || ''));
        break;

      // Any player picks their own team.
      case 'setTeam':
        if (!room || !me) return;
        room.setTeam(me, String(d.team || ''));
        break;

      case 'startGame':
        if (!room || room.hostId !== me || room.state !== 'lobby') return;
        if (room.startBlocker()) return;
        room.start();
        break;

      default: return;
    }
    await this.persist();
  }

  // `ack` runs before the room is told, so the client knows its own id before any
  // lobby payload arrives and can render "you", HOST and team state correctly.
  join(ws, a, name, ack) {
    const clean = cleanName(name);
    ws.serializeAttachment({ ...a, joined: true, name: clean, seq: Date.now() + Math.random() });
    ack({ ok: true, code: this.code, id: a.id });
    this.room.addPlayer(a.id, clean);
  }

  async webSocketClose(ws, code) {
    try { ws.close(code === 1005 ? 1000 : code, 'closing'); } catch {}
    await this.leave(ws);
  }

  async webSocketError(ws) {
    await this.leave(ws);
  }

  async leave(ws) {
    const a = ws.deserializeAttachment();
    if (!a || !a.joined || a.left) return;
    try { ws.serializeAttachment({ ...a, joined: false, left: true }); } catch {}
    if (this.room) this.room.removePlayer(a.id);
    await this.persist();
  }
}
