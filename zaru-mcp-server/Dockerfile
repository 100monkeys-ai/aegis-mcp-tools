FROM node:18-alpine

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
