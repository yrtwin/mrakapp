# MRAK8 · one image: API + bot + the built mini app (SERVE_WEB=1)
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY shared shared
COPY server server
COPY web web
ARG VITE_API_URL=
ARG VITE_MINIAPP_LINK=
ENV VITE_API_URL=$VITE_API_URL VITE_MINIAPP_LINK=$VITE_MINIAPP_LINK
RUN npm run build -w web && npm run build -w server

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
# ffmpeg decodes DJ set tracks for the beat/key analysis (server/tools/dj-analyze.mjs)
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
RUN npm ci --omit=dev -w server && npm cache clean --force
COPY --from=build /app/server/dist server/dist
COPY server/drizzle server/drizzle
COPY server/tools server/tools
COPY --from=build /app/web/dist web/dist
# brand photos for the first-run seed of product #001
COPY mrakl-zip-front.jpg mrakl-zip-back.jpg ./
WORKDIR /app/server
EXPOSE 8080
CMD ["node", "dist/index.js"]
