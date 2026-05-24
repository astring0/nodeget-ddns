# nodeget-cloudflare-ddns

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![runtime](https://img.shields.io/badge/runtime-NodeGet%20js--worker%20%28QuickJS%29-blue)](https://nodeget.com/guide/js-worker/architecture.html)
[![dns](https://img.shields.io/badge/dns-Cloudflare-orange)](https://developers.cloudflare.com/api/operations/dns-records-for-a-zone-patch-dns-record)

家用宽带 DDNS。在 NodeGet `js-worker`(QuickJS)上跑,服务端 cron 定时给家里的 NodeGet agent 派任务取公网 IP,变了就 PATCH Cloudflare DNS。**家里只装 NodeGet agent,无任何额外脚本 / systemd / cron。**

## 架构

```
NodeGet 平台
  └─ Server cron (每 5 分钟)
      └─ worker.onCron
          └─ for each mapping in env.MAPPINGS:
              task_create_task_blocking(
                target_uuid: m.agent_uuid,
                task_type: { http_request: { url: "ip.nodeget.com/json", ip: "ipv4 auto" } }
              )                                ── agent 同步返回公网 IP
              └─ KV 对比 last_ip,变了就 fetch Cloudflare PATCH
```

## 部署

### 1. 准备 Cloudflare

1. [建一个 API Token](https://dash.cloudflare.com/profile/api-tokens),权限 **Zone → DNS → Edit**,作用域限定到目标 zone
2. 拿到 **Zone ID**(Cloudflare 域名概览页右下角 API 区)
3. **手动在 Cloudflare 建一次目标 A / AAAA 记录**(IP 随便填,worker 只 PATCH 不创建)

### 2. 准备 NodeGet

1. [生成一个 NodeGet API Token](https://dash.nodeget.com/)(dashboard 的 API token 区)
2. 在家里机器上[装好 NodeGet agent](https://nodeget.com/guide/install/install-script.html),记下它的 **agent uuid**(控制台节点列表里能看)

### 3. 编译 worker

```bash
pnpm install
pnpm run build
# → dist/worker.js (单文件 ESM,约 23 KB)
```

### 4. 上传 worker

用 NodeGet dashboard UI 上传 `dist/worker.js`,或通过 `js-worker_create` JSON-RPC 上传(`js_script_base64` 字段)。

`env` 字段填入(完整模板见 [`.env.example`](.env.example)):

```json
{
  "CF_API_TOKEN":      "cf-...",
  "NODEGET_API_TOKEN": "ng-...",
  "CF_ZONE_ID":        "0123456789abcdef0123456789abcdef",
  "MAPPINGS": [
    {
      "name":       "home",
      "agent_uuid": "your-agent-uuid",
      "record_v4":  "home.example.com",
      "family":     "v4"
    }
  ]
}
```

### 5. 注册 server cron

发一个 `crontab_create` JSON-RPC(参考 [`cron.example.json`](cron.example.json)):

```json
{
  "method": "crontab_create",
  "params": {
    "token": "ng-...",
    "name": "ddns-cf-sync",
    "cron_expression": "0 */5 * * * *",
    "cron_type": {
      "server": { "js_worker": ["YOUR_WORKER_NAME", {}] }
    }
  }
}
```

> NodeGet cron 表达式是 **6 段**:`秒 分 时 日 月 周`。

### 6. 验证

在 NodeGet dashboard 点 worker 的 "Run" 按钮(走 `onCall`,跟 cron 行为一致)。第一次跑应该看到:

```json
{
  "ok": true,
  "results": [{
    "mapping": "home",
    "source": "task_blocking",
    "results": {
      "A": {
        "changed": true,
        "ip": "<家公网 IP>",
        "name": "home.example.com",
        "record_id": "...",
        "last_update_ts": "2026-..."
      }
    }
  }]
}
```

第二次跑,IP 没变,会看到 `"changed": false`(KV 短路,不重复 PATCH)。

## 多域名 / 多 agent

`MAPPINGS` 是数组,加项即可。各 mapping 有独立 KV 命名空间,互不影响。

```json
"MAPPINGS": [
  {
    "name": "home",
    "agent_uuid": "uuid-of-home-router",
    "record_v4": "home.example.com",
    "record_v6": "home.example.com",
    "family": "both"
  },
  {
    "name": "nas",
    "agent_uuid": "uuid-of-nas",
    "record_v4": "nas.example.com",
    "family": "v4"
  }
]
```

一条 server cron 默认遍历所有 mapping。给某个 mapping 单独排程:再注册一条 cron 传 `{"only": "nas"}`。每天强制重 PATCH 一次防 dashboard 手动改:再一条 cron 传 `{"force": true}`,`cron_expression: "0 0 3 * * *"`。完整范例在 [`cron.example.json`](cron.example.json)。

## env 字段速查

| 字段 | 必填 | 说明 |
|---|---|---|
| `CF_API_TOKEN` | ✓ | Cloudflare API Token, Zone:DNS:Edit |
| `NODEGET_API_TOKEN` | ✓ | NodeGet 平台 API Token(别名 `token`)|
| `CF_ZONE_ID` | 按需 | 默认 Zone ID;每个 mapping 都填了 `zone_id` 时可省 |
| `MAPPINGS` | ✓ | JSON 数组,见 [`.env.example`](.env.example) |
| `CF_RECORD_TTL` | 否(默认 60)| 默认 TTL |
| `CF_RECORD_PROXIED` | 否(默认 false)| 默认是否走 CF 代理 |
| `IP_TASK_TIMEOUT_MS` | 否(默认 10000)| blocking task 等待超时(ms)|
| `HEARTBEAT_HOURS` | 否(默认 24)| 多少小时强制重 PATCH 一次 |

cron `params` 支持的 override:

| key | 行为 |
|---|---|
| `{}` | 默认 — 遍历所有 mapping |
| `{"only": "name"}` | 只跑指定 mapping(可数组)|
| `{"force": true}` | 跳过 KV 未变短路 |
| `{"mappings": [...]}` | 完全替换 env.MAPPINGS(用于多租户;不要在这里塞 token)|

## 故障排查

| 现象 | 排查 |
|---|---|
| `missing_env` | 检查 `.env.example` 必填字段,特别是 `NODEGET_API_TOKEN` |
| `no_ip_from_agent` + `source: task_blocking` | agent 离线 / 超时 / 不允许 `http_request` 任务类型(检查 `/etc/nodeget-agent.conf` 的 `allow_task_type`) |
| `missing_mapping_fields` | `agent_uuid` / `record_v4|v6` / `zone_id` 之一缺失;响应里 `missing` 字段会列出来 |
| `cloudflare_api_error` + 404 | `CF_ZONE_ID` 错,或目标 DNS record 没预先建好 |
| `cloudflare_api_error` + 401 | CF token 权限不足或过期 |
| 每次都 `changed: true` | KV namespace 没创建成功 — 检查 NodeGet KV 列表里是否存在 `ddns` namespace |
| QuickJS 报 `import` | 上传了 `src/index.js` 而不是 `dist/worker.js`,必须用 esbuild 打包后的产物 |

## 致谢

IP 探测 pattern(`http_request` 到 `https://ip.nodeget.com/json?filter=ip` + `ipv4/6 auto`)借鉴自 NodeGet 平台内置的 `ip-location-update` worker。新写 NodeGet worker 强烈建议先精读它 — 文档没明写的细节(token 必传、KV namespace 必须显式 create 等)都在那份源码里。

## License

[MIT](LICENSE) © 2026 astring0
