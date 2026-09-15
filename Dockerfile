# SelfLatitude Companion - single image: builds the client, runs the API which also serves the client.
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci --omit=dev && npm cache clean --force \
  && apt-get purge -y python3 make g++ && apt-get autoremove -y
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/server/src/db/schema.sql server/dist/db/schema.sql
COPY --from=build /app/client/dist client/dist
RUN mkdir -p /data/db /data/uploads && chown -R node:node /data /app
USER node
ENV PORT=4000 DB_PATH=/data/db/companion.db UPLOAD_DIR=/data/uploads
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://localhost:4000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/dist/index.js"]
