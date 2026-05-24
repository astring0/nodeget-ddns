// Minimal IPv4 / IPv6 validation. Strict enough to reject obvious junk and SSRF tricks.
// We don't try to be RFC-perfect — Cloudflare rejects anything malformed downstream.

const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

export function isIPv4(s) {
  return typeof s === "string" && IPV4_RE.test(s);
}

// Accepts standard, ::-compressed, and IPv4-mapped IPv6.
export function isIPv6(s) {
  if (typeof s !== "string" || s.length > 45 || !s.includes(":")) return false;
  // strip zone id (fe80::1%eth0)
  const noZone = s.split("%")[0];
  // split by :: at most once
  const parts = noZone.split("::");
  if (parts.length > 2) return false;
  const head = parts[0] === "" ? [] : parts[0].split(":");
  const tail = parts.length === 2 ? (parts[1] === "" ? [] : parts[1].split(":")) : [];
  const groups = parts.length === 2 ? head.concat(tail) : head;
  if (parts.length === 1 && groups.length !== 8) return false;
  if (parts.length === 2 && groups.length >= 8) return false;
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    // last group can be embedded IPv4 (::ffff:1.2.3.4)
    if (i === groups.length - 1 && g.includes(".")) {
      if (!isIPv4(g)) return false;
      continue;
    }
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return false;
  }
  return true;
}

export function classify(s) {
  if (isIPv4(s)) return "A";
  if (isIPv6(s)) return "AAAA";
  return null;
}

// Reject obviously useless IPs (loopback, link-local, unspecified) so a misconfigured
// reverse proxy can't poison the DNS record with 127.0.0.1 / ::1.
export function isRoutable(s) {
  if (isIPv4(s)) {
    if (s === "0.0.0.0") return false;
    if (s.startsWith("127.")) return false;
    if (s.startsWith("169.254.")) return false;
    return true;
  }
  if (isIPv6(s)) {
    const lo = s.toLowerCase();
    if (lo === "::" || lo === "::1") return false;
    if (lo.startsWith("fe80:") || lo.startsWith("fe80::")) return false;
    return true;
  }
  return false;
}
