# Basis-Images per Digest festgelegt; Dependabot schlägt neue Digests als PR vor (.github/dependabot.yml).
FROM node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev
# Das Laufzeit-Image hat keine Shell für mkdir und chmod: /data entsteht hier und wird samt Rechten kopiert
RUN mkdir -p /out/data/audit && chmod 700 /out/data /out/data/audit

# Laufzeit ohne Shell, Paketmanager und wget: nur Node und die Bibliotheken, die es braucht.
# Nutzer nonroot (65532) statt node (1000): Auf dem Server gehört die 1000 oft einem echten Konto.
FROM gcr.io/distroless/nodejs24-debian13:nonroot@sha256:675c532423b908f9e56f9d60a4e62309b63cd2a3175acb90a46b96f7ee68e121
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    WECLAPP_AUDIT_DIR=/data/audit
# Das Basis-Image läuft schon als nonroot; ohne USER 0 gehörte /app aus WORKDIR dem Laufzeitnutzer
USER 0:0
WORKDIR /app
# Der Code gehört root und ist für den Laufzeitnutzer nur lesbar;
# beschreibbar ist allein /data (Änderungsprotokoll, als Volume einhängen).
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# Aus /out/ statt /out/data, damit auch /data selbst die Rechte 0700 behält
COPY --from=build --chown=65532:65532 /out/ /
USER 65532:65532
VOLUME /data
EXPOSE 3000
# Ohne wget: Node fragt /health selbst ab
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:3000/health',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
# Der Einstiegspunkt des Images ist /nodejs/bin/node
CMD ["dist/http.js"]
