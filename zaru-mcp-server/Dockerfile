# Node 24, the long-term-support line. The version is declared once, in
# .nvmrc; test/node-version.test.ts fails if this line disagrees with it,
# and CI's Image job fails if the built image runs another Node. The digest
# is the multi-platform index of node:24-alpine as read from Docker Hub on
# 2026-09-28: Node 24.21.0.
FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1

WORKDIR /app

# Install dependencies first for caching layers.
# --ignore-scripts prevents the "prepare" lifecycle script from running
# npm run build before the source files have been copied.
COPY package*.json ./
RUN npm install --ignore-scripts

COPY tsconfig.json .
COPY src ./src

# Build Typescript code
RUN npm run build

EXPOSE 3000

# Start server from dist
CMD ["node", "dist/index.js"]
