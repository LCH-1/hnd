FROM node:24-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df

ENV NODE_ENV=production \
    HND_SERVER_DATA=/data \
    HND_SERVER_HOST=0.0.0.0 \
    HND_SERVER_PORT=8787 \
    HND_SERVER_WEB=/app/src/web \
    HND_SERVER_CONNECTOR_DIR=/app/dist/connector-release

WORKDIR /app

COPY --chown=node:node package.json package-lock.json LICENSE README.md ./
COPY --chown=node:node bin/hnd-server.mjs ./bin/hnd-server.mjs
COPY --chown=node:node src ./src
COPY --chown=node:node dist/connector-release ./dist/connector-release

RUN npm ci --omit=dev \
    && mkdir /data \
    && chown node:node /data

USER node
EXPOSE 8787
VOLUME ["/data"]
STOPSIGNAL SIGTERM

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8787/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

ENTRYPOINT ["node", "bin/hnd-server.mjs"]
