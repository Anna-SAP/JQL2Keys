# JQL2Keys —— 基于 JQL 批量提取 L10N Bug 翻译 Key 的桌面级工具

> 一句话定位：在 LQA 阶段，给定一条 JQL 查询，自动从匹配的 Jira L10N Bug 中抽取「目标语言 → 翻译 Key 列表」的结构化结果，并可一键据此生成可直接交付给翻译团队的 Working Files Package（XTM/OPUS 接受的源文件包）。

---

## 1. 背景与立项动机

在每一轮 L10N 交付的回归（LQA）阶段，本地化团队会在 Jira 中提交大量"修复某条已上线译文"类型的 Bug。这些 Bug 通常具有以下共同特征：

- **来源分散**：分布在一个或多个 Loc Master Ticket（如 `LOC-24605`）的 linked issues 之下，数量从几十到几百不等。
- **格式松散**：受影响的 Translation Key 由报告人写在 Description 或 Comment 里，行内夹带语言段头（`es-ES`、`pt-BR` 等）；既有 Jira Wiki 标记，也有 ADF（Atlassian Document Format）。
- **目标语言不显式**：很多单语种 Bug 只在标题里以 `[DE]`、`de-DE`、`Language=German (Germany)` 等多种形态暗示目标语言。

人工处理这类 Bug 会带来三类痛点：

| 痛点 | 表现 |
|---|---|
| 取数低效 | 在 Jira UI 中翻页 + 手动复制粘贴，几百条 Bug 一遍下来要半天甚至一天。 |
| 易遗漏、易串语言 | 段头识别全靠肉眼，Comment 翻页之后很容易把 `pt-BR` 的 Key 错算到 `es-ES` 上。 |
| 下游交付脱节 | 即便整理出 Key 列表，仍需要再次手工去英文源包里捞出对应文件，按 OPUS / XTM 要求的目录结构打包。 |

**JQL2Keys** 即为消除上述链路而生：从「JQL 一键查询」到「拿到结构化 Key JSON」再到「直接产出可交付的 Working Files ZIP」全程自动化，单人即可在数分钟内闭环。

---

## 2. 工具概览

JQL2Keys 是一个**零运行时依赖（仅 Node.js 内置模块）**、**单 EXE 即可分发**的本地工具，包含两大功能模块：

### Step 1 — JQL → Translation Keys
通过 JQL 检索 Jira L10N Bug，自动解析 Description 与 Comment，输出形如：

```json
{
  "LOC-24626": {
    "es-ES": [
      "RingCentral.uns.40f7566f...callQueueManagerLoginInfo__email_html__3460__en_US",
      "RingCentral.uns.7cfe2272...callQueueManagerLoginInfo__email_html__1210__en_US"
    ],
    "pt-BR": [
      "RingCentral.uns.7cfe2272...callQueueManagerLoginInfo__email_html__1210__en_US"
    ]
  }
}
```

### Step 2 — Keys → Working Files Package
读入团队已有的英文源包 ZIP，自动按 Step 1 的 Key 抽取每条 Key 对应的源条目，并按照 OPUS / 翻译外包接受的目录结构（按语言、按 build 分目录，含 `trunk` 全局兜底等多场景）重新打包。

两步在同一个浏览器页面里串行使用，第二步以第一步的结果为输入，**Step 2 在 Step 1 没跑出 Key 时自动禁用**。

---

## 3. 架构设计

```
 ┌──────────────────────────────────────────────────────┐
 │                JQL2Keys.exe / node                    │
 │   (Node.js HTTP 服务 + 单实例守护 + 自动浏览器拉起)     │
 │                                                       │
 │   GET /                → 内嵌 SPA HTML                │
 │   GET /proxy?url=…     → 透传到 Jira（解决 CORS）      │
 │   GET /health          → 自检 + 单实例识别            │
 └──────────────────────────────────────────────────────┘
                      │
                      ▼
 ┌──────────────────────────────────────────────────────┐
 │         jira-l10n-key-extractor.html (单文件 SPA)     │
 │              Vue 3 + TailwindCSS（CDN）               │
 │                                                       │
 │   ① Jira 鉴权 / 分页拉取 / ADF & Wiki 解析            │
 │   ② 三路语言识别（标题 BCP-47 / 方括号短码 / 自定义字段）│
 │   ③ 三视图展示（Cards / JSON / By Language）          │
 │   ④ Working Files Package 生成器（前端 ZIP 处理）      │
 └──────────────────────────────────────────────────────┘
```

