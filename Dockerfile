# syntax=docker/dockerfile:1

# ---- build stage -------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app

# Install with the lockfile first so this layer caches across source edits.
COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build

# Drop dev dependencies from the tree we are about to copy forward.
RUN npm prune --omit=dev

# ---- runtime stage -----------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    MCP_TRANSPORT=http \
    PORT=3000 \
    HOST=0.0.0.0 \
    LOG_LEVEL=info

# Run as an unprivileged user. node:alpine ships a `node` user already.
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
COPY --chown=node:node server.json ./

USER node
EXPOSE 3000

# The server exposes a real liveness endpoint; use it rather than guessing.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Default to HTTP because that is what containers are useful for. For stdio,
# run: docker run -i --rm foodpanda-mcp node dist/index.js --stdio
CMD ["node", "dist/index.js", "--http"]
