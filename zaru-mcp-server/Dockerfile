FROM node:18-alpine

WORKDIR /app

# Install dependencies first for caching layers
COPY package*.json ./
RUN npm install

COPY tsconfig.json .
COPY src ./src

# Build Typescript code
RUN npm run build

EXPOSE 3000

# Start server from dist
CMD ["node", "dist/index.js"]
