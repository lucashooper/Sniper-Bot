# Engine image (the dashboard deploys to Netlify separately). Build from the repo root:
#   docker build -t sniper-engine .
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY engine/package.json engine/
COPY dashboard/package.json dashboard/
RUN npm ci --workspace engine --include-workspace-root=false --no-audit --no-fund
COPY engine/tsconfig.json engine/
COPY engine/src engine/src
RUN npm run build --workspace engine

FROM node:22-slim
ENV NODE_ENV=production \
    ENGINE_HOST=0.0.0.0 \
    ENGINE_DATA_DIR=/data
WORKDIR /app
COPY package.json package-lock.json ./
COPY engine/package.json engine/
COPY dashboard/package.json dashboard/
RUN npm ci --workspace engine --include-workspace-root=false --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/engine/dist engine/dist
# Encrypted keystore, wallets, settings and ledger. Mount a persistent volume here; Supabase holds a backup.
VOLUME /data
EXPOSE 8787
# Runs as root because platform volumes (Railway, Fly) mount root-owned; the container itself is the boundary.
CMD ["node", "engine/dist/index.js"]
