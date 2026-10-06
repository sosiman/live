#!/usr/bin/env python3
"""
Onda Live — deja la cache de Cloudflare como debe estar para una app que cambia.

Problema que resuelve: Cloudflare aplica un Browser Cache TTL de 4 horas a los
.js/.css y SOBRESCRIBE el no-cache del origen. Eso dejaba a los moviles con el
HTML nuevo y el JS viejo (versiones mezcladas).

Hace dos cosas:
  1. Crea/actualiza una Cache Rule que DESACTIVA la cache para live.loktar.cc.
  2. Purga lo que ya estuviera cacheado de ese host.

Uso:  python3 deploy/cloudflare-cache.py            (aplica)
      python3 deploy/cloudflare-cache.py estado     (solo mira)
"""
import json
import os
import sys
import urllib.error
import urllib.request

ENV = "/root/.cloudflare.env"
API = "https://api.cloudflare.com/client/v4"
HOST = "live.loktar.cc"
ZONA_NOMBRE = "loktar.cc"
DESCRIPCION = "Onda Live: sin cache (la app se actualiza en cada deploy)"


def credenciales():
    tok = os.environ.get("CLOUDFLARE_API_TOKEN", "")
    if not tok and os.path.exists(ENV):
        for linea in open(ENV, encoding="utf-8"):
            linea = linea.strip()
            if linea.startswith("CLOUDFLARE_API_TOKEN="):
                tok = linea.split("=", 1)[1]
    if not tok:
        sys.exit("Falta CLOUDFLARE_API_TOKEN (mira " + ENV + ")")
    return tok


def llamar(metodo, ruta, cuerpo=None, tok=""):
    datos = json.dumps(cuerpo).encode() if cuerpo is not None else None
    req = urllib.request.Request(API + ruta, data=datos, method=metodo)
    req.add_header("Authorization", "Bearer " + tok)
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        texto = e.read().decode()
        if e.code == 404:
            return {"result": None, "errors": [{"code": 404}]}
        sys.exit("Error " + str(e.code) + " en " + ruta + ": " + texto[:300])


def main():
    modo = sys.argv[1] if len(sys.argv) > 1 else "aplicar"
    tok = credenciales()

    zonas = llamar("GET", "/zones?name=" + ZONA_NOMBRE, tok=tok)
    if not zonas.get("result"):
        sys.exit("No encuentro la zona " + ZONA_NOMBRE)
    zona = zonas["result"][0]["id"]

    regla = {
        "expression": '(http.host eq "' + HOST + '")',
        "description": DESCRIPCION,
        "action": "set_cache_settings",
        "action_parameters": {"cache": False},
        "enabled": True,
    }

    ruta = "/zones/" + zona + "/rulesets/phases/http_request_cache_settings/entrypoint"
    actual = llamar("GET", ruta, tok=tok)
    reglas = []
    if actual.get("result"):
        reglas = [r for r in actual["result"].get("rules", []) if r.get("description") != DESCRIPCION]
    reglas.append(regla)

    if modo == "estado":
        print("reglas de cache en la zona: " + str(len(reglas)))
        print(json.dumps(reglas, indent=2, ensure_ascii=False)[:600])
        return

    puesta = llamar("PUT", ruta, {"rules": reglas}, tok=tok)
    if not puesta.get("success"):
        sys.exit("No se pudo poner la regla: " + json.dumps(puesta.get("errors"), ensure_ascii=False)[:300])
    print("regla puesta: cache desactivada para " + HOST)

    purga = llamar("POST", "/zones/" + zona + "/purge_cache", {"hosts": [HOST]}, tok=tok)
    print("purga: " + ("OK" if purga.get("success") else json.dumps(purga.get("errors"))[:200]))


main()
