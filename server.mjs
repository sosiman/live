#!/usr/bin/env node
/**
 * Onda Live — servidor local de la PWA (sin dependencias).
 * Solo reparte archivos: no toca la API, no ve la clave y no pasa audio.
 *
 *   node server.mjs            # HTTPS 8443 + aviso por HTTP en 8080
 *   node server.mjs --http     # solo HTTP
 */
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const CERT_DIR = path.join(__dirname, 'certs');
const VERSION = '3.3.2';

const args = process.argv.slice(2);
const flag = (name, def = null) => {
  const i = args.indexOf('--' + name);
  if (i === -1) return def;
  const next = args[i + 1];
  return next && !next.startsWith('--') ? next : true;
};
const HTTP_ONLY = Boolean(flag('http', false));
const PORT = Number(flag('port', HTTP_ONLY ? 8080 : 8443));
const PLAIN_PORT = Number(flag('plain-port', 8080));

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png', '.ico': 'image/x-icon', '.svg': 'image/svg+xml',
};

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list ?? []) if (net.family === 'IPv4' && !net.internal) out.push(net.address);
  }
  return out;
}
const send = (res, status, body, headers = {}) => { res.writeHead(status, { 'Cache-Control': 'no-store', ...headers }); res.end(body); };

function handler(req, res) {
  const url = req.url ?? '/';
  if (url.startsWith('/__health')) {
    return send(res, 200, JSON.stringify({ ok: true, app: 'onda-live', version: VERSION, uptime: process.uptime() }), { 'Content-Type': MIME['.json'] });
  }
  if (url.startsWith('/certificado')) {
    try {
      return send(res, 200, fs.readFileSync(path.join(CERT_DIR, 'cert.pem')), {
        'Content-Type': 'application/x-x509-ca-cert',
        'Content-Disposition': 'attachment; filename="onda-live.crt"',
      });
    } catch { return send(res, 404, 'Certificado no disponible'); }
  }
  let rel = decodeURIComponent(url.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';
  const target = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!target.startsWith(PUBLIC_DIR)) return send(res, 403, 'Prohibido');
  fs.stat(target, (err, stat) => {
    if (err || !stat.isFile()) {
      if (!path.extname(rel)) return send(res, 200, fs.readFileSync(path.join(PUBLIC_DIR, 'index.html')), { 'Content-Type': MIME['.html'] });
      return send(res, 404, 'No encontrado: ' + rel);
    }
    const ext = path.extname(target).toLowerCase();
    const sinCache = ['.html', '.js', '.css', '.webmanifest'].includes(ext);
    res.writeHead(200, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Cache-Control': sinCache ? 'no-cache' : 'public, max-age=86400',
      'Service-Worker-Allowed': '/',
    });
    fs.createReadStream(target).pipe(res);
  });
}

function ensureCertificate() {
  fs.mkdirSync(CERT_DIR, { recursive: true });
  const keyPath = path.join(CERT_DIR, 'key.pem');
  const certPath = path.join(CERT_DIR, 'cert.pem');
  const ips = ['127.0.0.1', ...lanAddresses()];
  const san = ['DNS:localhost', 'DNS:' + os.hostname(), ...ips.map((ip) => 'IP:' + ip)].join(',');
  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    try {
      const txt = execFileSync('openssl', ['x509', '-in', certPath, '-noout', '-ext', 'subjectAltName'], { encoding: 'utf8' });
      if (ips.every((ip) => txt.includes(ip))) return { keyPath, certPath };
      console.log('· Certificado sin las IPs actuales: se regenera.');
    } catch { console.log('· Certificado ilegible: se regenera.'); }
  }
  console.log('· Generando certificado autofirmado…');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath, '-days', '825',
    '-subj', '/CN=Onda Live (local)', '-addext', 'subjectAltName=' + san,
    '-addext', 'basicConstraints=critical,CA:TRUE',
    '-addext', 'keyUsage=critical,digitalSignature,keyEncipherment,keyCertSign',
    '-addext', 'extendedKeyUsage=serverAuth'], { stdio: ['ignore', 'ignore', 'pipe'] });
  return { keyPath, certPath };
}

const ips = lanAddresses();
if (HTTP_ONLY) {
  http.createServer(handler).listen(PORT, '0.0.0.0', () => banner(null));
} else {
  const { keyPath, certPath } = ensureCertificate();
  https.createServer({ key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) }, handler).listen(PORT, '0.0.0.0', () => {
    http.createServer((req, res) => {
      const host = (req.headers.host ?? '').replace(/:\d+$/, '');
      res.writeHead(302, { Location: 'https://' + host + ':' + PORT + (req.url ?? '/') });
      res.end('Usa HTTPS');
    }).listen(PLAIN_PORT, '0.0.0.0', () => banner(PORT));
  });
}
function banner(httpsPort) {
  const lines = ['', '  ONDA LIVE · ' + VERSION, '  ' + '-'.repeat(58)];
  if (httpsPort) {
    lines.push('  En este PC      https://localhost:' + httpsPort);
    for (const ip of ips) lines.push('  Desde el móvil  https://' + ip + ':' + httpsPort);
    lines.push('', '  Certificado autofirmado: el navegador avisará la primera vez.');
    lines.push('  Sin HTTPS el móvil no da micrófono.');
  } else {
    for (const ip of ['localhost', ...ips]) lines.push('  http://' + ip + ':' + PORT);
  }
  lines.push('  ' + '-'.repeat(58), '');
  console.log(lines.join('\n'));
}
