FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-alpine
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    WECLAPP_AUDIT_DIR=/data/audit
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# Der Code gehört root und ist für den Laufzeitnutzer nur lesbar;
# beschreibbar ist allein /data (Änderungsprotokoll, als Volume einhängen).
RUN mkdir -p /data/audit && chown -R node:node /data && chmod 700 /data /data/audit
USER node
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health >/dev/null || exit 1
CMD ["node", "dist/http.js"]