### 三个关键设计选择

1. **「单 EXE + 单 HTML」分发**
   通过 `pkg` 把 `JQL2Keys.js` 打包为 `JQL2Keys.exe`（`node20-win-x64`），HTML 作为 asset 内嵌；同事拿到双击即用，**无需安装 Node、无需配置代理、无需开终端**，与"Python 脚本 + README"形态相比，对非工程同事友好得多。

2. **同源 CORS Proxy 内置**
   浏览器跨域阻断是访问 Jira API 的天然障碍。`/proxy?url=...` 端点在同一进程内反向代理，附带超时（30s）、重定向折叠、白名单 header 透传，避免引入 `cors-anywhere` 这类第三方依赖。

3. **单实例守护（Single-Instance Guard）**
   每次启动先 `GET /health` 探测 `127.0.0.1:[PORT, PORT+10)` 段，若发现已有 `app:"JQL2Keys"` 在跑，则**复用现有端口、仅重新唤起浏览器**后退出；避免反复双击 EXE 形成多个僵尸进程。

---

## 4. 关键技术点

### 4.1 自适应的目标语言识别

实践中，"该 Bug 修哪几个语种"的信号源不止一个。工具按**三路并集**识别，最大化召回：

| 信号源 | 示例 | 处理方式 |
|---|---|---|
| 标题中的 BCP-47 标签 | `de-DE`、`es-419` | 正则 `\b[a-z]{2,3}-(?:[A-Z]{2,4}\|\d{3})\b` |
| 标题中的方括号短码 | `[DE]`、`[FR-CA]`、`[419]` | 查 `SHORT_CODE_TO_BCP47` 字典映射回 BCP-47 |
| 任意自定义字段值 | `Language = "German (Germany)"` | 递归扫描 `fields`，按归一化语言名表反查 |

> 当 Comment 中没有明确语言段头、却有"裸 Key"（orphan keys）时，工具会回落到上述识别出的语言列表，把 Key 一并归到这些语言名下，避免"Bug 标题写了语言、正文没写"导致漏抽。

### 4.2 兼容 Jira Wiki Markup 与 ADF 双格式

Jira Server / Data Center 多用 Wiki Markup（`{code}`、`{panel}`、`h2.` 等），Jira Cloud 已切到 ADF（JSON 树）。`extractText()` 会先识别再分发：ADF 走 `adfToText()` 递归扁平化为纯文本，Wiki Markup 走正则剥离格式定界符；下游 parser 只需面对统一的纯文本输入。

### 4.3 可配置的 Key 正则

默认按以下三档顺序兜底匹配：

1. `RingCentral.\S+`
2. `\w+\.uns\.\S+`
3. 通用形如 `a.b.c__suffix__suffix` 的多段式 Key

同时**允许用户在高级设置里粘贴自定义正则**，覆盖默认；既能稳跑常规场景，也能应对个别业务线的特殊命名。

### 4.4 Working Files Package 生成策略

读入英文源包 ZIP 后，工具会自动识别：

- 根目录、各 build 目录（如 `trunk`、`v25.x` 等）；
- 是否存在 `en-US/trunk` **全局兜底**（一旦存在，会广播给所有目标语言）；
- 各语种已有的 per-lang 子目录，避免重复或漏建。

随后按照 Step 1 的「语言 → Key」映射，从源包中**精确摘取**每条 Key 对应的条目并保留原相对路径，输出新 ZIP；同时给出 `matched / missing / outputFiles` 的统计与详细 missing 清单，便于回查。

