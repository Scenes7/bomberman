// A minimal socket.io-style wrapper over a plain WebSocket to the Cloudflare Worker.
//
//   const socket = Net.connect();
//   socket.on('lobby', fn);
//   socket.emit('move', data);
//   socket.emit('createLobby', data, ack);   // ack(res) once the server answers
//
// No connection is held until the player creates or joins a lobby: each lobby lives in
// its own Durable Object, so the socket URL names the lobby. A failed join closes that
// socket quietly; 'disconnect' fires only once the player was actually in a lobby.
(function (root) {
  const PING_MS = 30000;

  function connect() {
    const handlers = {};
    let ws = null;
    let joined = false;
    let pending = null;       // the create/join ack waiting on this socket
    let nextAck = 1;
    const acks = new Map();

    const fire = (t, d) => (handlers[t] || []).forEach(fn => fn(d));

    function open(query) {
      if (ws) { const old = ws; ws = null; try { old.close(); } catch {} }
      const sock = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?${query}`);
      const queue = [];
      let ping = null;
      ws = sock;
      sock.sendOrQueue = s => (sock.readyState === 1 ? sock.send(s) : queue.push(s));
      sock.onopen = () => {
        queue.splice(0).forEach(s => sock.send(s));
        // Answered by the Durable Object's auto-response, so idle lobbies stay open.
        ping = setInterval(() => sock.readyState === 1 && sock.send('ping'), PING_MS);
      };
      sock.onmessage = e => {
        if (e.data === 'pong') return;
        let m;
        try { m = JSON.parse(e.data); } catch { return; }
        if (m.t !== 'ack') return fire(m.t, m.d);
        const fn = acks.get(m.n);
        acks.delete(m.n);
        if (fn === pending) {
          pending = null;
          if (m.d && m.d.ok) joined = true;
          else { ws = null; sock.close(); }
        }
        if (fn) fn(m.d);
      };
      sock.onclose = () => {
        clearInterval(ping);
        if (ws !== sock) return;           // replaced or deliberately dropped
        ws = null;
        if (joined) { joined = false; fire('disconnect'); return; }
        const fn = pending;
        pending = null;
        acks.clear();
        if (fn) fn({ ok: false, error: 'Could not reach the game server.' });
      };
    }

    function send(t, d, ack) {
      if (!ws) return;
      const m = { t, d };
      if (typeof ack === 'function') { m.n = nextAck++; acks.set(m.n, ack); }
      ws.sendOrQueue(JSON.stringify(m));
    }

    return {
      on(t, fn) { (handlers[t] = handlers[t] || []).push(fn); },
      emit(t, d, ack) {
        if (t === 'createLobby' || t === 'joinLobby') {
          if (joined || pending) return;
          const code = String((d && d.code) || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
          if (t === 'joinLobby' && code.length !== 5) {
            if (ack) ack({ ok: false, error: 'Lobby not found.' });
            return;
          }
          const token = d && d.token && /^[0-9a-f-]{36}$/.test(d.token) ? d.token : '';
          open(t === 'createLobby' ? 'create=1' : `code=${code}${token ? `&token=${token}` : ''}`);
          pending = ack;
        }
        send(t, d, ack);
      },
    };
  }

  root.Net = { connect };
})(window);
