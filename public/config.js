// Where the socket.io server lives. When this page is served by the game server
// itself (local dev, or the backend URL directly) it connects to the same origin;
// anywhere else (e.g. GitHub Pages) it connects to the deployed backend.
window.SERVER_URL = /^(localhost|127\.0\.0\.1)$|sslip\.io$/.test(location.hostname)
  ? ''
  : 'https://34-198-211-103.sslip.io';
