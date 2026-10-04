'use strict';

// Self-signed TLS certificate so the LAN page can be served over HTTPS.
// A secure context is what lets phones use DeviceMotion (shake to roll).
//
// The certificate is generated once and cached next to the game archive
// (data/cert.json). It is regenerated automatically when the set of LAN
// addresses changes (a new Wi-Fi / router IP would otherwise break the
// Subject Alternative Names) or when it gets close to expiring.

const fs = require('fs');
const path = require('path');
const selfsigned = require('selfsigned');

const FILE = process.env.KNIFFEL_CERT
  || path.join(__dirname, '..', 'data', 'cert.json');
const MAX_AGE_MS = 300 * 24 * 3600 * 1000; // regenerate ~2 months before a 1y cert expires

function sameSet(a, b) {
  const s = new Set(a);
  if (s.size !== b.length) return false;
  return b.every((x) => s.has(x));
}

function readCache() {
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (j && j.key && j.cert && Array.isArray(j.ips)) return j;
  } catch (e) { /* first run or unreadable -> regenerate */ }
  return null;
}

function writeCache(obj) {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, FILE);
  } catch (e) {
    console.error('cert cache save failed:', e.message);
  }
}

async function getCert(ips) {
  const wanted = ['localhost', '127.0.0.1'].concat(ips || []);
  const cached = readCache();
  if (cached && sameSet(cached.ips, wanted) && Date.now() - cached.created < MAX_AGE_MS) {
    return { key: cached.key, cert: cached.cert };
  }

  const altNames = [{ type: 2, value: 'localhost' }];
  for (const ip of wanted) {
    if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) altNames.push({ type: 7, ip });
    else altNames.push({ type: 2, value: ip });
  }

  const pems = await selfsigned.generate(
    [{ name: 'commonName', value: 'kniffel.local' }],
    {
      keyType: 'rsa',
      keySize: 2048,
      algorithm: 'sha256',
      notAfterDate: new Date(Date.now() + 365 * 24 * 3600 * 1000),
      extensions: [
        { name: 'basicConstraints', cA: false },
        { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
        { name: 'extKeyUsage', serverAuth: true },
        { name: 'subjectAltName', altNames },
      ],
    }
  );

  writeCache({ created: Date.now(), ips: wanted, key: pems.private, cert: pems.cert });
  return { key: pems.private, cert: pems.cert };
}

module.exports = { getCert, FILE };
