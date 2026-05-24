#!/bin/sh
# ddns-agent — push current public IP to the NodeGet js-worker DDNS endpoint.
#
# POSIX sh + curl. Tested on:
#   - macOS (bash 3.2 / dash via sh)
#   - Debian / Ubuntu / Alpine / OpenWrt (BusyBox sh)
#   - Synology DSM (ash)
#
# Config (loaded in order, later overrides earlier):
#   /etc/ddns-agent/config
#   $HOME/.config/ddns-agent/config
#   $DDNS_AGENT_CONFIG (if set)
#
# Required:
#   WORKER_URL       full URL to the worker route, e.g.
#                    https://nodeget.example.com/nodeget/worker-route/ddns
#   SHARED_SECRET    matches worker env SHARED_SECRET
#
# Optional:
#   IP_FAMILY        "4" (default) or "6"
#   FORCE            "1" to bypass worker's "ip unchanged" short-circuit
#   STATE_FILE       path to local cache of last IP (default per-user/per-root)
#   CURL_TIMEOUT     seconds, default 10
#   IP_PROVIDERS     space-separated list of URLs that echo a bare IP
#
# Exit codes:
#   0  success (changed or not)
#   1  config error
#   2  could not determine public IP
#   3  worker call failed
#   4  worker returned auth or validation error

set -u

log() { printf '[ddns-agent %s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }

die() { log "ERROR: $2"; exit "$1"; }

# --- defaults ---
IP_FAMILY="${IP_FAMILY:-4}"
FORCE="${FORCE:-0}"
CURL_TIMEOUT="${CURL_TIMEOUT:-10}"
WORKER_URL="${WORKER_URL:-}"
SHARED_SECRET="${SHARED_SECRET:-}"

# state dir: root → /var/lib; non-root → XDG cache
if [ "$(id -u 2>/dev/null || echo 0)" = "0" ]; then
  DEFAULT_STATE_DIR="/var/lib/ddns-agent"
else
  DEFAULT_STATE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/ddns-agent"
fi
STATE_FILE="${STATE_FILE:-$DEFAULT_STATE_DIR/last_ip_v$IP_FAMILY}"

# --- load configs ---
for f in /etc/ddns-agent/config "$HOME/.config/ddns-agent/config" "${DDNS_AGENT_CONFIG:-}"; do
  [ -n "$f" ] && [ -f "$f" ] && . "$f"
done

# --- CLI flags ---
DRY=0
VERBOSE=0
while [ $# -gt 0 ]; do
  case "$1" in
    -d|--dry-run) DRY=1 ;;
    -v|--verbose) VERBOSE=1 ;;
    -f|--force)   FORCE=1 ;;
    -h|--help)
      sed -n '2,40p' "$0"; exit 0 ;;
    *) die 1 "unknown flag: $1" ;;
  esac
  shift
done

[ -n "$WORKER_URL" ] || die 1 "WORKER_URL not set"
[ -n "$SHARED_SECRET" ] || die 1 "SHARED_SECRET not set"

# --- providers ---
if [ -z "${IP_PROVIDERS:-}" ]; then
  if [ "$IP_FAMILY" = "6" ]; then
    IP_PROVIDERS="https://api64.ipify.org https://ifconfig.co/ip https://ipv6.icanhazip.com"
  else
    # cloudflare trace is the most reliable — it's an A-only host
    IP_PROVIDERS="https://www.cloudflare.com/cdn-cgi/trace https://api.ipify.org https://ifconfig.co/ip https://ipv4.icanhazip.com"
  fi
fi

# curl family flag
case "$IP_FAMILY" in
  4) FAMILY_FLAG="-4" ;;
  6) FAMILY_FLAG="-6" ;;
  *) die 1 "IP_FAMILY must be 4 or 6 (got: $IP_FAMILY)" ;;
esac

# --- helpers ---
fetch_ip() {
  for url in $IP_PROVIDERS; do
    out=$(curl $FAMILY_FLAG -fsS --max-time "$CURL_TIMEOUT" "$url" 2>/dev/null) || continue
    # cloudflare trace returns key=value lines; extract `ip=`
    case "$url" in
      *cdn-cgi/trace*)
        out=$(printf '%s\n' "$out" | awk -F= '/^ip=/{print $2; exit}')
        ;;
    esac
    # strip whitespace
    out=$(printf '%s' "$out" | tr -d '[:space:]')
    [ -n "$out" ] || continue
    # crude sanity: v4 has dots, v6 has colons
    case "$IP_FAMILY:$out" in
      4:*[!0-9.]*) continue ;;
      4:*.*.*.*)   printf '%s' "$out"; return 0 ;;
      6:*:*)       printf '%s' "$out"; return 0 ;;
    esac
  done
  return 1
}

read_cache() {
  [ -f "$STATE_FILE" ] && cat "$STATE_FILE" 2>/dev/null
}

write_cache() {
  mkdir -p "$(dirname "$STATE_FILE")" 2>/dev/null || true
  printf '%s' "$1" > "$STATE_FILE.tmp" && mv -f "$STATE_FILE.tmp" "$STATE_FILE"
}

# --- main ---
ip=$(fetch_ip) || die 2 "could not determine public IPv$IP_FAMILY from any provider"
[ "$VERBOSE" = "1" ] && log "current public IPv$IP_FAMILY: $ip"

cached=$(read_cache || true)
if [ "$FORCE" != "1" ] && [ "$cached" = "$ip" ]; then
  [ "$VERBOSE" = "1" ] && log "unchanged ($ip) — skipping worker call"
  exit 0
fi

[ "$VERBOSE" = "1" ] && log "ip changed: ${cached:-<none>} → $ip — pushing"

if [ "$DRY" = "1" ]; then
  log "dry-run: would POST $WORKER_URL ip=$ip force=$FORCE"
  exit 0
fi

# v4 → A, v6 → AAAA
if [ "$IP_FAMILY" = "6" ]; then rtype="AAAA"; else rtype="A"; fi
force_json=$([ "$FORCE" = "1" ] && echo "true" || echo "false")
body=$(printf '{"ip":"%s","type":"%s","force":%s}' "$ip" "$rtype" "$force_json")

http_response=$(curl -sS -o /tmp/ddns-agent.resp.$$ -w '%{http_code}' \
  --max-time "$CURL_TIMEOUT" \
  -X POST "$WORKER_URL" \
  -H "Authorization: Bearer $SHARED_SECRET" \
  -H "Content-Type: application/json" \
  --data "$body") || {
    rm -f /tmp/ddns-agent.resp.$$
    die 3 "worker call failed (network/timeout)"
  }

resp=$(cat /tmp/ddns-agent.resp.$$ 2>/dev/null || echo "")
rm -f /tmp/ddns-agent.resp.$$

case "$http_response" in
  2*)
    [ "$VERBOSE" = "1" ] && log "worker OK ($http_response): $resp"
    write_cache "$ip"
    exit 0 ;;
  401|403)
    die 4 "worker rejected ($http_response): $resp" ;;
  4*)
    die 4 "worker 4xx ($http_response): $resp" ;;
  *)
    die 3 "worker $http_response: $resp" ;;
esac
