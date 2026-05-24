// NodeGet server JSON-RPC bridge via globalThis.nodeget.
// All RPC calls take a `token` field (env.NODEGET_API_TOKEN).

function rpc(method, params) {
  if (typeof globalThis.nodeget !== "function") {
    throw new Error("globalThis.nodeget is not available — are we running outside NodeGet?");
  }
  return globalThis.nodeget(method, params);
}

// Dispatch an http_request task to a specific agent's egress, forced to a given family.
// Pattern lifted from NodeGet's built-in ip-location-update worker:
//   GET https://ip.nodeget.com/json?filter=ip  with  ip: "ipv4 auto" | "ipv6 auto"
// The agent fetches that URL from the chosen family's egress; the response body contains
// JSON like { "address": "1.2.3.4", "asn": ..., "location": {...} }. Field is "address",
// not "ip" — confirmed against live HiNet agent response.
async function fetchIpForFamily(token, agentUuid, family, timeoutMs) {
  try {
    const resp = await rpc("task_create_task_blocking", {
      token,
      target_uuid: agentUuid,
      timeout_ms: timeoutMs,
      task_type: {
        http_request: {
          url: "https://ip.nodeget.com/json?filter=ip",
          method: "GET",
          headers: { "content-type": "application/json" },
          body: "",
          ip: `ipv${family} auto`,
        },
      },
    });
    const ev = resp?.result;
    if (!ev || ev.success === false) {
      return { ip: null, error: ev?.error_message || "task failed", raw: resp };
    }
    const body = ev?.task_event_result?.http_request?.body;
    if (!body) return { ip: null, raw: resp };
    let parsed;
    try { parsed = JSON.parse(body); } catch { return { ip: null, raw: body }; }
    // Field is "address" per ip.nodeget.com; tolerate "ip" alias too.
    return { ip: parsed?.address || parsed?.ip || null, parsed, raw: resp };
  } catch (e) {
    return { ip: null, error: String(e?.message || e) };
  }
}

// Public: probe the families this mapping cares about. Returns { v4, v6, source, raw_* }.
// `family` ∈ "v4" | "v6" | "both" — only the requested families are queried, no wasted RPC.
export async function runAgentIpTaskBlocking(token, agentUuid, family = "v4", timeoutMs = 5000) {
  const need4 = family === "v4" || family === "both";
  const need6 = family === "v6" || family === "both";
  const [r4, r6] = await Promise.all([
    need4 ? fetchIpForFamily(token, agentUuid, 4, timeoutMs) : Promise.resolve(null),
    need6 ? fetchIpForFamily(token, agentUuid, 6, timeoutMs) : Promise.resolve(null),
  ]);
  const v4 = r4?.ip && r4.ip.includes(".") ? r4.ip : null;
  const v6 = r6?.ip && r6.ip.includes(":") ? r6.ip : null;
  const out = { v4, v6, source: "task_blocking", agent_uuid: agentUuid };
  // Only echo raw for families we actually probed and that didn't yield an IP.
  if (need4 && !v4) out.raw_v4 = r4;
  if (need6 && !v6) out.raw_v6 = r6;
  return out;
}

// crontab-result_query — legacy fallback path when blocking task can't be used.
// Tolerates several historical response shapes.
function parseIpFromResultRow(row) {
  if (!row) return { v4: null, v6: null };
  let payload = row.result ?? row.data ?? row.message ?? row;
  if (typeof payload === "string") {
    try { payload = JSON.parse(payload); }
    catch {
      const v4m = payload.match(/\b(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}\b/);
      const v6m = payload.match(/\b(?:[0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}\b/);
      return { v4: v4m?.[0] || null, v6: v6m?.[0] || null };
    }
  }
  const arr = payload?.ip ?? payload?.task?.ip ?? payload?.execute?.ip ?? null;
  if (Array.isArray(arr)) {
    let v4 = null, v6 = null;
    for (const s of arr) {
      if (typeof s !== "string") continue;
      if (s.includes(".") && !v4) v4 = s;
      else if (s.includes(":") && !v6) v6 = s;
    }
    return { v4, v6 };
  }
  if (typeof arr === "string") {
    return arr.includes(".") ? { v4: arr, v6: null } : { v4: null, v6: arr };
  }
  return {
    v4: payload?.v4 ?? payload?.ipv4 ?? null,
    v6: payload?.v6 ?? payload?.ipv6 ?? null,
  };
}

export async function fetchAgentIpFromCron(token, cronName) {
  const resp = await rpc("crontab-result_query", {
    token,
    query: {
      condition: [
        { cron_name: cronName },
        { is_success: true },
        { last: true },
        { limit: 1 },
      ],
    },
  });
  const rows = Array.isArray(resp) ? resp : (resp?.result ?? resp?.data ?? resp?.rows ?? []);
  if (!rows.length) return { v4: null, v6: null, source: "no_result" };
  const ipv = parseIpFromResultRow(rows[0]);
  return { ...ipv, source: "crontab_result", row_id: rows[0]?.id, run_time: rows[0]?.run_time };
}
