// NodeGet js-worker entrypoint — Cloudflare DDNS bridge (blocking mode only).
//
// Each tick:
//   1. for each mapping in env.MAPPINGS (or params.mappings override):
//   2.   task_create_task_blocking → ip.nodeget.com via agent egress → public IP
//   3.   compare against KV last_ip;
//   4.   if changed (or force), PATCH the Cloudflare DNS record.
//
// Triggers:
//   onCron       — scheduled server cron, the production path
//   onCall       — manual run via NodeGet dashboard "Run" button or js-worker_run RPC
//   onInlineCall — worker-to-worker call
//   onRoute      — HTTP route is disabled, returns 404
//
// params shape (cron/call):
//   {}                            sync all mappings
//   { "only": "home" }            sync one mapping by name (string or array)
//   { "force": true }             skip KV unchanged short-circuit
//   { "mappings": [...] }         replace env.MAPPINGS for this run

import { kvGet, kvSet, ensureNamespace } from "./kv.js";
import { lookupRecord, patchRecord, CloudflareError } from "./cloudflare.js";
import { classify, isRoutable } from "./ip.js";
import { runAgentIpTaskBlocking } from "./nodeget.js";

const KV_LAST_IP = (name, type) => `last_ip:${name}:${type}`;
const KV_LAST_TS = (name, type) => `last_update_ts:${name}:${type}`;
const KV_RECORD_ID = (name, type) => `record_id_cache:${name}:${type}`;

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

function readEnv(env) {
  env = env || {};
  const defaults = {
    zoneId: asStr(env.CF_ZONE_ID),
    ttl: asNum(env.CF_RECORD_TTL, 60),
    proxied: asBool(env.CF_RECORD_PROXIED, false),
  };

  let mappings = [];
  let rawMappings = env.MAPPINGS;
  if (typeof rawMappings === "string" && rawMappings.trim()) {
    try { rawMappings = JSON.parse(rawMappings); } catch { rawMappings = null; }
  }
  if (Array.isArray(rawMappings)) {
    mappings = rawMappings;
  } else {
    // Legacy flat env (single mapping shortcut).
    const legacyRecordV4 = asStr(env.CF_RECORD_NAME_V4) || asStr(env.CF_RECORD_NAME);
    const legacyRecordV6 = asStr(env.CF_RECORD_NAME_V6) || asStr(env.CF_RECORD_NAME);
    if (legacyRecordV4 || legacyRecordV6 || env.AGENT_UUID) {
      mappings = [{
        name: "default",
        agent_uuid: asStr(env.AGENT_UUID),
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
    ngToken: asStr(env.NODEGET_API_TOKEN) || asStr(env.token),
    heartbeatHours: asNum(env.HEARTBEAT_HOURS, 24),
    defaults,
    mappings,
  };
}

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
  return miss;
}

function checkMapping(m) {
  const miss = [];
  if (!m.agent_uuid) miss.push("agent_uuid");
  if (!m.zone_id) miss.push("zone_id (or env.CF_ZONE_ID)");
  if (m.family === "v4" && !m.record_v4) miss.push("record_v4");
  if (m.family === "v6" && !m.record_v6) miss.push("record_v6");
  if (m.family === "both" && (!m.record_v4 || !m.record_v6)) miss.push("both record_v4 and record_v6");
  return miss;
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

async function syncMapping(cfg, m, { force = false } = {}) {
  const missM = checkMapping(m);
  if (missM.length) return { mapping: m.name, error: "missing_mapping_fields", missing: missM };

  const fetched = await runAgentIpTaskBlocking(cfg.ngToken, m.agent_uuid, m.family, m.ip_task_timeout_ms);
  if (!fetched.v4 && !fetched.v6) {
    return {
      mapping: m.name,
      error: "no_ip_from_agent",
      agent_uuid: m.agent_uuid,
      source: fetched.source,
      raw_v4: fetched.raw_v4,
      raw_v6: fetched.raw_v6,
    };
  }

  const doForce = force || (await shouldHeartbeat(cfg, m));
  const out = { mapping: m.name, source: fetched.source, results: {} };

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

async function executeRun(params, env, _ctx) {
  let cfg = readEnv(env);
  cfg = applyMappingsOverride(cfg, env, params);
  const miss = checkGlobalEnv(cfg);
  if (miss.length) return { ok: false, error: "missing_env", missing: miss };
  await ensureNamespace(cfg.ngToken);
  const opts = (params && typeof params === "object") ? params : {};
  return await runAll(cfg, { only: opts.only, force: !!opts.force });
}

export default {
  async onCron(params, env, ctx)        { return executeRun(params, env, ctx); },
  async onCall(params, env, ctx)        { return executeRun(params, env, ctx); },
  async onInlineCall(params, env, ctx)  { return executeRun(params, env, ctx); },

  // HTTP route is disabled. Trigger via cron (production) or onCall (manual / debug).
  async onRoute(_request, _env, _ctx) {
    return new Response("HTTP route disabled. Trigger via NodeGet cron or the dashboard Run button (onCall).\n", { status: 404 });
  },
};
