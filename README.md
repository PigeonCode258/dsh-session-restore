# dsh-session-restore · 会话归档恢复

**中文** · [English](README.en.md)

[![ci](https://github.com/pigeoncode258/dsh-session-restore/actions/workflows/ci.yml/badge.svg)](https://github.com/pigeoncode258/dsh-session-restore/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22.15-brightgreen.svg)](package.json)

把 **DeepSeek Harness（dsh）导出的会话日志 ZIP** 导入回来，并把对话恢复成一台机器上真实存在的会话：
会话 ID、历史事件、子会话（subagent）、图片与附件都按原样落盘，在左侧会话列表里出现，可以打开、继续聊。

导出侧就是 Web 界面里会话头部的「下载 Session 日志」按钮（`/export` 命令或
`GET /api/session.export?sessionId=…&includeDescendants=true`）。本项目补上它缺失的另一半。

```
dsh 会话日志 ZIP  ──►  preview（读出归档内容，不写入）  ──►  commit（经持久化 seam 写回）
```

---

## 功能

| 能力 | 说明 |
|---|---|
| 一个 ZIP 一次导入 | 归档里的根会话 + 全部子会话日志一起恢复，谱系（`parentSession`）保持不变 |
| 真·恢复，不是重建 | 日志经 `ctx.sessionPersistence` 的写句柄逐条写入，和 dsh 自己写的会话没有区别：能列出、能打开、能续聊 |
| 两种导入模式 | **原样恢复**（保留归档里的会话 ID 与工作区）／**作为副本**（生成新 ID，适合从别的机器导入） |
| 冲突自动降级 | 目标机器已存在同 ID 会话时自动改用副本模式，并改写事件里对该会话 ID 的引用（含 `tool/call.arguments` 这类 JSON 文本载体） |
| 工作区改写 | 归档里的工作区在本机不存在、或来自另一种路径风格（Windows ↔ POSIX）时，可统一恢复到指定工作区 |
| 附件恢复 | `media/*` 图片经 `ctx.attachments.saveImage` 落库；`files/*` 文件经 `saveFileStream` 逐块落库。存储重新归一化导致 ID 变化时，日志里的引用会被同步改写 |
| 归档严格校验 | 格式版本、事件词表、`seq` 连续性、头部字段集合、`isSeeded` 与 `session/end-seed` 标记一致性，全部在写入前检查——写入一个坏日志比拒绝它更糟 |
| 兼容旧归档 | 0.1.x 导出的原始 `.jsonl.zstd` 工件（多帧 Zstandard 拼接）也能解出内容；世代过旧时会明确拒绝而不是误读 |
| 无依赖、无构建 | 宿主半侧只用 `node:*`；浏览器半侧是手写的 lazy-CJS bundle，不需要打包工具链 |

---

## 兼容性

- **目标 harness**：dsh `0.2.0-rc.2`（session 格式 v4，Web/桌面 profile）。读取器对该版本的
  归档布局与事件词表做严格校验：dsh 升级后如果词表变了，插件会明确拒绝而不是误读。
- **Node.js** ≥ 22.15（宿主半侧用到 `node:zlib` 的 Zstandard API）。
- **平台**：Windows / macOS / Linux 均可（路径层面 macOS 与 Linux 同规）；CI 在 Windows 与 Linux
  上跑测试。跨平台导入（例如 Windows 导出、Linux 恢复）需要指定目标工作区。

---

## 安装

```bash
# 从 GitHub 安装（推荐，尚未发布 npm 时）
dsh plugin --profile desktop add github:pigeoncode258/dsh-session-restore

# 本地目录（开发时；改动在重启 dsh 后生效）
dsh plugin --profile desktop add link:<本目录绝对路径>

# 发布到 npm 之后
dsh plugin --profile desktop add dsh-session-restore
```

`package.json` 里已声明 `dsh.bundle.patch`（宿主半侧）与 `dsh.client`（浏览器半侧），
`dsh plugin add` 会自动把包加入 profile 的 `dsh.profile.bundles` 并在该 profile 里
`pnpm install`。也可以在「设置 → 插件」里安装。

> **bundle 变更在 dsh 启动时组装，装完请重启一次 dsh。**

---

## 使用

### 1. 图形界面（推荐）

两个入口，共用同一个导入弹窗：

- **侧边栏底部**：设置按钮旁的「导入会话归档」（展开时显示文字，收起时是图标）——
  不依赖当前是否打开了会话，弹窗就在这里；
- **会话头部右侧**：导出按钮旁的未归档图标 —— 会把当前会话的工作区作为默认建议工作区。

弹窗流程：

1. 把 `dsh-session-*.zip` 拖进弹窗，或点击选择文件；
2. 弹窗先展示归档内容：根会话与子会话的标题、ID、事件数、创建时间、工作区是否存在/是否可用、
   是否已存在同 ID 会话、附件数量与缺失引用、以及所有非致命提示；
3. 选项：
   - **导入方式**：原样恢复 / 作为副本；
   - **工作区**：勾选后可填写目标工作区，把归档里的会话统一落到该目录；
   - **恢复图片与文件**：默认开启（部署未挂载附件存储时自动禁用）；
4. 点「开始导入」，弹窗展示每个会话的结果；成功后可直接「打开会话」跳到恢复出来的根会话，
   会话列表会同步刷新。

### 2. 斜杠命令（归档已在本机时）

```
/import D:\backup\dsh-session-<id>.zip
/import "D:\路径 带空格\x.zip" --copy          # 作为副本导入（新会话 ID）
/import x.zip --cwd C:\work\project          # 统一恢复到指定工作区
/import x.zip --no-media                     # 只恢复对话，不恢复附件
```

命令参数：`--copy` / `-c`、`--no-media`、`--cwd <路径>`（相对路径按当前工作目录解析）。
执行成功后会刷新会话列表，并在命令结果里列出恢复出的会话 ID。

### 3. 编程接口（其他插件）

```js
const service = ctx.get('sessionRestore');
const preview = await service.preview(zipPath, { sessionId });
const result = await service.commit({ token, mode: 'restore', cwd, importMedia: true });
```

宿主半侧注册的 HTTP 路由（浏览器侧按文档相对路径访问，需要会话 Cookie）：

| 路由 | 方法 / body | 作用 |
|---|---|---|
| `/api/session.restore.preview` | `POST`，`application/zip`，**流式** | 暂存上传的归档并返回预览 + `token` |
| `/api/session.restore.commit` | `POST`，`application/json` | 按 `token` 恢复暂存的归档 |
| `/api/session.restore.discard` | `POST`，`application/json` | 丢弃暂存的上传 |

除协议错误（405/415/400）外一律 `200` + `{ ok: true, value }` 或
`{ ok: false, error: { code, message } }`，与 dsh 既有的浏览器面约定一致。

---

## 恢复语义（细节）

- **身份**：原样恢复时保留归档中的 `id`；副本模式按原 ID 的形状生成新 ID
  （普通会话 `session-<uuid>`、子会话裸 UUID），并把头部与所有事件里出现的旧 ID
  改写为新 ID（`parentSession`、子会话目录、JSON 文本载体一并处理）。
- **工作区**：`cwd` 必须在本平台是绝对路径，且缺失 `cwd` 的冷会话不会出现在会话列表中
  （这是 dsh 的既有行为）。归档跨平台导入时，预览会标注「工作区路径在本平台不可用」，
  并要求指定目标工作区；命令模式下用 `--cwd` 指定。
- **冲突**：`create()` 拒绝已存在的 ID，且本版本没有删除接口，因此已存在时**不会覆盖**，
  而是整批降级为副本模式并提示。
- **继承切点**：`isSeeded` 会话的 `inheritedEventCount` 由日志里最后一个
  `session/end-seed { inherited: true }` 推导（导出文件不含该字段），推导不一致时直接拒绝。
- **子会话**：`origin: "subagent"` 的子会话按 dsh 的既有规则不能独立 resume，但会完整恢复在
  根会话的谱系与轨迹里。
- **附件**：只恢复被日志引用的条目；归档中缺失的引用、存储归一化后 ID 变化的引用都会在结果里如实报告。
- **暂存与清理**：上传的归档暂存在 `$DSH_HOME/session-restore/staging/`，提交或丢弃后立即删除；
  未被消费的上传默认 6 小时后清理，最多保留 24 个。

---

## 限制与注意

- 归档必须是**本 harness 能读的格式版本（v4）**：来自更新版本 dsh 的归档会提示「升级 harness」，
  更旧的版本会提示「没有恢复路径，请用能读它的 dsh 打开后重新导出」，两者都不会被误读。
- 恢复出来的会话带着原来的 `request/header` 历史；**之后的请求使用当前 envelope**
  （当前模型、系统提示词、工具集），所以从别的机器导入时，第一轮续聊发出的请求与你当前的
  模型/权限设置一致，而不是归档时的设置。
- `agentPreset` 按原样写入：如果本机没有同名 preset，会话仍可打开，但续聊前请先确认预设。
- 不提供删除/保留接口：导入是增量操作，清理需要自行删除
  `$DSH_HOME/sessions/<项目目录>/<会话目录>/`。

## 配置

`cordis.patch.yml` 的 insert 行可加 `config:`：

| 键 | 默认 | 说明 |
|---|---|---|
| `stagingTtlMs` | `21600000`（6 小时） | 未消费的上传归档保留时长 |
| `maxUploadBytes` | `2 GiB` | 单次上传上限 |
| `maxEntryBytes` | `512 MiB` | 单个归档条目解压上限 |

---

## 结构

```
lib/index.js      插件入口：服务、路由、/import 命令
lib/service.js    preview / commit / discard，工作区采样与回退
lib/restore.js    恢复引擎：身份映射、批量 append、冲突降级
lib/media.js      附件恢复与引用改写
lib/archive.js    归档解析：条目分类、JSONL 校验、继承切点、跨平台工作区判定
lib/zip.js        零依赖 ZIP 读取器 + 多帧 Zstandard 解码
lib/vocabulary.js 本版本的事件词表与格式版本
lib/staging.js    上传暂存与清理
lib/routes.js     三个 HTTP 路由
lib/client.js     浏览器半侧（手写 lazy-CJS bundle）：侧边栏入口 + 会话头部触发器 + 导入弹窗
test/             51 个离线测试 + 一个可选的真实工件校验脚本
```

## 开发

```bash
node test/run.mjs              # 全部离线测试（无需安装任何依赖）
node test/real-artifacts.mjs   # 可选：用本机 $DSH_HOME/sessions 下的真实工件校验读取器
```

- 测试不依赖 dsh 运行时：持久化、附件存储、宿主 HTTP 连接都用行为等价的替身；
  浏览器半侧在 `node:vm` 里按真实 loader 协议加载，并用最小 React 渲染每个分支。
- 欢迎 issue / PR。改动请保持「无运行时依赖、无构建步骤」这条线。

## 许可

[MIT](LICENSE)
