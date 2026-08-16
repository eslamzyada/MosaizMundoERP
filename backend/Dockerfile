# =============================================================================
# The API gateway, as a container.
#
# Two stages: the builder carries the TypeScript compiler, Prisma's generator
# and every devDependency; the runtime carries none of them. What ships is the
# compiled dist/, the production node_modules, and the generated Prisma client.
#
# Node 20 to match the engine this is developed and CI-built against.
# =============================================================================

# ---- build ------------------------------------------------------------------
FROM node:20-slim AS build

# openssl: Prisma detects the platform's SSL to pick a query-engine binary, and
# without it the generated client resolves to the wrong one at runtime.
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies first, on their own layer: they change far less often than the
# source, so an edit to a controller does not reinstall the world.
COPY package.json package-lock.json ./
# The retry flags are not superstition: this install pulls 540 packages and a
# single idle socket to the registry fails the whole build with EIDLETIMEOUT,
# which is a flaky red PR rather than a real defect. npm's defaults give up
# early on exactly that.
RUN npm ci --fetch-retries=5 --fetch-retry-maxtimeout=120000 --fetch-timeout=600000

# `prisma generate` reads this. The schema is COMMITTED and authored by the SQL
# migrations, never by Prisma Migrate — the build needs no database.
COPY prisma ./prisma
COPY tsconfig.json ./
COPY src ./src

RUN npm run build

# ---- runtime ----------------------------------------------------------------
FROM node:20-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
# --omit=dev leaves out typescript, jest, ts-node and supertest. `npm ci` runs
# no postinstall for prisma here, which is why the generated client is copied
# from the build stage below rather than regenerated.
RUN npm ci --omit=dev --fetch-retries=5 --fetch-retry-maxtimeout=120000 --fetch-timeout=600000 \
    && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/node_modules/@prisma/client ./node_modules/@prisma/client

# The image already provides an unprivileged `node` user. Running as root in a
# container buys nothing here: this process listens on 3000, writes no files,
# and installs nothing at runtime.
USER node

EXPOSE 3000

# Readiness, not liveness — see app.ts. An orchestrator restarting on a
# database outage would put every instance into a restart loop over something
# a restart cannot fix, so the probe that decides RESTART must stay /health and
# the one that decides TRAFFIC is this one.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Directly, with no npm in between: npm would sit as PID 1 and swallow the
# SIGTERM that server.ts closes the pool on.
CMD ["node", "dist/server.js"]
