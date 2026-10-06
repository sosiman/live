#!/usr/bin/env node
/**
 * Sella la versión en todos los sitios donde hace falta para que NINGUNA caché
 * (navegador, service worker o Cloudflare) pueda servir una versión vieja.
 *
 *   node scripts/sellar-version.mjs
 *
 * Qué hace:
 *   · Lee APP_VERSION de public/app.js (fuente única).
 *   · Pone ?v=VERSION en el <script> de index.html, en los import de app.js y en
 *     la lista del service worker. URL nueva = cache miss garantizado.
 *   · Sincroniza la versión en server.mjs, package.json, Dockerfile y compose.
 *   · Sube el nombre de la caché del service worker.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const leer = (p) => fs.readFileSync(path.join(raiz, p), 'utf8');
const escribir = (p, s) => fs.writeFileSync(path.join(raiz, p), s);

const app = leer('public/app.js');
const m = app.match(/const APP_VERSION = '([^']+)'/);
if (!m) { console.error('No encuentro APP_VERSION en public/app.js'); process.exit(1); }
const V = m[1];
const QUITAR = /\?v=[0-9A-Za-z.\-]+/g;

// 1) index.html: script versionado + versión esperada para la autocuración
let html = leer('public/index.html');
html = html.replace(QUITAR, '');
html = html.replace(/window\.__ONDA_VERSION = '[^']*'/, "window.__ONDA_VERSION = '" + V + "'");
html = html.replace(/<script type="module" src="app\.js"><\/script>/,
                    '<script type="module" src="app.js?v=' + V + '"></script>');
// El CSS TAMBIÉN se versiona: si no, el navegador puede mezclar HTML nuevo con
// una hoja de estilos vieja en caché y la maqueta se rompe (pasó el 2026-09-17).
html = html.replace(/href="styles\.css(\?v=[^"]*)?"/, 'href="styles.css?v=' + V + '"');
escribir('public/index.html', html);

// 2) app.js: imports versionados
let app2 = app.replace(QUITAR, '');
app2 = app2.replace(/from '\.\/(live|audio|tools)\.js'/g, "from './$1.js?v=" + V + "'");
app2 = app2.replace(/navigator\.serviceWorker\.register\('sw\.js'\)/, "navigator.serviceWorker.register('sw.js?v=" + V + "')");
escribir('public/app.js', app2);

// 3) service worker: lista del shell versionada y caché nueva
let sw = leer('public/sw.js').replace(QUITAR, '');
// Versiona TODAS las entradas de SHELL, tengan o no el prefijo './'.
sw = sw.replace(/const SHELL = \[[^\]]*\];/, (todo) => {
  const dentro = todo.slice(todo.indexOf('[') + 1, todo.lastIndexOf(']'));
  const entradas = dentro.split(',').map((e) => e.trim()).filter(Boolean).map((e) => {
    const limpio = e.replace(/^['"]|['"]$/g, '').replace(/\?v=[^'"]*$/, '');
    if (limpio === '' || limpio === '.' || limpio === './') return "'./?v=" + V + "'";
    return "'" + limpio + "?v=" + V + "'";
  });
  return 'const SHELL = [' + entradas.join(', ') + '];';
});
const numCache = (Number((leer('public/sw.js').match(/onda-v(\d+)/) || [0, 0])[1]) || 0) + 1;
sw = sw.replace(/const CACHE = 'onda-v\d+';/, "const CACHE = 'onda-v" + numCache + "';");
escribir('public/sw.js', sw);

// 4) resto de ficheros con versión
const otros = [
  ['server.mjs', /const VERSION = '[^']+';/, "const VERSION = '" + V + "';"],
  ['package.json', /"version": "[^"]+"/, '"version": "' + V + '"'],
  ['Dockerfile', /org\.opencontainers\.image\.version="[^"]+"/, 'org.opencontainers.image.version="' + V + '"'],
  ['deploy/compose.yaml', /image: wow-agent:[^\s]+/, 'image: wow-agent:' + V],
];
for (const [f, patron, nuevo] of otros) {
  const s = leer(f).replace(patron, nuevo);
  escribir(f, s);
}

// --- Comprobaciones: que el sellado no deje nada roto ---
const htmlFinal = leer('public/index.html');
if (!htmlFinal.includes("window.__ONDA_VERSION = '" + V + "'")) {
  console.error('FALLO: el HTML no lleva window.__ONDA_VERSION = ' + V);
  process.exit(1);
}
const inline = htmlFinal.slice(htmlFinal.indexOf('<script>'), htmlFinal.indexOf('</script>'));
if (/__ONDA_[0-9]/.test(inline)) {
  console.error('FALLO: el literal de versión se ha colado dentro del nombre de la variable');
  process.exit(1);
}
const appFinal = leer('public/app.js');
const importsVersionados = (appFinal.match(/from '\.\/[a-z]+\.js\?v=/g) || []).length;
if (importsVersionados < 3) {
  console.error('FALLO: solo ' + importsVersionados + ' imports versionados (esperaba 3)');
  process.exit(1);
}
if (htmlFinal.includes('src="app.js?v=' + V + '"') === false) {
  console.error('FALLO: el script de index.html no lleva la versión');
  process.exit(1);
}
if (!htmlFinal.includes('href="styles.css?v=' + V + '"')) {
  console.error('FALLO: el CSS de index.html no lleva la versión (mezcla HTML nuevo con CSS viejo)');
  process.exit(1);
}
const swFinal = leer('public/sw.js');
if (!swFinal.includes('styles.css?v=' + V)) {
  console.error('FALLO: el service worker no cachea el CSS versionado');
  process.exit(1);
}

console.log('Versión sellada: ' + V);
console.log('  · index.html  → app.js?v=' + V);
console.log('  · app.js      → imports con ?v=' + V);
console.log('  · sw.js       → caché onda-v' + numCache + ' y shell versionado');
console.log('  · server.mjs, package.json, Dockerfile, compose.yaml sincronizados');
