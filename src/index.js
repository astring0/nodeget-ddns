// NodeGet js-worker entrypoint — Cloudflare DDNS bridge.
//
// Multi-mapping model:
//   env.MAPPINGS = [
//     { "name": "home",  "cron_name_fetch_ip": "ddns-fetch-home",
//       "record_v4": "home.example.com", "record_v6": "home.example.com" },
//     { "name": "nas",   "cron_name_fetch_ip": "ddns-fetch-nas",
//       "record_v4": "nas.example.com" }
//   ]
// One server cron iterates over all mappings each tick. Each mapping has its own
// KV namespace (last_ip:<mapping.name>:<type>) so they don't interfere.
//
// Legacy single-record env (CF_RECORD_NAME / CRON_NAME_FETCH_IP / RECORD_FAMILY) still
// works: it's auto-converted to a one-entry mappings array named "default".
//
// Cron params override (per-run):
//   {}                       — sync all mappings (normal scheduled tick)
//   { "only": "nas" }        — sync just one mapping by name
//   { "force": true }        — bypass KV unchanged short-circuit (re-PATCH CF)
//   { "only": "nas", "force": true }
//
// HTTP routes:
//   POST /nodeget/worker-route/<route>      same params shape; body.ip allowed for sh-agent push
//   GET  /nodeget/worker-route/<route>/health

import { kvGet, kvSet, ensureNamespace } from "./kv.js";
import { lookupRecord, getRecord, patchRecord, CloudflareError } from "./cloudflare.js";
import { classify, isRoutable } from "./ip.js";
import { fetchAgentIpFromCron, runAgentIpTaskBlocking } from "./nodeget.js";

const KV_LAST_IP = (mappingName, type) => `last_ip:${mappingName}:${type}`;
const KV_LAST_TS = (mappingName, type) => `last_update_ts:${mappingName}:${type}`;
const KV_RECORD_ID = (mappingName, type) => `record_id_cache:${mappingName}:${type}`;

