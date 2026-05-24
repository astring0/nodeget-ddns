// NodeGet KV via injected globalThis.nodeget JSON-RPC bridge.
// All server-side methods require a `token` field (env.NODEGET_API_TOKEN). The reference
// implementation in NodeGet's built-in `ip-location-update` worker confirms this — without
// token, calls return silently empty or fail.

const NS = "ddns";

function rpc(method, params) {
  if (typeof globalThis.nodeget !== "function") {
    throw new Error("globalThis.nodeget is not available — running outside NodeGet?");
  }
  return globalThis.nodeget(method, params);
}

export async function kvGet(token, key) {
  try {
    const r = await rpc("kv_get_value", { token, namespace: NS, key });
    const v = r?.result ?? r;
    if (v == null) return null;
    if (typeof v === "object" && "value" in v) return v.value;
    return v;
  } catch (e) {
    if (String(e?.message || e).toLowerCase().includes("not found")) return null;
    throw e;
  }
}

export async function kvSet(token, key, value) {
  return rpc("kv_set_value", { token, namespace: NS, key, value });
}

export async function kvDelete(token, key) {
  return rpc("kv_delete_key", { token, namespace: NS, key });
}

// Ensure the namespace exists. Idempotent — checks kv_list_all_namespace first.
let _namespaceEnsured = false;
export async function ensureNamespace(token) {
  if (_namespaceEnsured) return;
  try {
    const r = await rpc("kv_list_all_namespace", { token });
    const names = r?.result ?? r?.namespaces ?? r ?? [];
    const has = Array.isArray(names) ? names.includes(NS) : false;
    if (!has) {
      await rpc("kv_create", { token, namespace: NS });
    }
    _namespaceEnsured = true;
  } catch {
    // tolerate — many deployments auto-create namespaces on first set
  }
}
