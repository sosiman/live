# Onda Live — imagen mínima para el servidor.
#
# La app es 100 % estática: este contenedor solo reparte archivos. No ve tu
# clave de Google y no pasa audio: el WebSocket va del navegador directo a
# Google. El TLS lo pone Cloudflare (live.loktar.cc).
FROM node:22-alpine

LABEL org.opencontainers.image.title="Onda Live" \
      org.opencontainers.image.description="Conversacion y traduccion en vivo con Gemini Live API (BYOK)" \
      org.opencontainers.image.version="3.2.0"

WORKDIR /app

# --chown: los archivos deben ser legibles por el usuario sin privilegios.
COPY --chown=node:node package.json ./
COPY --chown=node:node server.mjs ./
COPY --chown=node:node public/ ./public/
RUN chmod -R a+rX /app

USER node
ENV PORT=8087 NODE_ENV=production
EXPOSE 8087

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8087/__health || exit 1

CMD ["node", "server.mjs", "--http", "--port", "8087"]
