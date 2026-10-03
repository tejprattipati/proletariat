# Local/container alternative. Render's manifest uses its native Node runtime.
FROM node:24-bookworm-slim

WORKDIR /app

# npm start uses tsx, currently a devDependency. Do not prune it from this image.
COPY package.json package-lock.json ./
RUN npm ci --include=dev && npm cache clean --force

# Copy only runtime source/config; never copy the workspace or local data wholesale.
COPY tsconfig.json ./
COPY src ./src
COPY server ./server

RUN mkdir -p /var/data && chown node:node /var/data
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3001 \
    DATA_DIR=/var/data

USER node
VOLUME ["/var/data"]
EXPOSE 3001

# Direct Node entry preserves SIGTERM for the server and embedded worker.
CMD ["node", "--import", "tsx", "server/index.ts"]