### 4.5 Pagination 与 Comment 补抓

Jira 单次 `search` 默认 `maxResults=50`，工具内置分页直至 `total` 跑完；针对 `comment.total > 已加载长度` 的情况，会再用 `/issue/{key}/comment?startAt=…` 把缺失评论补齐，避免漏读关键译文。

---

## 5. 文件结构

| 文件 | 角色 |
|---|---|
| `JQL2Keys.js` | 一体化服务：托管 SPA + Jira 反向代理 + 单实例守护 + 自动开浏览器 |
| `jira-cors-proxy.js` | 仅代理（如想"传统两段式"开发用，可单独运行） |
| `jira-l10n-key-extractor.html` | 单文件 SPA（Vue 3 + Tailwind via CDN），全部 UI 与解析逻辑 |
| `package.json` | 含 `pkg` 配置，`npm run build` 后产出 `dist/JQL2Keys.exe` |
| `README.md` | 英文版速查 |

---

## 6. 使用步骤

### 6.1 直接使用打包版（推荐给非工程同事）

1. 双击 `JQL2Keys.exe`，浏览器会自动打开 `http://localhost:3001`。
2. 在右上"Settings"中填入 Jira Domain、鉴权方式（Server/DC 用 PAT；Cloud 用 Email + API Token）。
3. 输入 JQL（如 `issue in linkedIssues(LOC-24605) AND issuetype in (Bug)`）→ 点 **Fetch & Parse**。
4. 在三种视图（Cards / JSON / By Language）间切换检阅；可一键 Copy JSON 或 Download。
5. （可选）在 Step 2 拖入英文源包 ZIP → 点 **Generate Working Files Package** → 下载交付包。

### 6.2 开发模式

```bash
node JQL2Keys.js          # 默认 3001 端口
node JQL2Keys.js 3002     # 指定端口
```

或者沿用旧的两段式（仅当需要单独调试代理层时）：

```bash
node jira-cors-proxy.js
# 浏览器直接打开 jira-l10n-key-extractor.html
```

### 6.3 打包发布

```bash
npm run build
# 输出：dist/JQL2Keys.exe（约 ~40MB，独立可运行）
```

---

## 7. 配置项与持久化

以下字段会通过 `localStorage` 自动持久化，下次打开免重填（**Token 同样落本地**，不上传任何外部服务器）：

- Jira Domain
- Auth Mode / Email / Token
- 上次成功的 JQL
- 是否启用 CORS Proxy、Proxy URL
- 自定义 Key Pattern

---

## 8. 适用场景与边界

**适合**

- LQA 阶段从 L10N Master Ticket 下批量回收待修 Key；
- 需要按语言/按 build 重组源文件，交付给外部翻译供应商；
- 任何"已知 JQL → 想要结构化 Key/语言映射"的离线分析需求。

**不适合 / 当前未覆盖**

- 需要持续后台运行的服务化场景（本工具是会话式桌面工具）；
- 写回 Jira（仅读取，不做任何 mutation，安全无副作用）；
- 非 RingCentral 命名规范的 Key（可通过自定义正则缓解，但默认三档专为内部规范优化）。

---

## 9. 未来可拓展方向

- 把 Step 1 输出直接回灌到 Tranzor / XTM 的 import 流程，进一步打通"Bug → 修复 → 回库"闭环；
- 接入 `rc-core-products-trans-checker`，在抽 Key 后顺手做一次轻量翻译质检；
- 将 Step 2 的 Working Files 组装规则抽象为可配置模板，覆盖更多产品线的源包形态。

---

## 10. 维护信息

| 项目 | 信息 |
|---|---|
| 仓库 | `Anna-SAP/JQL2Keys` |
| 主要语言 | JavaScript（Node.js + 浏览器端 Vue 3） |
| 运行时依赖 | 无（仅 Node.js 内置模块；前端通过 CDN 引 Vue/Tailwind） |
| 打包工具 | [`pkg`](https://github.com/vercel/pkg) → `node20-win-x64` |
| Owner | Anna Su |
