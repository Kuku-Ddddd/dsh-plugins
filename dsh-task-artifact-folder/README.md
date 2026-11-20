# @local/dsh-task-artifact-folder

每次开一个新任务（新会话），自动在**工作区根**建一个与这个任务同名的文件夹，并且让这个任务的产物落进那个文件夹。

插件只在宿主侧工作，不依赖模型配合；模型任务是「把交付物直接写进那个目录」，做不到时由宿主兜底收纳。

---

## 它做了什么

| 环节 | 触发时机 | 行为 |
|---|---|---|
| ① 建目录 | 会话**马上要写文件了**（`write`/`edit` 这类带 `file_path` 的工具执行前），或会话标题异步落地时 | 按上下文定名，在工作区根 `mkdir` 建出 `<任务名>/` |
| ② 引导 | 之后每次 system prompt 组装 | 追加一条常驻提示：本任务的产物目录是……请直接写进这个目录 |
| ③ 兜底收纳 | `present` 声明交付物时、或回合结束时 | 把不在目录里的产物**复制**进去 |
| ④ 跟随改名 | **你给任务改名**（应用里改标题）时 | 产物目录跟着改名，已收纳文件跟着走。**不往对话里插任何消息**（装机实证：注入的假用户消息曾把模型正在生成的真实回答挤成目录播报）——新路径由常驻引导段落自动给出 |
| 工具 | 模型主动调用 | `artifact_folder`：`where` / `list` / `stage` / `rename` |

设计要点：

- **建目录锚在工作区根，不是当前 cwd。** 用的是 `session.header.cwd`（DSH 认定的工作区根）。所以 agent 中途 `cd` 进产物目录，也不会在工作区里套娃出 `任务名/任务名/`。
- **只有你手动改名会挪目录。** 会话标题会被模型自动重命名（`provider`/`fallback` 来源），那类变化不动目录；只有人工改名（`session/title` 事件里 `source.kind === "user"`）才触发。改名后已收纳的文件跟着走、`map.json` 更新。**改名不往对话里注入任何通知**：`agent.inject` 的消息会被下一步当成用户输入（装机实证：它把模型正在生成的真实回答挤成了「收到，路径已更新」的目录播报）。模型看到新路径的正确通道是常驻引导段落——它每次组装都读最新值。**目标路径被占用（同名文件 / 非空目录）时拒绝冒险**，保留原目录并说明原因；改名失败（比如目录正被某进程当工作目录占用，Windows 会拒绝）也同样保留原目录。
- **默认复制不移动。** 移动会让 agent 之后按原路径继续 `edit` 时直接失败（DSH 的 read-before-edit 策略按旧路径找文件）。想彻底只保留一份，把 `stageMode` 改成 `move`。
- **不偷偷改模型给的路径。** DSH 明确禁止在 `tools/pre-execute` 改写写入参（`dsh-tools` README「deliberately cannot rewrite `exec.arguments`」），本插件只用这个时机做观察和建目录。
- **子代理不单独建目录。** `origin === 'subagent'` 或 `delegationDepth > 0` 的会话默认跳过（与 DSH 自家的 `dsh-workspace-changes` 判定一致），需要时 `includeSubagents: true`。

---

## 安装

见仓库根的安装步骤（链接进 profile 并加入 bundles）。安装后**重启 DSH** 生效（本插件是宿主插件，不是浏览器插件，HMR 不会重载它）。

---

## 配置

配置文件：`~/.dsh/task-artifact-folder/config.json`（`mtime` 变化后热读，改完不用重启）。没有这个文件时全用默认值。

```json
{
  "naming": "context",
  "maxLength": 48,
  "stageMode": "copy",
  "collectWritten": true,
  "enabled": true
}
```

`dsh.profile.bundles` 里插一行时也可以在 `cordis.patch.yml` 的同一 entry 下给 `config:`（走官方配置通道，优先级高于 `config.json`）：

```yaml
- insert:
    - id: task-artifact-folder
      name: '@local/dsh-task-artifact-folder'
      config:
        naming: title
        datePrefix: ymd
```

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 关掉后一切行为停止（工具仍在，会报「产物目录不可用」） |
| `naming` | `"context"` | 名字来源：`title` = 只用会话标题；`context` = 标题优先、退回首条人类消息；`prompt` = 只用首条人类消息 |
| `datePrefix` | `"none"` | 目录名加日期前缀：`none` / `ymd`（`20261020-`）/ `ymd-hm`（`20261020-2206-`） |
| `maxLength` | `48` | 名字最长多少字符（不含日期前缀） |
| `maxWords` | `12` | 用首条消息取名时的词数上限（CJK 按字符折算） |
| `shareByName` | `true` | 不同会话标题撞车时共用同一目录；`false` 则追加 `-2`、`-3` |
| `includeSubagents` | `false` | 子代理会话也单独建目录 |
| `createEager` | `true` | 在产物出现之前就把目录建出来 |
| `copyOnPresent` | `true` | `present` 声明的产物收纳进目录 |
| `collectWritten` | `true` | 本回合 `write` 出来的交付物扩展名文件，回合结束时收纳 |
| `artifactExtensions` | 见 index.js | `collectWritten` 认作「产物」的扩展名 |
| `stageMode` | `"copy"` | 收纳方式；`move` 会删掉原文件 |
| `maxCopyBytes` | `536870912` | 单文件超过此大小不收纳 |
| `neverStageNames` | 见 index.js | **自动收纳**（回合结束的 `collectWritten`）跳过这些文件名（`README.md`、`package.json`、锁文件等仓库协议文件）。present 声明与 `artifact_folder stage` 属显式点名，不受此名单限制 |
| `excludePathParts` | 见 index.js | **自动收纳**跳过路径含这些片段的文件（`node_modules`、`.git`、`.dsh` 等）。显式点名同样不受限 |
| `toolEnabled` | `true` | 是否注册 `artifact_folder` 工具 |
| `renameFollowsTitle` | `true` | 你给任务改名时产物目录是否跟着改名（见上文「跟随改名」）；关掉则回到「名字一经决定就冻结」的旧行为 |
| `sectionOrder` | `9100` | 系统提示段落顺序 |
| `extraGuidance` | 见 index.js | 提示段落末尾追加的一句话 |

**状态文件**：`~/.dsh/task-artifact-folder/map.json` 记录「会话 id → 产物目录」。删掉它不会丢文件，只是下次会重新取名；超过 2000 条后按时间淘汰旧条目。

---

## 已知边界

- 用 **pwsh/python 脚本**直接生成的文件（不走 `write` 工具）不会被 `collectWritten` 捕获；这类产物通常会被 `present` 声明，走 present 兜底。真漏了就用 `artifact_folder` 的 `stage` 手动收。
- 工作区本身不是目录（或不存在）时什么都不会发生，只在日志里留一条说明。
- 插件以 `link:` 挂在 profile 上时**不能** `import` 任何 `@deepseek-ai/*` 包（裸导入解析不到宿主 `node_modules`），所以 `defineTool` 是本地 vendor 版本，只覆盖本插件用到的参数类型。
