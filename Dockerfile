FROM node:20-slim

WORKDIR /app

# Install dependencies first so this layer caches unless package files change
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# Copy application code
COPY danbooru.js invites.js index.js ./
COPY config.yaml bmb-registration.yaml ./

# The bridge listens on 8009 for Synapse's appservice traffic
EXPOSE 8009

CMD ["node", "index.js", "-p", "8009", "-f", "bmb-registration.yaml"]
