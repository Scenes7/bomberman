# Bomberman

Online Bomberman, free-for-all or Red vs Blue. Static frontend (HTML / vanilla JS / CSS) in `public/`,
authoritative game server in `server/game.js`, hosted on Cloudflare Workers + Durable Objects
(free plan) by `worker/index.js`.

## Run locally

```
npm install
npm run dev        # http://localhost:8787 (wrangler dev, with a local Durable Object)
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
so just edit and redeploy.

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

## Architecture

- **Static files** -- `public/` is served by Workers Static Assets. Asset requests never run
  the Worker, so they're free and unmetered.
- **`/ws`** -- the Worker routes each WebSocket to a Durable Object named by the 5-character
  lobby code (`/ws?create=1` picks a fresh code). One object per lobby owns its sockets and
  runs `Room` from `server/game.js` at 30 ticks/s while a match is on.
- **Wire format** -- JSON `{ t, d, n? }` frames. `public/net.js` is a tiny socket.io-style
  wrapper (`on` / `emit` with an ack callback), so `client.js` and `game.js` kept their
  event names: `createLobby`, `joinLobby`, `setMode`, `setTeam`, `startGame`, `move`, `bomb`
  up; `lobby`, `start`, `state`, `correction`, `gameOver` down.
- **Hibernation** -- lobbies use the WebSocket Hibernation API. Between matches an idle lobby
  is evicted from memory and rebuilt from per-socket attachments plus one storage key, and
  the client's 30 s `ping` is answered by an auto-response without waking it, so idle lobbies
  cost nothing. Redeploying the Worker drops every open socket (players see DISCONNECTED).

Free-plan budget: incoming WebSocket messages bill at 20:1 against the 100,000 requests/day
Durable Object allowance. Clients send at most 20 moves/s, so that's roughly 7 hours of
4-player play per day.

## Deployment

Live at <https://bomberman.dreamteamhub.ca/> -- a Worker custom domain on the Cloudflare zone
`dreamteamhub.ca`; Cloudflare manages the DNS record and certificate. Also reachable at
`bomberman.<account>.workers.dev`.

```
npx wrangler login     # once per machine
npm run deploy         # wrangler deploy: uploads public/ and the Worker together
```

Frontend and backend ship together in one deploy, so `public/shared.js` can no longer drift
between them. Live logs: `npx wrangler tail`.
