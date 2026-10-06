#!/usr/bin/env bash
# Onda Live — despliegue en el servidor.
#
#   ./deploy/instalar.sh            construye y levanta
#   ./deploy/instalar.sh estado     estado del contenedor y del túnel
#   ./deploy/instalar.sh logs
#   ./deploy/instalar.sh parar
#   ./deploy/instalar.sh actualizar reconstruye, levanta y purga la caché
#
# Contenedor sin privilegios (usuario «node») y con el sistema de archivos de
# solo lectura. El puerto 8087 es el que espera el túnel de Cloudflare.
set -euo pipefail
cd "$(dirname "$0")/.."
PUERTO=8087
COMPOSE="docker compose -f deploy/compose.yaml"

MODO="$1"
if [ -z "$MODO" ]; then MODO="desplegar"; fi

# Cloudflare cachea los .js/.css 4 h por su cuenta (Browser Cache TTL) y
# sobrescribe el no-cache del origen. Eso deja a los móviles con el HTML nuevo y
# el JS viejo. deploy/cloudflare-cache.py desactiva la caché para este host,
# respeta las cabeceras del origen y purga lo cacheado.
purgar_cache() {
  if [ -f deploy/cloudflare-cache.py ]; then
    echo "· Caché de Cloudflare…"
    python3 deploy/cloudflare-cache.py || echo "  (aviso: no se pudo ajustar la caché; el sellado de versión sigue protegiendo)"
  fi
}

salud() {
  for i in 1 2 3 4 5 6 7 8 9 10; do
    if curl -fsS "http://127.0.0.1:$PUERTO/__health"; then echo; return 0; fi
    sleep 1
  done
  echo "(sin respuesta todavía)"
  return 1
}

case "$MODO" in
  desplegar)
    echo "· Construyendo la imagen…"
    $COMPOSE build
    echo "· Levantando el contenedor…"
    $COMPOSE up -d
    sleep 3
    echo "· Salud en local:"
    salud || true
    echo "· Usuario dentro del contenedor (debe ser «node», no root):"
    docker exec wow-agent id
    purgar_cache
    ;;
  estado)
    $COMPOSE ps
    echo
    salud || true
    echo
    echo "· Túnel de Cloudflare:"
    pgrep -a cloudflared | head -3 || echo "  (no encuentro el proceso cloudflared)"
    echo
    echo "· Caché de la app en Cloudflare (debe ser DYNAMIC, sin caché):"
    curl -s -o /dev/null -D - "https://wow.loktar.cc/index.html" | grep -i 'cf-cache-status\|cache-control' | tr -d '\r' || true
    ;;
  logs) $COMPOSE logs --tail=80 -f ;;
  parar) $COMPOSE down ;;
  actualizar)
    $COMPOSE up -d --build
    sleep 3
    salud || true
    purgar_cache
    ;;
  *) echo "Uso: $0 {desplegar|estado|logs|parar|actualizar}" >&2; exit 2 ;;
esac
