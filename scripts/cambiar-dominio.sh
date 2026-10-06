#!/usr/bin/env bash
# Forever — cambia el dominio de produccion en TODO el proyecto y lo comprueba.
#
#   ./scripts/cambiar-dominio.sh wow.loktar.cc wow.loktar.cc
#
# Toca: README, AGENTS, la memoria del proyecto, deploy/instalar.sh,
# deploy/cloudflare-cache.py (host de la Cache Rule) y el Dockerfile/compose.
set -euo pipefail
cd "$(dirname "$0")/.."

VIEJO="${1:-}"
NUEVO="${2:-}"
if [ -z "$VIEJO" ] || [ -z "$NUEVO" ]; then
  echo "Uso: $0 <dominio-viejo> <dominio-nuevo>" >&2
  exit 2
fi

echo "Cambiando $VIEJO -> $NUEVO"
tocados=0
while IFS= read -r f; do
  sed -i "s/${VIEJO//./\\.}/${NUEVO//./\\.}/g" "$f"
  echo "  $f"
  tocados=$((tocados + 1))
done < <(grep -rl -- "$VIEJO" . --include='*.md' --include='*.py' --include='*.sh' --include='*.mjs' --include='*.yaml' --include='*.yml' --include='*.json' --include='Dockerfile' 2>/dev/null | grep -v '^./.git/' || true)

echo
echo "Ficheros tocados: $tocados"
resto=$(grep -rl -- "$VIEJO" . --include='*.md' --include='*.py' --include='*.sh' --include='*.mjs' --include='*.yaml' --include='*.yml' --include='*.json' --include='Dockerfile' 2>/dev/null | grep -v '^./.git/' | wc -l)
if [ "$resto" -gt 0 ]; then
  echo "AVISO: quedan $resto ficheros con el dominio viejo" >&2
  exit 1
fi
echo "Comprobado: ya no queda ninguna referencia al dominio viejo."
echo "Siguiente paso: node scripts/sellar-version.mjs y desplegar."
