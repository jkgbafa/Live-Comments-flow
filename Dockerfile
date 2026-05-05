# Live Chat Aggregator — production container.
# Small, single-stage build. Node 20 alpine is ~50MB.
FROM node:20-alpine

WORKDIR /app

# Install deps first for better Docker layer caching.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy source.
COPY server.js ./
COPY lib ./lib
COPY public ./public

# Persistent data (channels.json) lives on a Fly Volume mounted at /data.
ENV DATA_DIR=/data

# Fly.io routes external traffic to whatever PORT the app binds.
ENV PORT=3000
EXPOSE 3000

# Sensible Node defaults.
ENV NODE_ENV=production

CMD ["node", "server.js"]
