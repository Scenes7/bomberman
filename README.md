# Bomberman

2-player online Bomberman. Static frontend (HTML / vanilla JS / CSS) in `public/`,
Node + socket.io server in `server/`, packaged with Docker for AWS Lightsail.

## Run locally

```
npm install
npm start          # http://localhost:3000
```

Create a lobby, copy the link, open it in a second browser window (or send it to a friend).

## Tuning

All gameplay numbers are in `CONFIG` at the top of `public/shared.js`:
`PLAYER_SPEED`, `FUSE_TIME`, `MAX_BOMBS`, `BLAST_RANGE`, `GRID_SIZE`, `COUNTDOWN`,
map density, etc. The server sends its values to clients when a match starts,
so just edit and restart the server.

## Deployment

- **Frontend** — GitHub Pages via `.github/workflows/pages.yml` (Settings → Pages → Source:
  *GitHub Actions*). Runs on every push to `main` that touches `public/`, or manually from the
  Actions tab. `public/config.js` points the Pages site at the backend below.
- **Backend** — Lightsail instance `bomberman` (us-east-1, static IP `34.198.211.103`), served at
  `https://34-198-211-103.sslip.io`. It runs `deploy/docker-compose.yml`: the game server plus
  Caddy, which gets the HTTPS certificate automatically. `deploy/.env` on the server sets
  `DOMAIN` and `CORS_ORIGINS`.

To redeploy the backend, copy the repo to `~/bomberman` on the instance and run:

```
sudo docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build
```

If the backend moves, update the URL in `public/config.js` and `CORS_ORIGINS` in `deploy/.env`.
