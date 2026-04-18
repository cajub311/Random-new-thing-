// SSRF-hardened fetch wrapper for tools that read arbitrary user-supplied URLs.
//
// What we defend against:
//   - file:, ftp:, gopher:, data:, javascript: schemes
//   - localhost / 127.0.0.0/8 / 0.0.0.0 / ::1
//   - RFC1918 private ranges (10.0/8, 172.16/12, 192.168/16)
//   - link-local (169.254/16, fe80::/10)
//   - metadata services (cloud 169.254.169.254 covered by link-local)
//
// We resolve the hostname ourselves, verify every resolved address, then pass
// the original URL to fetch(). This is best-effort — on hosts with split DNS
// or rebinding attacks the guarantee is not perfect, but it's dramatically
// better than a naked fetch().

import { lookup } from 'dns/promises';
import net from 'net';

const ALLOWED_SCHEMES = new Set(['http:', 'https:']);

function isPrivateV4(ip) {
  const [a, b] = ip.split('.').map(Number);
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;  // CGNAT
  if (a >= 224) return true;                           // multicast + reserved
  return false;
}

function isPrivateV6(ip) {
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true;
  if (lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd')) return true;
  // IPv4-mapped ::ffff:192.168.1.1 — check the mapped v4 half.
  const m = lower.match(/::ffff:(\d+\.\d+\.\d+\.\d+)/);
  if (m) return isPrivateV4(m[1]);
  return false;
}

export function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) return isPrivateV4(ip);
  if (net.isIPv6(ip)) return isPrivateV6(ip);
  return true;   // if we can't tell, treat as private
}

export async function assertSafeUrl(urlString, { allowLocal = false } = {}) {
  let u;
  try { u = new URL(urlString); }
  catch { throw new Error(`invalid URL: ${urlString}`); }

  if (!ALLOWED_SCHEMES.has(u.protocol)) {
    throw new Error(`scheme ${u.protocol} not allowed (http/https only)`);
  }
  if (allowLocal) return u;

  const host = u.hostname;
  if (!host) throw new Error('URL has no host');

  // If the host is a raw IP, check it directly.
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw new Error(`host ${host} is a private/loopback address`);
    return u;
  }

  // Reject obvious local names without even resolving them.
  const lower = host.toLowerCase();
  if (lower === 'localhost' || lower.endsWith('.localhost') || lower.endsWith('.local') || lower.endsWith('.internal')) {
    throw new Error(`host ${host} resolves to a local address`);
  }

  // Resolve + check every answer.
  const addrs = await lookup(host, { all: true });
  for (const a of addrs) {
    if (isPrivateAddress(a.address)) {
      throw new Error(`host ${host} resolves to private address ${a.address}`);
    }
  }
  return u;
}

export async function safeFetch(urlString, options = {}, opts = {}) {
  await assertSafeUrl(urlString, opts);
  const res = await fetch(urlString, {
    redirect: 'manual',   // we handle redirects ourselves so each hop is checked
    ...options,
  });

  // Follow up to 3 redirects manually, re-validating each target.
  let cur = res;
  for (let i = 0; i < 3; i++) {
    if (cur.status < 300 || cur.status >= 400) return cur;
    const loc = cur.headers.get('location');
    if (!loc) return cur;
    const next = new URL(loc, urlString).toString();
    await assertSafeUrl(next, opts);
    cur = await fetch(next, { redirect: 'manual', ...options });
    urlString = next;
  }
  return cur;
}
