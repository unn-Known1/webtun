'use strict';

function canonicalizeIp(host) {
  let h = String(host == null ? '' : host).trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return '';
  if (h.startsWith('::ffff:')) h = h.slice('::ffff:'.length).replace(/^\[|\]$/g, '');
  // Parse single 32-bit integer (e.g. 2886729726 -> 169.254.169.254)
  if (/^(0x[0-9a-f]+|\d+)$/i.test(h)) {
    try {
      const num = Number(h);
      if (Number.isInteger(num) && num >= 0 && num <= 0xffffffff) {
        return [(num >>> 24) & 0xff, (num >>> 16) & 0xff, (num >>> 8) & 0xff, num & 0xff].join('.');
      }
    } catch {}
  }
  // Parse dotted hex/octal/decimal representations
  if (/^(0[0-7]+|0x[0-9a-f]+|\d+)(\.(0[0-7]+|0x[0-9a-f]+|\d+)){3}$/i.test(h)) {
    try {
      const parts = h.split('.').map(p => {
        if (p.startsWith('0x') || p.startsWith('0X')) return parseInt(p, 16);
        if (p.length > 1 && p.startsWith('0')) return parseInt(p, 8);
        return parseInt(p, 10);
      });
      if (parts.every(n => Number.isInteger(n) && n >= 0 && n <= 255)) {
        return parts.join('.');
      }
    } catch {}
  }
  return h;
}

// Link-local / cloud-metadata addresses that must never be a tunnel target,
// whether they arrive as a literal or as the resolution of a hostname.
function isBlockedTunnelIp(host, { allowLoopback = false } = {}) {
  let h = canonicalizeIp(host);
  if (!h) return false;
  if (h === '100.100.100.200' || h === '192.0.0.192' || h === 'fd00:ec2::254') return true;
  if (h.startsWith('169.254.')) return true;          // IPv4 link-local (metadata)
  if (h === '169.254') return true;
  if (!allowLoopback && (h.startsWith('127.') || h === '::1')) return true;
  if (h.startsWith('fe80:') || /^fe[89ab][0-9a-f]:/.test(h)) return true; // IPv6 fe80::/10
  return false;
}


module.exports = { canonicalizeIp, isBlockedTunnelIp };
