FROM docker.io/library/node:24.22.1-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends bubblewrap ffmpeg python3 ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /srv/stream
COPY package.json package-lock.json ./
COPY shared/dust-wave-platform/packages shared/dust-wave-platform/packages
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY src src
COPY public public
COPY deploy/container-start.js deploy/media-relay.py deploy/
ENV NODE_ENV=production STREAM_STATE_DIR=/tmp/stream-runtime STREAM_MEDIA_SANDBOX=bubblewrap STREAM_STORE_TRANSPORT=durable-object
RUN ffmpeg -nostdin -v error -f lavfi -i color=white:s=16x16:r=1 -frames:v 1 -c:v libx264 -threads 1 -pix_fmt yuv420p -movflags +faststart deploy/probe.mp4
USER node
EXPOSE 8791 8792 8793 8794
CMD ["node","deploy/container-start.js"]