function json(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function asBool(v, d) {
  if (v == null || v === "") return d;
  if (typeof v === "boolean") return v;
  const s = String(v).toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}
function asNum(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}
function asStr(v, d = "") {
  return v != null && v !== "" ? String(v) : d;
}

// Parse env into a normalized cfg: { cfToken, secret, defaults, mappings: [{ ... }] }
function readEnv(env) {
  env = env || {};
  const defaults = {
    zoneId: asStr(env.CF_ZONE_ID),
    ttl: asNum(env.CF_RECORD_TTL, 60),
    proxied: asBool(env.CF_RECORD_PROXIED, false),
  };

  // Mappings: prefer env.MAPPINGS (array or JSON string). Fall back to legacy single-record env.
  let mappings = [];
  let rawMappings = env.MAPPINGS;
  if (typeof rawMappings === "string" && rawMappings.trim()) {
    try { rawMappings = JSON.parse(rawMappings); } catch { rawMappings = null; }
  }
  if (Array.isArray(rawMappings)) {
    mappings = rawMappings;
  } else {
    // Legacy: build a single default mapping from flat env vars.
    const legacyRecordV4 = asStr(env.CF_RECORD_NAME_V4) || asStr(env.CF_RECORD_NAME);
    const legacyRecordV6 = asStr(env.CF_RECORD_NAME_V6) || asStr(env.CF_RECORD_NAME);
    if (legacyRecordV4 || legacyRecordV6 || env.CRON_NAME_FETCH_IP || env.AGENT_UUID) {
      mappings = [{
        name: "default",
        agent_uuid: asStr(env.AGENT_UUID),
        cron_name_fetch_ip: asStr(env.CRON_NAME_FETCH_IP),
        record_v4: legacyRecordV4,
        record_v6: legacyRecordV6,
        record_id_v4: asStr(env.CF_RECORD_ID_V4),
        record_id_v6: asStr(env.CF_RECORD_ID_V6),
        family: String(env.RECORD_FAMILY || "v4").toLowerCase(),
      }];
    }
  }
  mappings = normalizeMappings(mappings, env, defaults);

  return {
    cfToken: asStr(env.CF_API_TOKEN),
    ngToken: asStr(env.NODEGET_API_TOKEN) || asStr(env.token), // accept both
    secret: asStr(env.SHARED_SECRET),
    trustPeerHeader: asBool(env.TRUST_PEER_IP_HEADER, true),
    heartbeatHours: asNum(env.HEARTBEAT_HOURS, 24),
    defaults,
    mappings,
  };
}

// Normalize a raw mappings array into the canonical shape. Used both at env-load time
// and when cron `params.mappings` overrides env.MAPPINGS.
function normalizeMappings(rawArr, env, defaults) {
  env = env || {};
  defaults = defaults || {
    zoneId: asStr(env.CF_ZONE_ID),
    ttl: asNum(env.CF_RECORD_TTL, 60),
    proxied: asBool(env.CF_RECORD_PROXIED, false),
  };
  const defaultTimeout = asNum(env.IP_TASK_TIMEOUT_MS, 10000);
  return (Array.isArray(rawArr) ? rawArr : []).map((m, i) => {
    const family = String(m.family || env.RECORD_FAMILY || "v4").toLowerCase();
    return {
      name: asStr(m.name) || `mapping_${i}`,
      agent_uuid: asStr(m.agent_uuid),
      cron_name_fetch_ip: asStr(m.cron_name_fetch_ip),
      ip_task_timeout_ms: asNum(m.ip_task_timeout_ms, defaultTimeout),
      record_v4: asStr(m.record_v4),
      record_v6: asStr(m.record_v6),
      record_id_v4: asStr(m.record_id_v4),
      record_id_v6: asStr(m.record_id_v6),
      zone_id: asStr(m.zone_id) || defaults.zoneId,
      family: ["v4", "v6", "both"].includes(family) ? family : "v4",
      ttl: asNum(m.ttl, defaults.ttl),
      proxied: asBool(m.proxied, defaults.proxied),
    };
  });
}

// Apply params-level mapping override. Replace semantics — params.mappings (if present)
// fully replaces cfg.mappings. CF_API_TOKEN / SHARED_SECRET stay in env only.
function applyMappingsOverride(cfg, env, params) {
  if (!params || typeof params !== "object") return cfg;
  const raw = params.mappings ?? params.MAPPINGS;
  if (!Array.isArray(raw)) return cfg;
  return { ...cfg, mappings: normalizeMappings(raw, env, cfg.defaults) };
}

function checkGlobalEnv(cfg) {
  const miss = [];
  if (!cfg.cfToken) miss.push("CF_API_TOKEN");
  if (!cfg.ngToken) miss.push("NODEGET_API_TOKEN");
  if (!cfg.mappings.length) miss.push("MAPPINGS (or legacy CF_RECORD_NAME + AGENT_UUID)");
  // SHARED_SECRET is only needed if you want to invoke onRoute over HTTP. Pure
  // blocking-task / cron-pull deployments don't need it. Enforced inside onRoute below.
  return miss;
}

function checkMapping(m) {
  const miss = [];
  if (!m.agent_uuid && !m.cron_name_fetch_ip) miss.push("agent_uuid (recommended) or cron_name_fetch_ip (fallback)");
  if (!m.zone_id) miss.push("zone_id (or env.CF_ZONE_ID)");
  if (!m.record_v4 && !m.record_v6) miss.push("record_v4 / record_v6");
  if (m.family === "v4" && !m.record_v4) miss.push("record_v4 (family=v4 requires it)");
  if (m.family === "v6" && !m.record_v6) miss.push("record_v6 (family=v6 requires it)");
  if (m.family === "both" && (!m.record_v4 || !m.record_v6)) miss.push("both record_v4 and record_v6 (family=both)");
  return miss;
}

function authorized(request, secret) {
  const h = request.headers.get("authorization") || request.headers.get("Authorization") || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return false;
  return constantEq(m[1].trim(), secret);
}
function constantEq(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function nameForType(m, type) {
  return type === "AAAA" ? m.record_v6 : m.record_v4;
}
function recordIdFromMapping(m, type) {
  return type === "AAAA" ? m.record_id_v6 : m.record_id_v4;
}

async function resolveRecordId(cfg, m, type) {
  const fromMapping = recordIdFromMapping(m, type);
  if (fromMapping) return fromMapping;
  const cached = await kvGet(cfg.ngToken, KV_RECORD_ID(m.name, type));
  const want = nameForType(m, type);
  if (cached && cached.name === want && cached.type === type) return cached.id;
  const rec = await lookupRecord(cfg.cfToken, m.zone_id, want, type);
  if (!rec) {
    throw new Error(
      `Cloudflare has no ${type} record named "${want}" in zone ${m.zone_id} (mapping="${m.name}"). ` +
        `Create it once manually first.`
    );
  }
  await kvSet(cfg.ngToken, KV_RECORD_ID(m.name, type), { id: rec.id, name: rec.name, type: rec.type });
  return rec.id;
}

// Update a single (mapping, type) — returns { changed | error, ... }.
async function updateOne(cfg, m, type, ip, { force = false } = {}) {
  if (!isRoutable(ip)) return { changed: false, error: "ip_not_routable", ip, type };
  const detected = classify(ip);
  if (!detected || detected !== type) return { changed: false, error: "ip_type_mismatch", ip, type, detected };

  const last = await kvGet(cfg.ngToken, KV_LAST_IP(m.name, type));
  if (!force && last?.ip === ip) {
    return { changed: false, ip, type, last_update_ts: await kvGet(cfg.ngToken, KV_LAST_TS(m.name, type)) };
  }

  const recordId = await resolveRecordId(cfg, m, type);
  const patched = await patchRecord(cfg.cfToken, m.zone_id, recordId, {
    content: ip,
    ttl: m.ttl,
    proxied: m.proxied,
    type,
    name: nameForType(m, type),
  });
  const ts = new Date().toISOString();
  await kvSet(cfg.ngToken, KV_LAST_IP(m.name, type), { ip, type });
  await kvSet(cfg.ngToken, KV_LAST_TS(m.name, type), ts);
  return {
    changed: true,
    ip,
    type,
    record_id: recordId,
    name: patched?.name || nameForType(m, type),
    ttl: patched?.ttl ?? m.ttl,
    proxied: patched?.proxied ?? m.proxied,
    last_update_ts: ts,
  };
}

function typesFor(family) {
  return family === "both" ? ["A", "AAAA"] : [family === "v6" ? "AAAA" : "A"];
}

// Heartbeat: stale per (mapping, type)? Force a re-push.
async function shouldHeartbeat(cfg, m) {
  if (cfg.heartbeatHours <= 0) return false;
  const threshold = cfg.heartbeatHours * 3600 * 1000;
  for (const t of typesFor(m.family)) {
    const lastTs = await kvGet(cfg.ngToken, KV_LAST_TS(m.name, t));
    const age = Date.now() - (lastTs ? Date.parse(lastTs) : 0);
    if (age >= threshold) return true;
  }
  return false;
}

// Resolve current IP for a mapping. Prefers blocking task (agent_uuid); falls back
// to crontab_result_query (cron_name_fetch_ip) on error or when uuid not configured.
async function resolveIp(cfg, m) {
  if (m.agent_uuid) {
    try {
      return await runAgentIpTaskBlocking(cfg.ngToken, m.agent_uuid, m.family, m.ip_task_timeout_ms);
    } catch (e) {
      if (!m.cron_name_fetch_ip) {
        return { v4: null, v6: null, source: "task_blocking_failed", error: String(e?.message || e) };
      }
      const cron = await fetchAgentIpFromCron(cfg.ngToken, m.cron_name_fetch_ip);
      return { ...cron, source: "crontab_result_after_blocking_failed", blocking_error: String(e?.message || e) };
    }
  }
  return fetchAgentIpFromCron(cfg.ngToken, m.cron_name_fetch_ip);
}

// Sync one mapping: resolve IP from agent → update v4/v6 on CF if changed.
async function syncMapping(cfg, m, { force = false } = {}) {
  const missM = checkMapping(m);
  if (missM.length) return { mapping: m.name, error: "missing_mapping_fields", missing: missM };

  const fetched = await resolveIp(cfg, m);
  if (!fetched.v4 && !fetched.v6) {
    return {
      mapping: m.name,
      error: "no_ip_from_agent",
      agent_uuid: m.agent_uuid || null,
      cron_name: m.cron_name_fetch_ip || null,
      source: fetched.source,
      detail: fetched.error || fetched.blocking_error || null,
      raw_v4: fetched.raw_v4,
      raw_v6: fetched.raw_v6,
    };
  }
  const doForce = force || (await shouldHeartbeat(cfg, m));
  const out = { mapping: m.name, source: fetched.source, run_time: fetched.run_time, results: {} };

  if ((m.family === "v4" || m.family === "both") && fetched.v4 && m.record_v4) {
    try { out.results.A = await updateOne(cfg, m, "A", fetched.v4, { force: doForce }); }
    catch (e) { out.results.A = errorBody(e); }
  }
  if ((m.family === "v6" || m.family === "both") && fetched.v6 && m.record_v6) {
    try { out.results.AAAA = await updateOne(cfg, m, "AAAA", fetched.v6, { force: doForce }); }
    catch (e) { out.results.AAAA = errorBody(e); }
  }
  return out;
}

// Push-mode sync (manual / sh-agent fallback): explicit IP for one mapping.
async function pushOne(cfg, mappingName, ip, type, { force = false }) {
  const m = cfg.mappings.find((x) => x.name === mappingName) || cfg.mappings[0];
  if (!m) return { error: "no_mapping", mappingName };
  const missM = checkMapping(m);
  if (missM.length) return { error: "missing_mapping_fields", missing: missM, mapping: m.name };
  try {
    const r = await updateOne(cfg, m, type, ip, { force });
    return { mapping: m.name, source: "body", ...r };
  } catch (e) {
    return { mapping: m.name, ...errorBody(e) };
  }
}

function errorBody(e) {
  if (e instanceof CloudflareError) {
    return { error: "cloudflare_api_error", message: String(e.message), cf_status: e.status, cf_body: e.body };
  }
  return { error: "internal_error", message: String(e?.message || e) };
}

function filterMappings(cfg, only) {
  if (!only) return cfg.mappings;
  const arr = (Array.isArray(only) ? only : [only]).map(String);
  return cfg.mappings.filter((m) => arr.includes(m.name));
}

async function runAll(cfg, { only, force } = {}) {
  const targets = filterMappings(cfg, only);
  if (!targets.length) return { ok: false, error: "no_mapping_matched", only };
  const results = [];
  for (const m of targets) {
    results.push(await syncMapping(cfg, m, { force }));
  }
  return { ok: true, count: results.length, results };
}

async function handleHealth(cfg) {
  const out = { ok: true, mappings: [] };
  for (const m of cfg.mappings) {
    const types = typesFor(m.family);
    const state = {};
    for (const t of types) {
      state[t] = {
        last_ip: await kvGet(cfg.ngToken, KV_LAST_IP(m.name, t)),
        last_update_ts: await kvGet(cfg.ngToken, KV_LAST_TS(m.name, t)),
        record_id_cached: await kvGet(cfg.ngToken, KV_RECORD_ID(m.name, t)),
      };
    }
    out.mappings.push({
      name: m.name,
      cron_name_fetch_ip: m.cron_name_fetch_ip,
      record_v4: m.record_v4,
      record_v6: m.record_v6,
      family: m.family,
      zone_id: m.zone_id,
      state,
    });
  }
  return json(200, out);
}

// Shared execution path for onCall / onInlineCall / onCron — all three have the same
// (params, env, ctx) signature and identical semantics in this worker:
//   - read env into cfg
//   - apply params.mappings override (if any)
//   - validate global env
//   - run sync over all/filtered mappings
async function executeRun(params, env, _ctx) {
  let cfg = readEnv(env);
  cfg = applyMappingsOverride(cfg, env, params);
  const miss = checkGlobalEnv(cfg);
  if (miss.length) return { ok: false, error: "missing_env", missing: miss };
  // NodeGet KV namespaces don't auto-create — list-and-create the "ddns" namespace
  // on the first call. Module-level flag short-circuits subsequent calls if the
  // worker instance is reused; safe to re-run when it's a fresh instance.
  await ensureNamespace(cfg.ngToken);
  const opts = (params && typeof params === "object") ? params : {};
  return await runAll(cfg, { only: opts.only, force: !!opts.force });
}

export default {
  async onRoute(request, env, ctx) {
    let cfg = readEnv(env);
    const trace = ctx && typeof ctx.uuid === "function" ? ctx.uuid() : String(Date.now());
    const url = new URL(request.url);

    if (url.pathname.endsWith("/health")) {
      const miss = checkGlobalEnv(cfg);
      if (miss.length) return json(500, { error: "missing_env", missing: miss, trace_id: trace });
      return handleHealth(cfg);
    }

    if (request.method !== "POST" && request.method !== "PUT") {
      return json(405, { error: "method_not_allowed", trace_id: trace });
    }
    // onRoute requires SHARED_SECRET. Without it, the HTTP entry is disabled —
    // pure blocking/cron deployments simply don't expose this surface.
    if (!cfg.secret) {
      return json(503, {
        error: "http_route_disabled",
        hint: "set SHARED_SECRET in env to enable POST /<route>",
        trace_id: trace,
      });
    }
    if (!authorized(request, cfg.secret)) {
      return json(401, { error: "unauthorized", trace_id: trace });
    }

    let body = {};
    try {
      const text = await request.text();
      if (text && text.trim()) body = JSON.parse(text);
    } catch {
      return json(400, { error: "invalid_json", trace_id: trace });
    }

    // body.mappings (or .MAPPINGS) — fully replace env.MAPPINGS for this call.
    cfg = applyMappingsOverride(cfg, env, body);

    const missG = checkGlobalEnv(cfg);
    if (missG.length) return json(500, { error: "missing_env", missing: missG, trace_id: trace });

    const force = !!body.force;
    const only = body.only ?? body.mapping;

    // Explicit IP push (sh-agent fallback or manual override)
    if (typeof body.ip === "string" && body.ip.trim()) {
      const ip = body.ip.trim();
      const type = body.type || classify(ip);
      if (!type) return json(400, { error: "ip_invalid", ip, trace_id: trace });
      const r = await pushOne(cfg, only || cfg.mappings[0]?.name, ip, type, { force });
      return json(r.error ? 502 : 200, { trace_id: trace, ...r });
    }

    // NG-Connecting-IP fallback (only if no mapping has cron_name_fetch_ip — pure push deployment)
    const peer = (request.headers.get("ng-connecting-ip") || "").trim();
    const allMappingsPushOnly = cfg.mappings.every((m) => !m.cron_name_fetch_ip);
    if (peer && cfg.trustPeerHeader && allMappingsPushOnly) {
      const type = classify(peer);
      if (!type) return json(400, { error: "peer_ip_invalid", ip: peer, trace_id: trace });
      const r = await pushOne(cfg, only || cfg.mappings[0]?.name, peer, type, { force });
      return json(r.error ? 502 : 200, { trace_id: trace, source: "ng-connecting-ip", ...r });
    }

    // Default: run pull flow over all (or filtered) mappings.
    const out = await runAll(cfg, { only, force });
    return json(out.ok ? 200 : 400, { trace_id: trace, ...out });
  },

  // Server-cron entry. Signature: (params, env, ctx). `params` comes from
  // crontab_create's cron_type.server.js_worker[1]. Supported keys:
  //   {}                          → sync all mappings (default)
  //   { only: "nas" }             → sync just mapping by name (string or array)
  //   { force: true }             → re-PATCH CF even if KV says unchanged
  // NodeGet cron is 6-segment: "sec min hr day mon weekday".
  //   Recommended: "30 */5 * * * *" (every 5min @ :30, after agent ip crons fire at :00)
  async onCron(params, env, ctx) {
    return executeRun(params, env, ctx);
  },

  // Manual invocation via NodeGet console "Run" button or `js-worker_run` JSON-RPC.
  // Same semantics as onCron — supports {only, force, mappings} the same way.
  async onCall(params, env, ctx) {
    return executeRun(params, env, ctx);
  },

  // Worker-to-worker inline call. Same semantics.
  async onInlineCall(params, env, ctx) {
    return executeRun(params, env, ctx);
  },
};
