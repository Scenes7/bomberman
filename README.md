# Bomberman

Online Bomberman, free-for-all or Red vs Blue. Static frontend (HTML / vanilla JS / CSS) in `public/`,
Node + socket.io server in `server/`, packaged with Docker for AWS Lightsail.

## Run locally

```
npm install
npm start          # http://localhost:3000
```

Create a lobby, copy the link, and open it in other browser windows (or send it to friends).
The host picks the mode when creating the lobby and can change it until the match starts.

| Mode | Players | Spawns | Win |
| --- | --- | --- | --- |
| Free-for-all | 2-4 | one per map corner | last player alive |
| Teams | 2-8 | red along the top row, blue along the bottom | last team with anyone alive |

In team mode each player picks their own side, uneven teams are fine, powerup tiers are
shared by the whole team, and friendly fire is on. A player who is knocked out keeps
watching and only sees the result once their whole team is gone. The host can't switch a
lobby back to free-for-all while more than four people are in it.

## Tuning

All gameplay numbers are in `CONFIG` at the top of `public/shared.js`:
`PLAYER_SPEED`, `FUSE_TIME`, `MAX_BOMBS`, `BLAST_RANGE`, `GRID_SIZE`, `COUNTDOWN`,
map density, etc. The server sends its values to clients when a match starts,
so just edit and restart the server.

Powerups are tuned there too: `POWERUP_DROP_CHANCE` (odds a destroyed block leaves
one), `MAX_POWERUP_LEVEL` (how many times each stat can be raised) and `SPEED_STEP`.
Players start at `MAX_BOMBS` bombs and `BLAST_RANGE` reach and upgrade from there;
speed stacks on the base rather than compounding, so the level cap is a 2.4x sprint
rather than a 3.6x one.

## Adding a game mode

Modes live in one table, `MODES` in `public/shared.js`. An entry owns everything that
varies between them, so a new mode is additive rather than a rewrite:

- `maxPlayers` -- the seat cap (the lobby and the join check both read it from here)
- `teams` -- the list of sides, or `null` when every player is their own side
- `spawns(n, roster)` -- one position per player, in join order
- `clearZones(n)` -- tiles the map generator must leave walkable

Three shared helpers then do the rest: `factionOf` decides who counts as a side when
working out the winner, `statsKeyFor` decides who shares powerup tiers (teammates share
one key, so they share one stats block), and `startBlocker` says why a lobby can't start
yet. The client builds its mode picker from the list the server sends, so a new mode shows
up in the UI without a client change.

Player looks come from `appearanceFor(mode, team, seat)`, which returns an object rather
than a bare colour -- avatar options (hats, faces, trails) can be added to it without
touching the renderer's call sites.

## Deployment

- **Frontend** ~ GitHub Pages via `.github/workflows/pages.yml` (Settings → Pages → Source:
  *GitHub Actions*). Runs on every push to `main` that touches `public/`, or manually from the
  Actions tab. `public/config.js` points the Pages site at the backend below. Live at
  <http://bomberman.dreamteamhub.ca/> ~ a custom domain CNAME'd to `scenes7.github.io`.
- **Backend** ~ Lightsail instance `bomberman` (us-east-1, static IP `34.198.211.103`), served at
  `https://34-198-211-103.sslip.io`. It runs `deploy/docker-compose.yml`: the game server plus
  Caddy, which gets the HTTPS certificate automatically. `deploy/.env` on the server sets
  `DOMAIN` and `CORS_ORIGINS`. That file is not in the repo, so a redeploy from a fresh clone
  must recreate it:

  ```
  DOMAIN=34-198-211-103.sslip.io
  CORS_ORIGINS=https://scenes7.github.io,https://bomberman.dreamteamhub.ca,http://bomberman.dreamteamhub.ca
  ```

  Every origin the frontend is served from must be listed in `CORS_ORIGINS`, or the browser
  blocks the socket.io connection and "Create lobby" silently does nothing.

To redeploy the backend, copy the repo to `~/bomberman` on the instance and run:

```
sudo docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build
```

If the backend moves, update the URL in `public/config.js` and `CORS_ORIGINS` in `deploy/.env`.
If the frontend moves to a new domain, add that domain to `CORS_ORIGINS` and restart the backend.
