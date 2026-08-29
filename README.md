# ST-ClaudeCacheGateway-Continued 使用指南

**ST-ClaudeCacheGateway-Continued** 是基于原项目 [ST-ClaudeCacheGateway](https://github.com/shanye5593/ST-ClaudeCacheGateway) 的继续开发版。它是一个面向 SillyTavern / 酒馆的本地 Claude 缓存网关，接收 OpenAI-compatible 或 Anthropic native 请求，并在发送给上游前处理 `[[CACHE_BREAK]]`、Claude prompt cache、Prefix 锁定、渠道 Profile 和高级参数。

本项目新增的断点保留和轮换策略，目标是在长上下文持续增长时减少稳定缓存边界的无谓移动，从而更容易提高缓存命中率；实际命中情况仍取决于模型、供应商以及缓存点之前的内容是否完全稳定。

默认监听：

```text
http://127.0.0.1:8788
```

酒馆 / 客户端推荐填写：

```text
Base URL: http://127.0.0.1:8788/v1
API Key: 你的上游供应商 API Key
```

> 不要把 API Key 写进渠道 Profile 或高级配置。Key 应放在客户端请求头，或仅在可信本机环境里通过 `UPSTREAM_API_KEY` 环境变量传入。

## 功能概览

- 接收 OpenAI-compatible `POST /v1/chat/completions` 请求。
- 默认使用 Pioneer 的 OpenAI-compatible 上游格式，也可切换为 Anthropic native `/v1/messages`。
- 支持 `[[CACHE_BREAK]]` 手动缓存标记，以及 SYSTEM 末尾 / 每个 ASSISTANT 消息后的自动断点预处理。
- 支持 Claude `cache_control` 注入，最多 4 个缓存断点。
- 支持固定头缓存点，以及单锚点 / 滚动锚点保留策略。
- 支持 1 小时缓存 TTL 或供应商默认缓存窗口。
- 支持首页“缓存转译”总开关。
- 支持 Prefix 锁定，降低前缀漂移导致的缓存不命中。
- 支持多渠道 Profile：Pioneer、OpenRouter、Anthropic、Vertex、Bedrock、自定义渠道。
- 支持 OpenRouter 供应商锁定和自定义供应商名。
- 支持高级配置：包含 / 排除主体参数，包含 / 排除请求头。
- 支持请求诊断；诊断开关会持久化，捕获的请求正文只保存在内存中。
- 默认只绑定 `127.0.0.1`，适合本机使用。

## 相对原项目优势

- **固定头缓存点**：可始终保留最前面的 0–4 个候选断点，避免候选持续增长时稳定头部断点被上游四点上限挤掉。
- **稳定 Seed（初始锚点）**：新上下文先确定本次真正发送的最多四点，再把排除固定头后的第一个 marker 候选作为 Seed；后缀增长时继续复用该稳定边界，而不是把首次最后一个尾点固定下来。
- **渐进滚动锚点**：达到配置的逻辑内容块间隔后逐次晋升新锚点，并用新旧锚点短暂重叠完成轮换；每次成功请求最多晋升一个，失败请求不会推进状态。
- **自动生成、选择与清理断点**：可选地在最终 SYSTEM 末尾和每个 ASSISTANT 消息后预生成 marker，无需逐条手写；随后统一规范化 inline、独立 marker、content array 和 Anthropic system 候选，自动去重、删除未选 marker 与空消息，并在固定头、锚点、最新尾点及调用方已有控制之间分配最多四点预算。
- **三条实际请求链路**：统一处理并验证 OpenAI 入站 → OpenAI 上游、OpenAI 入站 → Anthropic 上游、Anthropic 入站 → Anthropic 上游的最终请求体。
- **更完整的诊断**：可查看候选路径、入选原因、上下文短哈希、锚点动作或暂停原因、最终上游请求体以及上游返回的缓存 token 用量，便于定位断点选择和缓存未命中问题。

## 安装与启动

需要 Node.js 18 或更新版本。

### Windows

下载并解压本项目后，进入 `ST-ClaudeCacheGateway-Continued` 文件夹。可以双击：

```text
start-gateway.bat
```

也可以在终端运行：

```powershell
cd ST-ClaudeCacheGateway-Continued
npm start
```

### macOS / Linux

下载并解压本项目后进入 `ST-ClaudeCacheGateway-Continued`。`.bat` 只适用于 Windows，macOS / Linux 不要运行它。

```sh
cd ST-ClaudeCacheGateway-Continued
chmod +x start-gateway.sh
./start-gateway.sh
```

也可以直接运行：

```sh
npm start
```

### Termux / Android

先下载并解压本项目，再进入 `ST-ClaudeCacheGateway-Continued`。由于本文档尚未提供本项目的仓库地址，这里只说明本地解压后的启动步骤。

```sh
pkg update
pkg install nodejs-lts
cd ST-ClaudeCacheGateway-Continued
npm start
```

如果 SillyTavern 和网关在同一台 Android / Termux 设备上：

```text
Base URL: http://127.0.0.1:8788/v1
```

## 控制台

启动后打开：

```text
http://127.0.0.1:8788/console
```

控制台包含：

- 网关概览：当前渠道、缓存转译、上游格式、TTL、Prefix 状态。
- 渠道配置：切换 / 保存渠道 Profile。
- 缓存策略：查看缓存标记、切换 TTL、配置固定头与缓存锚点、管理 Prefix 锁定。
- 请求日志：开启或关闭请求诊断、查看最终请求体和缓存结果；开关状态会保留到下次启动，日志正文仍只存于内存。
- 高级配置：处理主体参数和请求头。

## 客户端接入

推荐在 SillyTavern / 酒馆里使用 OpenAI-compatible / Chat Completion 接入方式。

```text
Base URL: http://127.0.0.1:8788/v1
API Key: 你的上游供应商 API Key
Model: 你的上游模型名
```

也可以使用 Claude / Anthropic-compatible 原生入站：

```text
POST http://127.0.0.1:8788/v1/messages
POST http://127.0.0.1:8788/v1/messages/count_tokens
```

酒馆里选择的是“入站格式”，决定客户端用哪种协议发给本地网关；控制台里的“上游格式”决定网关再用哪种协议转发给供应商。两者可以不同，例如：

```text
酒馆 OpenAI-compatible 请求 -> 本地网关 -> OpenAI-compatible 或 Anthropic native 上游
```

如果使用 Claude 原生入站，请把当前渠道的上游格式保持为 Anthropic native。

## 缓存标记 `[[CACHE_BREAK]]`

把下面的标记放在大段稳定内容之后：

```text
[[CACHE_BREAK]]
```

网关会在发送上游前移除这个标记，并在对应位置注入 Claude prompt cache：

```json
{
  "cache_control": {
    "type": "ephemeral",
    "ttl": "1h"
  }
}
```

适合放在缓存标记之前：

- 系统提示词
- 角色卡
- 蓝灯世界书 / 蓝灯 World Info
- 长篇固定设定
- 固定规则和格式要求

适合放在缓存标记之后：

- 绿灯世界书 / 绿灯 World Info
- 最近聊天记录
- 当前用户输入
- 短期记忆
- 会频繁变化的上下文

简单理解：蓝灯世界书放在 `[[CACHE_BREAK]]` 前面，绿灯世界书放在 `[[CACHE_BREAK]]` 后面。

### 自动生成缓存断点

在控制台“缓存策略 → 缓存标记与 TTL”中可开启“自动生成缓存断点”。此开关默认关闭；开启后，网关会在渠道请求体参数合并完成后进行预处理：

- OpenAI-compatible 最后一个 `system` 消息的末尾生成一个 marker。
- Anthropic native 顶层 `system` 的末尾生成一个 marker。
- 每个 `assistant` 消息的末尾生成一个 marker。
- 已经位于末尾的 marker 不会重复生成；空内容或没有可落点内容块的消息会跳过并写入诊断。

自动生成只负责提供候选边界。之后仍执行原有的去重、固定头、锚点、最新尾点和四点预算策略；所有 marker 在发送上游前都会被移除。关闭“缓存转译”时不会生成 marker，以免原始标记被发送给上游。

切换自动生成开关会清空已学习的锚点和 Prefix Lock 内容，下一次成功请求会按新的候选边界重新学习。

Claude 每个请求最多支持 4 个缓存断点。调用方已有的 `cache_control` 与网关注入的断点共用这 4 个位置；所有未选中的 `[[CACHE_BREAK]]` 仍会被移除，不会原样发给上游。

默认的固定头数量为 `0`，锚点模式为“关闭”。在这个兼容模式下，网关仍按旧版行为保留最前面的 4 个候选断点。

## 固定头缓存点与渐进轮换锚点

当提示词不断增长、候选断点超过 4 个时，单纯保留最前或最后 4 点都可能让一个原本稳定的缓存边界在相邻请求间移动。“缓存策略 → 断点保留策略”提供两类控制：

- **固定头缓存点**：填写 `0`–`4`。例如设为 `1`，最前面的第一个候选断点始终保留，后面的可用位置再分配给锚点和最新尾点。
- **单锚点**：新上下文会先按四点预算选出固定头和最新尾点，再把“最终已选断点中排除固定头后的第一个 marker 候选”学为锚点。只要锚点之前的完整前缀不变，后续请求都会继续保留它；前缀变化、重启或手动“清空锚点并重学”会触发重新学习。
- **滚动锚点**：先按单锚点学习，再按设定的非空逻辑内容块间隔晋升新锚点。晋升成功时保留新旧重叠，随后一次请求再淘汰最老锚点，避免长上下文突然失去已有缓存前缀。

例如固定头为 1、滚动间隔为 3 时，一组稳定的轮换会按成功请求渐进变化：

```text
A / F / I / J
A / F（待淘汰） / I / L
A / I / L / M
```

第二步让 F、I、L 临时重叠；只有该请求成功后，下一次才移除 F，因此不会在同一次调用中突然跨过已有缓存锚点。

启用任一新策略后，断点按以下优先级选择：

1. 最前面的固定头候选点。
2. 活动、晋升和待淘汰锚点。
3. 从后向前选择最新普通候选点补足预算。

固定头、锚点、普通尾点和调用方已有的 `cache_control` 总计不能超过 4 点。例如固定头为 1，A 是固定头、F 是单锚点，在长上下文里剩余两个位置应给最新尾点 O、P，最终是：

```text
A / F / O / P
```

首次学习时也是同一规则。例如固定头为 1、当前最终入选四点为 `A / E / F / G`，初始锚点是 E，而不是最后的 G；随着上下文增长，E 会先保持稳定，滚动模式再从 E 开始计算晋升间隔。

不会再加入第五个 N 点。如果固定头设为 `4`，锚点会显示“无可用配额”；减少固定头数量后才能学习或轮换。若已有 `cache_control` 使固定头保证无法满足，请求会返回明确的预算冲突错误；若只是不足以完成滚动锚点的新旧重叠，网关会保留当前锚点并暂停本次轮换。

滚动模式以成功请求为提交边界：上游非 2xx、网络错误、请求取消和 `/count_tokens` 都不会学习、晋升或淘汰锚点。不同渠道、上游协议、模型和 TTL 的学习上下文彼此隔离，内存中最多保留 32 个最近使用的上下文。

策略设置会持久化到 `gateway-settings.json`。旧配置会在运行时迁移到 `schemaVersion: 4`：固定头、锚点和滚动间隔缺省为 `0 / off / 3`，自动生成断点与请求诊断缺省为关闭。已学习的锚点、轮换进度、上下文索引和诊断正文只保存在内存里；锚点在重启后重新学习，诊断开关则保持上次设置。不需要也没有新增对应的环境变量。

> 缓存锚点与 Prefix Lock 互斥，采用“最后启用者生效”：启用单锚点或滚动锚点会关闭并清空 Prefix Lock；启用 Prefix Lock 会把锚点模式切回“关闭”并清空已学习锚点。固定头策略本身可以继续保留。

## Prefix 锁定 / 强制锁定

Prefix 锁定是给“缓存点前面的内容不够稳定”准备的保护功能。它不是必须开启的功能；如果你的缓存点前内容本来就稳定，可以先不开。

它解决的问题是“前缀漂移”：有些酒馆配置、插件、世界书、正则、数据库填表内容或动态注入内容，可能会在 `[[CACHE_BREAK]]` 之前插入变化内容。只要缓存点之前有细微变化，Claude 看到的稳定前缀就不再完全一致，缓存命中率就会下降。

开启后：

1. 第一个带缓存点的最终请求会教会网关“稳定前缀”。
2. 网关会记录从请求开头到第一个 `cache_control` 为止的内容。
3. 后续请求会丢弃当前请求里的缓存点前缀，强制替换为已经学习到的稳定前缀。
4. 缓存点之后的内容仍使用当前请求的新内容，例如近期聊天、当前输入、绿灯世界书等。

这是一种替换，不是追加，所以不会把世界书、系统提示词或角色卡重复拼接。

适合开启 Prefix 锁定的情况：

- 你已经正确放置了 `[[CACHE_BREAK]]`，但缓存仍然不稳定。
- 怀疑世界书、正则、插件、数据库填表在缓存点前产生了动态变化。
- 想临时验证缓存不命中是否由前缀漂移造成。

不建议长期无脑开启的情况：

- 你经常切换角色卡、世界书或预设。
- 你希望缓存点之前的内容每轮都能自然更新。
- 你还没有确认哪些内容应该放在缓存点前、哪些应该放在缓存点后。

更换以下内容后，请清空并重新学习 Prefix：

- 角色卡
- 世界书
- 预设
- 主要系统提示词
- 任何应该位于缓存标记之前的内容

如果关闭首页“缓存转译”，Prefix 锁定也会跳过，不会参与请求处理。

Prefix Lock 与缓存锚点不能同时启用。启用 Prefix Lock 会关闭锚点模式并清空锚点；之后若启用单锚点或滚动锚点，网关会反过来关闭并清空 Prefix Lock。

## 缓存转译总开关

首页的“缓存转译”是总开关。

开启时：

- 网关识别 `[[CACHE_BREAK]]`。
- 网关注入 `cache_control`。
- Prefix 锁定可以参与请求处理。

关闭时：

- 网关不处理 `[[CACHE_BREAK]]`。
- 网关不注入 `cache_control`。
- Prefix 锁定会跳过。
- 高级配置仍然生效。
- 渠道 Profile 和上游格式转换仍然生效。

如果你只是想临时绕过缓存处理，但仍想保留渠道、高级参数、请求头规则，可以关闭“缓存转译”。

## 缓存 TTL

缓存策略页可以切换 TTL：

- `1 小时`：发送 Claude 原生 1 小时缓存窗口：`ttl: "1h"`。
- `默认窗口`：不发送 `ttl`，交给上游供应商默认 ephemeral 缓存窗口处理。

如果上游或模型不支持 1 小时 TTL，请切回默认窗口。

也可以用环境变量启动：

```sh
CACHE_TTL=default npm start
```

## 渠道 Profile

渠道 Profile 会持久化到本地 `gateway-settings.json`，保存：

- 渠道名称
- Base URL
- 上游格式
- 高级主体参数
- 高级请求头规则

不会保存 API Key。

默认渠道：

- Pioneer：默认自定义渠道，默认连接 `https://api.pioneer.ai`，上游格式默认 OpenAI-compatible。
- OpenRouter：内置模板，默认 `https://openrouter.ai/api/v1`，上游格式通常用 OpenAI-compatible。
- Anthropic：内置模板。
- Google Vertex AI：内置模板。
- Amazon Bedrock：内置模板。
- 自定义渠道：可以新建、重命名、保存、删除。

注意：Vertex 和 Bedrock 卡片目前是 Profile 模板，不包含 Google Auth 或 AWS SigV4 签名。如果你需要真实云厂商鉴权，建议先通过兼容供应商、自定义代理或后续专门实现的鉴权层接入。

## OpenRouter 供应商锁定

OpenRouter 渠道支持“锁定供应商”。它会把 provider 参数写入请求体，例如锁定 Amazon Bedrock：

```json
{
  "provider": {
    "order": ["Amazon Bedrock"],
    "allow_fallbacks": false
  }
}
```

控制台里可以：

- 选择常见供应商。
- 选择“自定义”后输入任意 OpenRouter 支持的供应商名。
- 关闭锁定，恢复不指定 provider。

如果 OpenRouter 没有在响应体或响应头返回实际供应商，诊断页可能显示 unknown；这不代表锁定没发送。以最终请求体里的 provider 字段为准。

## 高级配置

高级配置按当前渠道 Profile 保存。

### 包含主体参数

填写 JSON 对象，网关会把它深度合并进最终请求体。

示例：

```json
{
  "provider": {
    "order": ["Amazon Bedrock"],
    "allow_fallbacks": false
  }
}
```

这个功能同时作用于 OpenAI-compatible 和 Anthropic native 上游格式；请求体会先完成渠道参数合并，再执行缓存断点选择。请只填写目标上游协议支持的字段。

### 排除主体参数

一行一个字段路径，发送上游前删除对应字段。

示例：

```text
stream_options
metadata.trace_id
provider.allow_fallbacks
```

适合用于删除某些供应商不接受的请求体字段。

### 包含请求头

填写 JSON 对象，网关会添加或覆写非密钥请求头。

示例：

```json
{
  "HTTP-Referer": "https://example.com",
  "X-Title": "ST-ClaudeCacheGateway-Continued"
}
```

不允许保存密钥或协议敏感 header，例如：

- `authorization`
- `x-api-key`
- `cookie`
- `set-cookie`
- `host`
- `content-length`
- 包含 `token` / `secret` / `password` 的 header

### 排除请求头

一行一个 header 名，发送上游前删除。

示例：

```text
x-real-ip
x-forwarded-for
```

这可以用于删除某些代理、客户端或平台自动附带但你不想发给上游的 header。

## 请求诊断

请求诊断初始默认关闭。你在控制台修改开关后，该开关会保存到本地 `gateway-settings.json`，重启应用仍会沿用上次状态；捕获到的请求记录和正文不会写入设置文件，只保存在当前进程的内存中，重启后清空。

开启后，网关会在内存里保存最近请求记录，用于查看：

- 最终发给上游的请求体
- 请求头摘要
- 缓存断点位置
- 最终入选的每个断点及其选择原因（固定头、活动 / 晋升 / 待淘汰锚点、最新尾点或调用方已有控制）
- Prefix hash / suffix hash
- 上游状态码
- 上游返回的缓存 read / creation token 用量

诊断记录可能包含私密提示词、聊天内容、世界书内容和最终上游请求体。不要公开分享导出的诊断 JSON。需要特别注意：虽然旧记录会在重启后清空，但诊断开关本身会保持开启，应用重启后可能继续捕获新的请求；排查完成后请主动关闭诊断并清空记录。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | 监听地址。默认仅本机访问。 |
| `PORT` | `8788` | 监听端口。 |
| `UPSTREAM_BASE_URL` | `https://api.pioneer.ai` | 启动时的上游地址默认 / 覆盖。 |
| `UPSTREAM_MODE` | `openai` | 上游格式：`anthropic` 或 `openai`。 |
| `UPSTREAM_EXTRA_JSON` | `{}` | 启动时包含主体参数。 |
| `UPSTREAM_EXCLUDE_PATHS` | 空 | 启动时排除主体参数，逗号或换行分隔。 |
| `UPSTREAM_HEADERS` | `{}` | 启动时包含请求头。不要写密钥。 |
| `UPSTREAM_EXCLUDE_HEADERS` | 空 | 启动时排除请求头，逗号或换行分隔。 |
| `UPSTREAM_API_KEY` | 空 | 当客户端没有传 API Key 时的 fallback。仅建议私有环境使用。 |
| `CACHE_TTL` | `1h` | `1h` 或 `default`。 |
| `CACHE_TRANSLATION_ENABLED` | `true` | 是否启用缓存转译。 |

示例：

```sh
UPSTREAM_BASE_URL=https://api.pioneer.ai PORT=8788 npm start
```

OpenAI-compatible 上游：

```sh
UPSTREAM_MODE=openai npm start
```

关闭缓存转译：

```sh
CACHE_TRANSLATION_ENABLED=false npm start
```

PowerShell 示例：

```powershell
$env:UPSTREAM_BASE_URL = 'https://api.pioneer.ai'
$env:PORT = '8788'
$env:CACHE_TTL = 'default'
npm start
```

## 健康检查

```sh
curl http://127.0.0.1:8788/health
```

示例响应：

```json
{
  "ok": true,
  "host": "127.0.0.1",
  "port": 8788,
  "upstreamBaseUrl": "https://api.pioneer.ai",
  "upstreamMode": "openai",
  "cacheTtl": "1h"
}
```

## 常见问题

### macOS 打不开 `start-gateway.bat`

`.bat` 是 Windows 批处理文件。macOS / Linux 请用：

```sh
chmod +x start-gateway.sh
./start-gateway.sh
```

或直接运行：

```sh
npm start
```

### 酒馆请求 404 或路径不对

优先把 Base URL 填完整：

```text
http://127.0.0.1:8788/v1
```

### 请求日志要一直开吗？

不建议。请求诊断只在排查问题时临时开启；开关状态会持久化，重启应用不会自动关闭。诊断结束后请关闭并清空日志。

### 缓存不命中

检查：

- 稳定内容是否都在 `[[CACHE_BREAK]]` 之前。
- 蓝灯世界书是否在 `[[CACHE_BREAK]]` 之前，绿灯世界书是否在 `[[CACHE_BREAK]]` 之后。
- 最近聊天和当前输入是否在 `[[CACHE_BREAK]]` 之后。
- 是否有世界书、正则、插件在缓存点之前插入动态内容。
- 必要时开启 Prefix 锁定测试是否是前缀漂移。
- 候选断点持续增长时，可配置固定头或滚动锚点，并在请求详情里检查每个断点的选择原因。

### 使用数据库会影响缓存吗？

使用数据库本身不影响缓存。官方渠道验证正常；如果出现数据库相关异常，通常是第三方实现或接入方式的问题。

需要注意的是：如果数据库的蓝灯条目会随着填表内容更新，它就不再是稳定前缀。此时应把全局注入位置改到缓存点后面，例如“角色后”或“系统”这类位于缓存点后的注入位置，避免它在缓存点前变化导致缓存失效。

### 上游报不支持 `ttl: 1h`

到“缓存策略”把 TTL 切换为默认窗口，或启动时使用：

```sh
CACHE_TTL=default npm start
```

### 可以把 Key 保存到 Profile 吗？

不建议，也不允许。网关会拒绝明显密钥字段。请让客户端发送 API Key，或仅在私有本机环境下使用 `UPSTREAM_API_KEY`。

## 安全注意事项

- 不要公开诊断 JSON、请求日志、聊天导出、世界书内容。
- 不要把 API Key 写进 README、Profile、高级配置或截图。
- `gateway-settings.json` 是本地运行配置，不应该提交到公开仓库。
- 默认绑定 `127.0.0.1`，建议保持仅本机访问。
- 请求诊断初始默认关闭，但一旦开启会在重启后继续保持开启；排查完成后请手动关闭并清空内存记录。
