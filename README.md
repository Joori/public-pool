## Description

A Nestjs and Typescript Bitcoin stratum mining server.

## Installation

```bash
$ npm install
```

create an new .env file in the root directory and configure it with the parameters in .env.example

## Running the app

```bash
# development
$ npm run start

# watch mode
$ npm run start:dev

# production build
$ npm run build
```

## Test

```bash
# unit tests
$ npm run test

# test coverage
$ npm run test:cov
```

## Web interface

See [public-pool-ui](https://github.com/benjamin-wilson/public-pool-ui)

## Deployment

The production Docker image runs database migrations and then starts PM2
automatically. For a manual host deployment, install pm2
(https://pm2.keymetrics.io/), run migrations, then start the app.

```bash
$ npm run build
$ npm run migration:run:prod
$ pm2 start dist/main.js
```

When running the worker app in PM2 cluster mode, start the PM2 daemon with OS-level
connection scheduling. The environment variable must be present when the PM2 daemon
starts, not only in the worker configuration.

```bash
$ NODE_CLUSTER_SCHED_POLICY=none pm2 start ecosystem.config.js
```

Cluster-mode connection dropping requires Node.js `22.12.0` or newer.

`STRATUM_MAX_CONNECTIONS_PER_LISTENER` is enforced per worker and Stratum port.
Size it using the busiest port: `worker count * limit`. For example, 28 workers
with the default limit of `10000` allow up to `280000` connections on one port.

## Docker

The default compose stack includes Public Pool, TimescaleDB, and Redis. TimescaleDB
stores normal Postgres tables plus immutable accepted-share rows in a hypertable.
Chart and hashrate APIs read from Timescale continuous aggregates plus recent raw
shares for realtime buckets. Redis is used only for process messaging and latest
mining-template replay.

Start the stack:

```bash
$ docker compose up --build -d
```

Use an external TimescaleDB/Postgres server:

```bash
$ DB_HOST=postgres.example.com \
  DB_PORT=5432 \
  DB_USERNAME=public_pool \
  DB_PASSWORD='change-me' \
  DB_DATABASE=public_pool \
  DB_SSL=false \
  docker compose -f docker-compose.external-db.yml up --build -d
```

The external database must be TimescaleDB-compatible and reachable from the
Public Pool container. The startup script waits for the remote `DB_HOST:DB_PORT`,
runs migrations, then starts PM2. Redis still runs locally in this compose file
unless `REDIS_URL` is pointed at an external Redis instance.

Set `DB_SSL=true` if the external database requires TLS. For private CA or
self-signed test deployments, `DB_SSL_REJECT_UNAUTHORIZED=false` disables
certificate verification; do not use that setting for normal internet-facing
production databases.

For a fresh external database, create the role/database first:

```sql
CREATE USER public_pool WITH PASSWORD 'change-me';
CREATE DATABASE public_pool OWNER public_pool;
\c public_pool
CREATE EXTENSION IF NOT EXISTS timescaledb;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
```

If TimescaleDB is managed by another operator, make sure the `public_pool` role
can create tables, indexes, continuous aggregates, and Timescale policies in the
target database.

Run only the database migrations:

```bash
$ docker compose run --rm public-pool npm run migration:run:prod
```

Watch logs:

```bash
$ docker compose logs --tail 100 -f public-pool
```

Back up TimescaleDB:

```bash
$ docker compose exec timescaledb pg_dump -U public_pool public_pool > public-pool.sql
```

Redis does not hold durable accounting data. Losing Redis requires workers to
replay the latest template from Redis after reconnect or fall back to the saved
RPC block template table.

**note**: To successfully connect to the bitcoin RPC you will need to add

```
rpcallowip=172.16.0.0/12
zmqpubrawblock=tcp://0.0.0.0:3000
```

to your bitcoin.conf.

## TLS certificates

This fork does not ship `.pem` files, and never will: committing a private key
to a public repository makes the TLS on `SECURE_STRATUM_PORTS` decorative,
anyone who clones the repo holds the same key and can decrypt or impersonate
the server.

When `STRATUM_SECURE=true` and no certificate is found, the container
generates a self-signed RSA-2048 cert/key pair on startup (valid ~10 years)
into `secrets-generated/`, logs that a self-signed certificate is in use, and
uses it. That directory is a Docker volume so the generated pair persists
across restarts instead of being regenerated (and changing fingerprint) every
time. Self-signed certs encrypt the connection but don't verify server
identity, so miners must accept/pin the certificate out of band.

To use a real certificate instead, place it at `secrets/cert.pem` and
`secrets/key.pem` (or point `STRATUM_TLS_CERT_PATH` / `STRATUM_TLS_KEY_PATH` at
another location) before starting the container. Real certs there always take
precedence over a generated one. The `secrets/` directory is mounted read-only,
so certs placed there are never modified by the app.

If TLS certs are missing or unreadable at runtime, only the TLS stratum
listeners fail to start, plaintext stratum ports are unaffected.

## Testing

Baseline unit regression capture:

```bash
$ npm run test:baseline
```

Unit tests:

```bash
$ npm test
```

Integration tests against real TimescaleDB and Redis:

```bash
$ docker compose -f docker-compose.test.yml up --build --abort-on-container-exit
```
