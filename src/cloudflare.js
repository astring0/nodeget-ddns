// Cloudflare DNS record API client. Docs:
//   https://developers.cloudflare.com/api/operations/dns-records-for-a-zone-dns-record-details
//   https://developers.cloudflare.com/api/operations/dns-records-for-a-zone-patch-dns-record

const CF_BASE = "https://api.cloudflare.com/client/v4";

class CloudflareError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = "CloudflareError";
    this.status = status;
    this.body = body;
  }
}

async function cfRequest(token, path, init = {}) {
  const res = await fetch(`${CF_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    // tolerate non-JSON error bodies
  }
  if (!res.ok || (json && json.success === false)) {
    const errs = json?.errors?.map((e) => `${e.code}:${e.message}`).join(";") || res.statusText;
    throw new CloudflareError(`Cloudflare API ${res.status}: ${errs}`, res.status, json);
  }
  return json;
}

export async function lookupRecord(token, zoneId, name, type) {
  const q = new URLSearchParams({ name, type, "per_page": "1" });
  const r = await cfRequest(token, `/zones/${zoneId}/dns_records?${q.toString()}`);
  const rec = r?.result?.[0];
  if (!rec) return null;
  return { id: rec.id, content: rec.content, ttl: rec.ttl, proxied: !!rec.proxied, type: rec.type, name: rec.name };
}

export async function getRecord(token, zoneId, recordId) {
  const r = await cfRequest(token, `/zones/${zoneId}/dns_records/${recordId}`);
  const rec = r?.result;
  if (!rec) return null;
  return { id: rec.id, content: rec.content, ttl: rec.ttl, proxied: !!rec.proxied, type: rec.type, name: rec.name };
}

export async function patchRecord(token, zoneId, recordId, { content, ttl, proxied, type, name }) {
  const body = {};
  if (content !== undefined) body.content = content;
  if (ttl !== undefined) body.ttl = ttl;
  if (proxied !== undefined) body.proxied = proxied;
  if (type !== undefined) body.type = type;
  if (name !== undefined) body.name = name;
  const r = await cfRequest(token, `/zones/${zoneId}/dns_records/${recordId}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
  return r?.result;
}

export { CloudflareError };
