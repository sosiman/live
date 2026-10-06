#!/usr/bin/env node
/**
 * Forever — genera los iconos de la PWA a partir de public/icons/logo.svg.
 *
 *   node scripts/render-icons.mjs
 *
 * Usa Chrome en modo headless (igual que la suite de verificación): el SVG se
 * dibuja a cada tamaño y se captura. Sin dependencias externas.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const raiz = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ICONOS = path.join(raiz, 'public', 'icons');
const PORT = 9825;
const PERFIL = path.join(os.tmpdir(), 'forever-icons');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// tamaño final, porcentaje que ocupa el logo y si lleva fondo (maskable)
const TRABAJOS = [
  { fichero: 'favicon-32.png', tam: 32, ratio: 0.94, fondo: false },
  { fichero: 'apple-touch-icon.png', tam: 180, ratio: 0.86, fondo: true },
  { fichero: 'icon-192.png', tam: 192, ratio: 0.86, fondo: true },
  { fichero: 'icon-512.png', tam: 512, ratio: 0.86, fondo: true },
  { fichero: 'maskable-512.png', tam: 512, ratio: 0.66, fondo: true },
];

fs.rmSync(PERFIL, { recursive: true, force: true });
const chrome = spawn('google-chrome', ['--headless=new', '--remote-debugging-port=' + PORT,
  '--user-data-dir=' + PERFIL, '--no-first-run', '--disable-gpu', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });

let page = null;
for (let i = 0; i < 80 && !page; i++) {
  try { const l = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json(); page = l.find((x) => x.type === 'page'); } catch { /* arrancando */ }
  if (!page) await sleep(250);
}
if (!page) { console.error('No pude abrir Chrome'); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });
let id = 0; const pend = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
await send('Page.enable');

const svg = fs.readFileSync(path.join(ICONOS, 'logo.svg'), 'utf8');
for (const t of TRABAJOS) {
  const lado = Math.round(t.tam * t.ratio);
  const html = '<!doctype html><meta charset="utf-8"><style>'
    + 'html,body{margin:0;width:' + t.tam + 'px;height:' + t.tam + 'px;overflow:hidden;'
    + (t.fondo ? 'background:#FFF9EE;' : 'background:transparent;') + '}'
    + 'div{width:' + t.tam + 'px;height:' + t.tam + 'px;display:grid;place-items:center}'
    + 'img{width:' + lado + 'px;height:' + lado + 'px;display:block}'
    + '</style><div><img src="data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64') + '"></div>';
  await send('Emulation.setDeviceMetricsOverride', { width: t.tam, height: t.tam, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: 'data:text/html;base64,' + Buffer.from(html).toString('base64') });
  await sleep(700);
  const s = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false,
    clip: { x: 0, y: 0, width: t.tam, height: t.tam, scale: 1 } });
  fs.writeFileSync(path.join(ICONOS, t.fichero), Buffer.from(s.result.data, 'base64'));
  console.log('  ' + t.fichero.padEnd(24) + t.tam + 'x' + t.tam + '  logo al ' + Math.round(t.ratio * 100) + '%');
}
try { chrome.kill('SIGKILL'); } catch { /* ya cerró */ }
console.log('Iconos generados desde icons/logo.svg');
