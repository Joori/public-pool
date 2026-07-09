############################
# Docker build environment #
############################

FROM node:24.16.0-bookworm-slim AS build

# Upgrade all packages and install dependencies
RUN apt-get update \
    && apt-get upgrade -y
RUN DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        python3 \
        build-essential \
        cmake \
        curl \
        ca-certificates \
    && apt clean && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

WORKDIR /build

COPY . .

# Build Public Pool using NPM
RUN npm ci && npm run build && npm prune --omit=dev

############################
# Docker final environment #
############################

FROM node:24.16.0-bookworm-slim

# openssl generates a self-signed TLS cert/key pair on first run when none is
# supplied (see src/scripts/start-docker.ts / README "TLS certificates").
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl \
    && apt clean && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

# Expose ports for Stratum and Bitcoin RPC
EXPOSE 3333 3334 8332

WORKDIR /public-pool

# Copy built binaries into the final image
COPY --from=build /build .
#COPY .env.example .env

CMD ["npm", "run", "start:docker"]
