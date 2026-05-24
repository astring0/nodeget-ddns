# nodeget-cloudflare-ddns

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![runtime](https://img.shields.io/badge/runtime-NodeGet%20js--worker%20%28QuickJS%29-blue)](https://nodeget.com/guide/js-worker/architecture.html)
[![dns](https://img.shields.io/badge/dns-Cloudflare-orange)](https://developers.cloudflare.com/api/operations/dns-records-for-a-zone-patch-dns-record)

NodeGet `js-worker` (QuickJS 运行时) + Cloudflare DNS API,做家用宽带的 DDNS。

## 主推架构(单 cron,worker 直接 ad-hoc 派任务)

```
   ┌────────────────────── NodeGet 平台 ──────────────────────┐
   │                                                          │
   │  Server cron "ddns-cf-sync" (每 5 分钟)                  │
   │    └─→ 触发 js-worker.onCron({})                          │
   │           │                                              │
   │           │ for each mapping in env.MAPPINGS:            │
   │           ▼                                              │
   │  globalThis.nodeget("task_create_task_blocking", {       │
   │    target_uuid: m.agent_uuid,                            │
   │    task_type:   { ip: null },                            │
   │    timeout_ms:  10000                                    │
   │  })  ──→ 下发到 agent ──→ agent 探测公网 IP ──→ 同步返回   │
   │           │                                              │
   │           ├─→ KV 对比 last_ip,变了走下一步                │
   │           └─→ fetch("api.cloudflare.com/.../PATCH")      │
   │                                                          │
   └──────────────────────────────────────────────────────────┘

家里机器:只装 nodeget agent,完全零本地配置。
NodeGet 平台:env.MAPPINGS 里直接放 agent_uuid + 域名,1 条 server cron 搞定。
```

## 触发模式速览

| 模式 | IP 来源 | 配置数 | 用途 |
|---|---|---|---|
| **Blocking(主推)** | onCron 内 `task_create_task_blocking` ad-hoc 派任务,同步等结果 | env.MAPPINGS + 1 条 server cron | 推荐默认 |
| **Cron pull(备选)** | onCron 读 `crontab-result_query` 拿最近一条 agent ip cron 的成功结果 | env.MAPPINGS(用 cron_name_fetch_ip)+ N 条 agent cron + 1 条 server cron | agent 网络不稳/blocking 经常超时;或想用 NodeGet 控制台直观看 ip 任务历史 |
| **Push(备选)** | onRoute 收 agent `http_request` 任务的 POST,看 `NG-Connecting-IP` | 1 条 agent cron(http_request 类型)| 不想让 worker 主动 ping agent 的场景 |
| **sh + systemd(末位备选)** | 家里 systemd timer 跑 sh 脚本查 ipify,显式塞 body.ip POST | 家里 systemd 单元 + worker 路由 | 装不了 nodeget agent 的设备 |

Blocking 模式下 worker 自动检测 agent 是否有 `cron_name_fetch_ip` 兜底 — blocking task 失败时会回退到 cron pull,无需手动切换。

## 为什么是这个架构

NodeGet 的 `js-worker` 是 **QuickJS** 运行时(不是 Node、不是 Cloudflare Workers),代码经 esbuild 打包成单文件 ESM 后通过 `js-worker_create` JSON-RPC 上传([architecture](https://nodeget.com/guide/js-worker/architecture.html) / [coding-guide](https://nodeget.com/guide/js-worker/coding-guide.html))。Worker 入口签名:

```js
export default {
  async onRoute(request, env, ctx) { ... },   // HTTP 路由 (manual / push fallback)
  async onCron(params, env, ctx) { ... },     // 平台 cron 调度 (主流程)
  // onCall / onInlineCall 同样是 (params, env, ctx)
}
```

> `onCron` 的 `params` 来自 `crontab_create` 注册 cron 时填的 `cron_type.server.js_worker[1]` 对象。本 worker 支持的 override:
> - `{}` — 遍历所有 env.MAPPINGS 各跑一次同步(默认)
> - `{ "only": "home" }` 或 `{ "only": ["home","nas"] }` — 只同步指定 mapping
> - `{ "force": true }` — 跳过 KV 未变短路,强制重新 PATCH CF
> - `{ "mappings": [...] }` — **完全替换 env.MAPPINGS**,只用 params 里的这套(替换语义,非合并)
> - 可任意组合

**核心物理约束**:worker 跑在 NodeGet 机房,`fetch()` 出去看到的是机房出口 IP,**不是你家宽带 IP**。因此 worker 不能自己"探测自己的 IP",IP 必须来自家里的 agent。NodeGet 给了四种把 agent IP 喂给 worker 的方式(按推荐度排序):

1. **Blocking task(主推)**:worker 在 onCron 里调 `task_create_task_blocking` 给 agent uuid 派 `ip` 任务,**同步等结果**。0 agent cron,1 server cron。
2. **Cron pull**:agent cron 定时跑 `ip` 任务把结果落 `crontab_result`,worker 用 `crontab-result_query` 拉最近一条。N agent cron + 1 server cron。
3. **Push**:agent cron 跑 `http_request` 主动 POST 给 worker,worker 看 `NG-Connecting-IP` 拿 source IP(文档警告反代后可能 `127.0.0.1`)。
4. **sh + systemd**:家里机器直接跑 sh 脚本查公网 IP 后 POST(给装不了 nodeget agent 的设备)。

主推 blocking task 因为:**配置最少**(env 直接放 agent uuid 不需要中间 cron name);**失败语义正确**(agent 离线就报错不会拿到旧 IP 写垃圾);**无信任假设**(不依赖任何 IP header)。Cron pull 保留为 fallback — 当 blocking 失败且 mapping 配了 `cron_name_fetch_ip`,worker 自动回退。

## 目录结构

```
.
├── package.json          # pnpm,只有 esbuild 一个 devDep
├── build.mjs             # esbuild 打包脚本 (format=esm, target=es2022)
├── .env.example          # worker env 模板 (注入到 NodeGet 的 env 字段)
├── src/
│   ├── index.js          # onRoute + onCron (MAPPINGS 模型 + blocking/pull 双路径)
│   ├── nodeget.js        # task_create_task_blocking + crontab-result_query 封装 + ip 结果解析
│   ├── cloudflare.js     # CF API 封装 (lookup / patch DNS record)
│   ├── kv.js             # nodeget KV via globalThis.nodeget JSON-RPC
│   └── ip.js             # IPv4/IPv6 校验 + 路由可达性过滤
├── agent/
│   ├── nodeget-cron.example.json       # 主推:单 server cron 模板(blocking 模式,不需要 agent cron)
│   ├── nodeget-cron-pull.example.json  # 备选:N agent cron + 1 server cron 模板(cron pull 模式)
│   ├── ddns-agent.sh                   # 末位备选:POSIX sh agent
│   ├── ddns-agent.service / .timer     # 末位备选:systemd 单元
│   ├── config.example                  # 末位备选:/etc/ddns-agent/config 模板
│   └── cron.example                    # 末位备选:cron 备选
└── dist/worker.js        # 编译产物 (gitignore)
```

## 部署 Worker

### 1. 准备 Cloudflare

1. [API Tokens](https://dash.cloudflare.com/profile/api-tokens) 建 token,权限只给 **Zone → DNS → Edit**,作用域限到目标 zone。
2. 在 CF DNS 面板**手动创建一次目标记录**(`home.example.com` A 记录,IP 随便填)。worker 只更新已有记录,不创建。
3. 记下 `Zone ID`(域名概览页右下)。

### 2. 编译 Worker

```bash
pnpm install
pnpm run build
# → dist/worker.js  (~16 KB ESM 单文件)
```

### 3. 上传到 NodeGet

通过 JSON-RPC `js-worker_create` / `js-worker_update`([crud.html](https://nodeget.com/api/js_worker/crud.html)):

- `js_script_base64`:`dist/worker.js` 的 UTF-8 base64(`pnpm run deploy:print` 直出)
- `env`:JSON object,把 `.env.example` 填好后塞进来
- 路由名:`ddns`(可选,只有走 push / 手动触发才需要)

### 4. 关键 env 字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `CF_API_TOKEN` | ✓ | Zone:DNS:Edit |
| `NODEGET_API_TOKEN` | ✓ | NodeGet 平台 API token,worker 内每个 `globalThis.nodeget(...)` RPC 调用都注入 |
| `CF_ZONE_ID` | (按需)| 默认 Zone ID;每个 mapping 都填了自己的 `zone_id` 时可省 |
| `MAPPINGS` | ✓ | JSON 数组,每项一个 (agent, record) 绑定,字段见下方;也可 cron params 携带 |
| `SHARED_SECRET` | (按需)| **仅 onRoute 需要**。纯 blocking/cron-pull 部署可省;省略后 onRoute 返回 503 http_route_disabled,其它入口正常 |
| `HEARTBEAT_HOURS` | 否(默认 24)| 多久强制重 push 一次防 CF dashboard 手动改 |
| `CF_RECORD_TTL` / `CF_RECORD_PROXIED` | 否 | 默认值(每个 mapping 可覆盖) |

**`MAPPINGS` 单元素 schema**:

```json
{
  "name": "home",                                              // 必填,KV 命名空间用
  "agent_uuid": "00000000-0000-0000-0000-aaaaaaaaaaaa",        // ★ 主推:blocking task 用
  "record_v4": "home.example.com",                             // family ∈ {v4, both} 必填
  "record_v6": "home.example.com",                             // family ∈ {v6, both} 必填
  "family": "both",                                            // v4 | v6 | both(默认 v4)

  "cron_name_fetch_ip": "ddns-fetch-home",                     // 可选 fallback:blocking 失败时降级走 cron pull
  "ip_task_timeout_ms": 10000,                                 // 可选,blocking 等待超时,默认 10s
  "zone_id": "...",                                            // 可选,跨 zone 时覆盖 CF_ZONE_ID
  "record_id_v4": "...",                                       // 可选,直接给 record_id 跳过 lookup
  "record_id_v6": "...",
  "ttl": 60,                                                   // 可选,覆盖默认
  "proxied": false                                             // 可选,覆盖默认
}
```

`agent_uuid` 和 `cron_name_fetch_ip` 至少要有一个:有 uuid 就走 blocking,有 cron name 就走 pull,两个都有则 blocking 优先、失败时自动回退到 pull。

**简化场景**(单 agent 单域名)可以不填 `MAPPINGS`,直接用 legacy 字段 `AGENT_UUID` + `CF_RECORD_NAME` + `RECORD_FAMILY`,worker 自动构造一个 name=`default` 的 mapping。

## 触发定时同步

### 主推:Blocking(一条 server cron)

前提:家里机器装好 [NodeGet Agent](https://nodeget.com/guide/install/install-script.html),`/etc/nodeget-agent.conf` 配好 `ws_url` / `name` / `token`,在 `allow_task_type` 里允许 `ip` 类型(默认就允许)。

NodeGet cron 表达式 **6 段**:`秒 分 时 日 月 周`。注册一条 server cron 即可:

```json
{
  "method": "crontab_create",
  "params": {
    "token": "<NodeGet API token>",
    "name": "ddns-cf-sync",
    "cron_expression": "0 */5 * * * *",
    "cron_type": {
      "server": {
        "js_worker": ["<worker name>", {}]
      }
    }
  }
}
```

worker `env.MAPPINGS` 里写好 `agent_uuid` + `record_v4/v6` 即可。每次 cron 触发,worker 在 `onCron({})` 里:

1. 遍历所有 mapping
2. 对每个 mapping 调 `task_create_task_blocking({target_uuid: m.agent_uuid, task_type: {ip:null}, timeout_ms})`
3. 同步拿到 `{ip: [v4, v6]}`
4. 跟 KV 里的 `last_ip:<mapping.name>:<type>` 比对,变了就 PATCH CF

完整模板 `agent/nodeget-cron.example.json`,含每日 force-push 兜底 + per-mapping 错频示例。

> 双栈:agent `ip` 任务一次返回 v4+v6,mapping 设 `family: "both"` 并填 `record_v4` + `record_v6`,一条 server cron 就够。

### 多 agent / 多域名(配 N 个 mapping,仍只 1 条 server cron)

主路由 + 异地 NAS 各一个 agent,各更新一个子域名 — **完全不需要 agent cron**:

**1. worker `env.MAPPINGS`**:

```json
{
  "MAPPINGS": [
    { "name": "home",
      "agent_uuid": "00000000-0000-0000-0000-aaaaaaaaaaaa",
      "record_v4": "home.example.com", "record_v6": "home.example.com",
      "family": "both" },
    { "name": "nas",
      "agent_uuid": "00000000-0000-0000-0000-bbbbbbbbbbbb",
      "record_v4": "nas.example.com",
      "family": "v4" }
  ]
}
```

**2. 注册一条 server cron 遍历所有 mapping**:

```json
{ "name": "ddns-cf-sync-all",
  "cron_expression": "0 */5 * * * *",
  "cron_type": { "server": { "js_worker": ["<worker name>", {}] } } }
```

**3. (可选)给某个 mapping 单独排程**(NAS 用 15 分钟,主站用 5 分钟),再加一条 server cron 传 `params.only`:

```json
{ "name": "ddns-cf-sync-nas",
  "cron_expression": "0 */15 * * * *",
  "cron_type": { "server": { "js_worker": ["<worker name>", { "only": "nas" }] } } }
```

完整模板在 `agent/nodeget-cron.example.json`,含每日 force-push 兜底范例。

每个 mapping 有独立 KV 命名空间(`last_ip:<mapping.name>:<type>`),互不影响。`health` 端点会列出所有 mapping 的状态。

> **执行时间预算**:worker 单次 onCron 上限 30s,blocking task 每个 mapping 最多耗 `ip_task_timeout_ms`(默认 10s)。N 个 mapping 串行最坏 N×10s,所以 mapping ≤ 2 安全,≥ 3 个建议调小 `ip_task_timeout_ms` 到 5000ms 或拆 server cron + `params.only` 错开。

### 把 MAPPINGS 整个塞进 cron params(替代 env.MAPPINGS)

可以。cron `js_worker[1]` 里直接放 `mappings` 数组,**完全替换** env.MAPPINGS(替换语义,非合并)。同时支持小写 `mappings` 和大写 `MAPPINGS`,二者等价。

```json
"cron_type": {
  "server": {
    "js_worker": ["<worker name>", {
      "mappings": [
        { "name": "tenant-a", "agent_uuid": "...", "record_v4": "a.example.com", "family": "v4" },
        { "name": "tenant-b", "agent_uuid": "...", "record_v4": "b.example.com", "family": "v4" }
      ],
      "force": false
    }]
  }
}
```

**适用场景**:

- 同一个 worker 服务多套相互独立的配置(每条 cron 一套 MAPPINGS,互不影响)
- 临时灰度一组新 mapping(加一条 cron 即可,不动 env)
- 多租户/多项目共用一个 worker 实例

**红线**:

- ❌ `CF_API_TOKEN` 和 `SHARED_SECRET` **绝对不能放进 params** — cron 历史 payload 会进 `crontab_result` 表,token 入历史日志等于泄漏
- ✅ agent uuid / record name / zone_id / record_id 入历史无问题(本来都是控制台可见或公网 DNS)
- ✅ env.MAPPINGS 仍可保留作为"默认 cron 的兜底" — 没有 `params.mappings` 的 cron 会用它

### 备选 A:Cron pull(N 条 agent cron + 1 条 server cron)

只在 blocking task 不适合时用:**agent 跟 nodeget server 之间网络抖动严重导致 blocking 经常超时**,或**单 server cron 内累计 timeout 容易碰到 30s worker 上限**。

每台 agent 注册一条 ip cron(name 不同),worker `MAPPINGS[].cron_name_fetch_ip` 关联到 cron name。worker `onCron` 通过 `crontab-result_query` 拿最近一条成功结果。完整模板:`agent/nodeget-cron-pull.example.json`。

注意:cron pull 模式下 `MAPPINGS` 里**也可以同时填 `agent_uuid` 和 `cron_name_fetch_ip`** — worker 先试 blocking,失败再回退 cron。这是最稳健的混合配置。

### 备选 B:Push(单条 cron,agent 主动 POST)

只有这些场景才用:
- 不想注册 server cron(只想用 NodeGet 控制台 UI 配 agent cron)
- 想用 NodeGet 控制台直接看到 http_request 的响应 body 调试

Agent 装好后注册一条 cron,task 是 `http_request` 直接调 worker URL(payload 见 `agent/nodeget-cron.example.json`):

```json
"task": {
  "http_request": {
    "url": "https://<nodeget>/nodeget/worker-route/ddns",
    "method": "POST",
    "headers": {
      "Authorization": "Bearer <SHARED_SECRET>",
      "Content-Type": "application/json"
    },
    "body": "{}"
  }
}
```

worker 收到空 body 时,如果**所有 mapping 都没设 `cron_name_fetch_ip`**(纯 push 部署),会用 `NG-Connecting-IP` header 当 source IP。**部署前必须实测** NG-Connecting-IP 在你的 NodeGet 部署里是不是真实公网 IP(见下文)。混合部署(部分 mapping 有 cron 拉、部分没有)时,空 body 走 pull,显式 body.ip 走 push。

### 末位备选 C:sh + systemd timer / cron

只在以下两种场景:
- 家里设备装不了 NodeGet agent(老 OpenWrt、嵌入式 NAS、不想多挂常驻进程)
- `NG-Connecting-IP` 在你的部署形态下被反代污染,且你又不想用 pull 模式(罕见)

```bash
# Linux + systemd
sudo install -m 755 agent/ddns-agent.sh /usr/local/bin/ddns-agent.sh
sudo install -d -m 700 /etc/ddns-agent
sudo install -m 600 agent/config.example /etc/ddns-agent/config
sudo $EDITOR /etc/ddns-agent/config   # 填 WORKER_URL 和 SHARED_SECRET
sudo install -m 644 agent/ddns-agent.service /etc/systemd/system/
sudo install -m 644 agent/ddns-agent.timer   /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now ddns-agent.timer

# 验证
./agent/ddns-agent.sh --dry-run --verbose
./agent/ddns-agent.sh --force --verbose
```

无 systemd 的环境用 cron:`*/5 * * * * /path/to/agent/ddns-agent.sh`。

## NG-Connecting-IP 实测(仅 push 模式需要)

文档警告这个 header 在反代后会变成 `127.0.0.1`。**走 pull 模式可以跳过这一节**。如果走 push:

```bash
curl -sS -X POST https://<nodeget>/nodeget/worker-route/ddns \
  -H "Authorization: Bearer $SECRET" \
  -H "Content-Type: application/json" \
  -d '{}'
# 看响应里 source 字段
# 走通且 CF DNS 被正确写入 → 可信
# 返回 ip_not_routable 或 CF 写入了垃圾 IP → header 被反代污染,改用 pull
```

worker 已经把 `127.0.0.1`、`::1`、`169.254/16`、链路本地等过滤掉(`src/ip.js` 的 `isRoutable`)。

## API 速查

### `POST /nodeget/worker-route/<route>`

需要 `Authorization: Bearer $SHARED_SECRET`。Body 行为分支:

| body | 行为 |
|---|---|
| `{}` | 跑一次 pull,遍历所有 mapping(同 `onCron({})`) |
| `{"only":"nas"}` 或 `{"only":["home","nas"]}` | 只跑指定 mapping |
| `{"force":true}` | 全部 mapping force 重推 |
| `{"only":"nas","force":true}` | 组合 |
| `{"ip":"1.2.3.4"}` | 显式 push 该 IP 到第一个 mapping(或用 `"mapping":"name"` 指定)|
| `{"mapping":"nas","ip":"1.2.3.4","type":"A","force":true}` | 显式 push 某个 mapping(sh agent / 手动场景)|
| 所有 mapping 都没设 `cron_name_fetch_ip` + `TRUST_PEER_IP_HEADER=true` + 空 body | 用 NG-Connecting-IP push 第一个 mapping |

### `GET /nodeget/worker-route/<route>/health`

无鉴权,返回 KV 状态:`v4` / `v6` 各自的 `last_ip` / `last_update_ts` / `record_id_cached`,以及当前配置。

## 安全考虑

- **Pull 模式不在网络上传 token**:agent 和 worker 都在 NodeGet 内部跑,流量不出 NodeGet。
- **Push 模式**:`SHARED_SECRET` 用 `openssl rand -hex 32` 生,worker constant-time 比较。
- **CF token 最小权限**:Zone:DNS:Edit,作用域限定到目标 zone。
- **DNS record 必须预先存在**:worker 不创建,只 PATCH,降低误配置风险。
- **不路由的 IP 一律拒**:`127.0.0.1` / `::1` / `0.0.0.0` / `169.254.*` / `fe80::*` 返回 400。

## 故障排查

| 现象 | 排查 |
|---|---|
| `missing_env` + `MAPPINGS` | env 里没设 `MAPPINGS` 数组,也没用 legacy `CRON_NAME_FETCH_IP + CF_RECORD_NAME` |
| `missing_mapping_fields` | 某个 mapping 里 `cron_name_fetch_ip` / `record_v4|v6` / `zone_id` 缺字段;响应里 `missing` 字段列出来 |
| `no_mapping_matched` | onCron `params.only` 写的名字在 `MAPPINGS` 里找不到 |
| `no_ip_from_agent` + source=`task_blocking_failed` | agent 离线 / blocking task 在 `ip_task_timeout_ms` 内没回应 / agent 未开启 `ip` 任务类型(检查 `/etc/nodeget-agent.conf` 的 `allow_task_type`)|
| `no_ip_from_agent` + source=`no_result` | cron pull 模式且 agent ip cron 还没跑过一次成功;先去 NodeGet 控制台看 agent cron 的 `crontab-result_query` |
| 拿到的 IP 跟预期不符 | agent 配置 `ip_provider` 选错(ipinfo vs cloudflare);或家里多网卡 agent 跑在错的出口上 |
| `unauthorized`(仅 push) | `SHARED_SECRET` 不一致 |
| `ip_not_routable`(仅 push)| `NG-Connecting-IP` 被反代污染,改 pull 模式 |
| `cloudflare_api_error` + 401 | CF token 权限不足/过期 |
| `cloudflare_api_error` + 404 | `CF_ZONE_ID` 错,或目标 DNS record 没预先建好 |
| build 报 esbuild postinstall 没跑 | pnpm 10 默认不跑包脚本,已用 `onlyBuiltDependencies` 解决,仍有问题 `pnpm rebuild esbuild` |
| QuickJS 跑代码报 `import` | 没用 esbuild 打包就直接传 `src/index.js`;务必传 `dist/worker.js` |

## 设计选择说明

- **为什么 blocking task 优于 cron pull / push**:配置最少(0 agent cron,env 直接放 agent uuid);失败语义正确(agent 离线 → blocking 失败而非读到 crontab_result 里上一次成功的旧 IP);不依赖任何 IP header 信任假设;agent uuid 直接出现在 mapping 里,运维直观。代价是要看 30s worker 执行上限和 agent 实时在线性。
- **为什么不用 Cloudflare Workers**:用户要 NodeGet。CF Workers 的 DDNS 方案不同(`request.cf.colo` / `cf-connecting-ip`,跑在 CF 边缘)。
- **为什么 worker 不自己探测 IP**:worker 跑在 NodeGet 机房,`fetch('https://api.ipify.org')` 拿到的是机房出口 IP,跟用户家无关。
- **为什么 KV 缓存 last_ip**:CF API 全局限速 1200/5min,DDNS 5 分钟一次不缓存浪费配额、且 IP 不变时 NodeGet → CF 链路上多一次毛刺也无谓。
- **为什么不让 worker 创建 DNS record**:防止 token 泄漏后被人在 zone 里写垃圾;减少 worker 代码要处理的 CF API 错误路径。
- **为什么不用 Agent task 链式(`ip` 结果直接塞到 `http_request` body)**:NodeGet Agent task **不支持任务间变量插值/链式**。这个限制曾经是 cron pull 模式存在的根本原因 — 现在 blocking task 直接绕过了它,worker 在 server 端控制取 IP 和调 CF 的整个流程。

## 致谢

IP 探测 pattern(`http_request` 到 `https://ip.nodeget.com/json?filter=ip` + `ipv4/6 auto`)借鉴自 NodeGet 平台内置的 `ip-location-update` worker 源码 — 不传 token 会静默失败、KV namespace 必须显式 `kv_create` 等关键约束都是从那份源码摸出来的。新写 NodeGet worker 强烈建议先精读它。

## License

[MIT](LICENSE) © 2026 astring0

## 参考

- NodeGet js-worker 架构:<https://nodeget.com/guide/js-worker/architecture.html>
- NodeGet js-worker API:<https://nodeget.com/api/js_worker/>
- NodeGet 代码规范(esbuild 配置):<https://nodeget.com/guide/js-worker/coding-guide.html>
- NodeGet KV:<https://nodeget.com/api/kv/>
- NodeGet crontab CRUD:<https://nodeget.com/api/crontab/crud.html>
- NodeGet task 类型:<https://nodeget.com/api/task/index.html>
- NodeGet crontab_result:<https://nodeget.com/api/crontab_result/crud.html>
- NodeGet task CRUD(含 `task_create_task_blocking`):<https://nodeget.com/api/task/crud.html>
- NodeGet Agent 配置:<https://nodeget.com/guide/config/agent>
- Cloudflare DNS API:<https://developers.cloudflare.com/api/operations/dns-records-for-a-zone-patch-dns-record>
