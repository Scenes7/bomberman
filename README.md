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

## Deploy to Lightsail (container service)

Requires Docker, the AWS CLI and the `lightsailctl` plugin.

```
docker build -t bomberman .
aws lightsail create-container-service --service-name bomberman --power nano --scale 1
aws lightsail push-container-image --service-name bomberman --label app --image bomberman
aws lightsail create-container-service-deployment --service-name bomberman \
  --containers file://lightsail/containers.json \
  --public-endpoint file://lightsail/endpoint.json
aws lightsail get-container-services --service-name bomberman   # shows the public URL
```

Keep `--scale 1`: lobbies live in server memory. To redeploy, push the image again and
re-run the deployment command.

**Alternative (Lightsail instance):** on an Ubuntu instance with Docker installed,
clone the repo and run `docker compose up -d --build` (serves on port 80).

## Hosting the frontend separately (optional)

The server serves `public/` itself. To host the static files elsewhere instead, set
`window.SERVER_URL` in `public/config.js`, point the socket.io `<script>` in
`index.html` at `<SERVER_URL>/socket.io/socket.io.js`, and start the server with
`CORS_ORIGINS=https://your-frontend.example`.
