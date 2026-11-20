import { promises as fsp } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, resolve, win32 } from 'node:path'

import { defineTool } from './define-tool.js'
import { capWords, datePrefix, sanitizeName, shortId } from './naming.js'
import {
  configPath, mapPath, pickKnown, readJsonSync, stateDir, stampOf, trimSessions, writeJsonSync,
} from './store.js'

/**
 * task-artifact-folder —— 每个新任务，自动在工作区建一个「同名文件夹」，产物装进去。
 *
 * 三个环节，都在宿主侧完成，不依赖模型听话：
 *
 * ① 建目录（在产物出现之前）
 *    触发点不是回合开始，而是「本会话马上要产出文件了」：write/edit 这类带 file_path
 *    的工具在 `tools/pre-execute` 上被抓到（这是官方允许只读观察的位置，README:233
 *    明确 pre-execute 不能改写入参，所以本插件只做观察+建目录，从不偷偷改模型给的路径），
 *    外加会话标题异步落地那一刻（`session/title`）与兜底收纳时的兜底判断。
 *    取名按 `naming` 配置：title = 只看会话标题；context = 标题优先、退回首条人类消息
 *    （来自 `titleInput` 投影或 pre-step 的 claimed 批次）；prompt = 只用首条人类消息。
 *    名字一经决定就写进 `~/.dsh/task-artifact-folder/map.json`，之后的自动标题重生成
 *    （provider/fallback）不会再挪目录；但**用户人工改名**（`session/title` 且
 *    `source.kind === "user"`）默认会让目录跟着改名（`renameFollowsTitle`）。改名后
 *    **不往对话里插任何消息**——新路径由下面的常驻引导段落自动给出；注入历史消息会
 *    被模型当成用户输入（装机实证：它把真实回答挤成了目录播报）。
 *    目录锚在 `session.header.cwd`（dsh-tool-fs 认定的工作区根），不是当前 cwd，
 *    所以 agent 中途 cd 进产物目录也不会套娃出二级目录。
 *
 * ② 引导（主路径）
 *    一条 `systemPrompt.section()`，text 是函数，按 session 返回本任务产物目录。
 *    常驻规则用 section 而不是往历史里注入消息：注入会进 durable history，被压缩之后
 *    旧目录还在误导模型（见 dsh-working-directory 的 context() 官方范式）。
 *
 * ③ 兜底收纳（漏网的产物）
 *    a. `deliverables/presented`：present 是 DSH 官方的「交付物声明」，
 *       文件列表直接来自它的结果；不在目录里的就复制进去（默认 copy 不 move——
 *       move 会让 agent 之后按原路径继续 edit 直接失败）。
 *    b. 本回合 write 出来、扩展名在 `artifactExtensions` 里、且在工作区根下的文件：
 *       等回合结束（`turn/end`）再收纳。路径取自 write 工具的 `file_path` 参数，
 *       相对路径按会话当前 cwd 解析（和 write 自己的解析方式一致）。
 *
 * 另提供 `artifact_folder` 工具（where / list / stage），给模型一个显式收纳入口。
 *
 * 配置在 `~/.dsh/task-artifact-folder/config.json`，按 mtime 热读，改完不用重启。
 * 之所以不导出插件 Config：本插件以 `link:` 挂在 profile node_modules 之外，
 * 裸导入 `@deepseek-ai/schemastery` 会 ERR_MODULE_NOT_FOUND，声明不了 schema。
 */

export const name = 'task-artifact-folder'

/** 只声明一定在场的服务；sessionTitle / workspaceChanges 用 ctx.get 机会式读。 */
export const inject = ['tools', 'systemPrompt', 'workingDirectory', 'sessionProjections']

const DEFAULTS = {
  /** 命名来源：title / context（默认）/ prompt */
  naming: 'context',
  /** 目录名前缀：none / ymd / ymd-hm */
  datePrefix: 'none',
  /** 名字最长多少码点（不含日期前缀） */
  maxLength: 48,
  /** 用首条消息取名时的词数上限（CJK 按字符数折算） */
  maxWords: 12,
  /** 不同会话标题撞车时，是否共用同一个目录（false 则追加 -2/-3） */
  shareByName: true,
  /** 子代理 / fork 出来的会话也单独建目录 */
  includeSubagents: false,
  /** 在产物出现前就先把目录建出来 */
  createEager: true,
  /** present 声明的产物收纳进目录 */
  copyOnPresent: true,
  /** 本回合 write 出来的交付物扩展名文件，回合结束时收纳 */
  collectWritten: true,
  /** collectWritten 认作「产物」的扩展名（小写，带点） */
  artifactExtensions: ['.docx', '.pptx', '.xlsx', '.xls', '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.csv', '.zip', '.7z', '.mp4', '.mov', '.wav', '.mp3', '.md', '.html', '.txt'],
  /** 收纳时 copy（默认，原路径仍可用）还是 move */
  stageMode: 'copy',
  /** 这些文件名的文件永远不收纳（仓库协议文件等，即使扩展名匹配） */
  neverStageNames: ['README.md', 'AGENTS.md', 'CLAUDE.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'LICENSE', 'LICENSE.md', 'LICENSE.txt', 'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'],
  /** 单文件超过这个字节数就不收纳 */
  maxCopyBytes: 512 * 1024 * 1024,
  /** 路径里含这些片段的文件不收纳 */
  excludePathParts: ['/node_modules/', '\\node_modules\\', '/.git/', '\\.git\\', '/.tmp/', '\\.tmp\\', '/.dsh/', '\\.dsh\\'],
  /** 注册 artifact_folder 工具 */
  toolEnabled: true,
  /** 用户人工给任务改名（session/title 且 source.kind === "user"）时，产物目录跟着改名 */
  renameFollowsTitle: true,
  /** 系统提示段落顺序（外部插件可任取有限数；9000 区间放交付物/环境类事实） */
  sectionOrder: 9100,
  enabled: true,
}

/** 判定「像路径」：只要带分隔符或绝对路径就交给 path 逻辑处理。 */
function looksLikePath(value) {
  return typeof value === 'string' && (isAbsolute(value) || value.includes('/') || value.includes('\\'))
}

/** 大小写不敏感的 inside 判定（Windows 是主战场）。 */
function isInside(parent, child) {
  if (typeof parent !== 'string' || typeof child !== 'string') return false
  const rel = win32.relative(win32.normalize(parent), win32.normalize(child))
  return rel !== '' && !rel.startsWith('..') && !win32.isAbsolute(rel) && !rel.includes(':')
}

/** 大小写不敏感的目录同址判定（Windows 上 C:\A\b 与 c:\a\B 是同一个目录）。 */
function sameDir(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  return win32.normalize(a).replace(/[\\/]+$/, '').toLowerCase() === win32.normalize(b).replace(/[\\/]+$/, '').toLowerCase()
}

/** 路径当前是什么：'directory' / 'file' / 'missing'。 */
async function pathKind(p) {
  try {
    const info = await fsp.stat(p)
    return info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other'
  } catch {
    return 'missing'
  }
}

export function apply(ctx, rawConfig) {
  const info = (message) => ctx.logger.info(`task-artifact-folder: ${message}`)
  const warn = (message, error) => ctx.logger.warn(`task-artifact-folder: ${message}${error === undefined ? '' : ` — ${String(error instanceof Error ? error.message : error)}`}`)

  // ---------------------------------------------------------------- 状态
  let config = { ...DEFAULTS }
  let stamp = stampOf(configPath())
  const sessions = new Map()
  const pendingWrites = new Map()
  /** 已收纳过的「会话|源文件」→ 目录内目标路径，防同一文件重复复制并让重复声明可幂等回答。 */
  const staged = new Map()
  let ownersByDir = new Map()

  const loadConfig = () => {
    const parsed = readJsonSync(configPath())
    if (parsed === undefined) return { ...DEFAULTS }
    return { ...DEFAULTS, ...pickKnown(parsed, DEFAULTS) }
  }
  const loadMap = () => {
    const parsed = readJsonSync(mapPath())
    const entries = parsed?.sessions ?? parsed ?? {}
    const restored = new Map()
    for (const [id, entry] of Object.entries(entries)) {
      if (typeof entry?.dir === 'string') restored.set(id, { dir: entry.dir, name: entry.name ?? basename(entry.dir), source: entry.source ?? 'map', at: entry.at ?? 0 })
    }
    return restored
  }

  // 优先级：默认值 < config.json < profile patch 的 config（patch 是官方配置通道）。
  config = { ...DEFAULTS, ...loadConfig(), ...pickKnown(rawConfig ?? {}, DEFAULTS) }
  for (const [id, entry] of loadMap()) sessions.set(id, entry)
  rebuildOwners()
  if (sessions.size > 0) info(`已恢复 ${sessions.size} 个任务的产物目录映射`)

  function rebuildOwners() {
    ownersByDir = new Map()
    for (const [id, entry] of sessions) {
      const key = entry.dir.toLowerCase()
      const set = ownersByDir.get(key) ?? new Set()
      set.add(id)
      ownersByDir.set(key, set)
    }
  }

  /** 每次决策前按 mtime 热读配置。 */
  function refreshConfig() {
    const current = stampOf(configPath())
    if (current === stamp) return config
    stamp = current
    config = { ...config, ...loadConfig() }
    info(`已热加载配置 ${configPath()}`)
    return config
  }

  function saveMap() {
    try {
      const flat = {}
      for (const [id, entry] of sessions) {
        flat[id] = { dir: entry.dir, name: entry.name, source: entry.source, at: entry.at, updatedAt: Date.now() }
      }
      writeJsonSync(mapPath(), { sessions: trimSessions(flat) })
    } catch (error) {
      warn('写 map.json 失败', error)
    }
  }

  // ---------------------------------------------------------------- 工具函数
  const topLevel = (session) => config.includeSubagents
    || (session.header.origin !== 'subagent' && (session.header.delegationDepth ?? 0) === 0)

  const stateOf = (session, key) => {
    try {
      return ctx.sessionProjections.stateOf(session, key)
    } catch {
      return undefined
    }
  }

  const titleOf = (session) => {
    const projected = stateOf(session, 'title')
    if (typeof projected === 'string' && projected.length > 0) return projected
    try {
      return ctx.get('sessionTitle')?.get?.(session)?.title ?? undefined
    } catch {
      return undefined
    }
  }

  /** 从 claimed 批次里取第一条「真人」消息文本（排除 runtime-context / working-directory 等通知）。 */
  function humanText(messages) {
    for (const message of messages ?? []) {
      if (message?.role !== 'user') continue
      const kind = message.source?.kind
      if (kind !== undefined && kind !== 'user') continue
      const text = (message.content ?? [])
        .filter((block) => block?.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join(' ')
      if (text.replace(/@<[^>]*>/g, '').trim().length > 0) return text.trim()
    }
    return undefined
  }

  /** 工作区根 = 会话最初的目录（dsh-tool-fs:1125），不是可能被 cd 改掉的当前 cwd。 */
  const rootOf = (session) => {
    const declared = session.header.cwd
    if (typeof declared === 'string' && isAbsolute(declared)) return declared
    const current = ctx.workingDirectory.get(session)
    return typeof current === 'string' && isAbsolute(current) ? current : undefined
  }

  const realpathSafe = async (p) => {
    try {
      return await fsp.realpath(p)
    } catch {
      return p
    }
  }

  function candidate(session, hint, preferTitle) {
    const title = preferTitle ?? (config.naming === 'prompt' ? undefined : titleOf(session))
    const input = stateOf(session, 'titleInput')
    const firstInput = typeof input?.first?.text === 'string' ? input.first.text : undefined
    const text = title ?? firstInput ?? humanText(hint)
    if (typeof text !== 'string') return { name: `task-${shortId(session.id)}`, source: 'sessionId' }
    const source = title !== undefined ? 'title' : firstInput !== undefined ? 'titleInput' : 'firstPrompt'
    const trimmed = source === 'title' ? text : capWords(text, config.maxWords)
    const cleaned = sanitizeName(trimmed, config.maxLength)
    return cleaned.length === 0 ? { name: `task-${shortId(session.id)}`, source: 'sessionId' } : { name: cleaned, source }
  }

  async function pickDir(root, name) {
    if (config.shareByName) return join(root, name)
    const existing = ownersByDir.get(join(root, name).toLowerCase())
    if (existing === undefined || existing.size === 0) return join(root, name)
    for (let n = 2; n < 200; n += 1) {
      const candidateDir = join(root, `${name}-${String(n)}`)
      const owners = ownersByDir.get(candidateDir.toLowerCase())
      if (owners === undefined || owners.size === 0) return candidateDir
    }
    return join(root, `${name}-${shortId(name)}`)
  }

  /**
   * 决定（并在需要时建立）会话的产物目录。幂等；自动标题重生成不触发改名，
   * 人工改名走 {@link renameFolder}。
   */
  async function decide(session, hint, preferTitle) {
    if (!config.enabled || !topLevel(session)) return undefined
    const known = sessions.get(session.id)
    if (known !== undefined) {
      if (config.createEager) await ensureDir(known.dir)
      return known
    }
    const root = rootOf(session)
    if (root === undefined) return undefined
    const base = candidate(session, hint, preferTitle)
    const prefix = datePrefix(config.datePrefix)
    const name = prefix.length > 0 ? `${prefix}-${base.name}` : base.name
    const dir = await pickDir(await realpathSafe(root), name)
    if (config.createEager && !(await ensureDir(dir))) return undefined
    const entry = { dir, name, source: base.source, at: Date.now() }
    sessions.set(session.id, entry)
    rebuildOwners()
    saveMap()
    info(`任务产物目录 ${dir}（取名来源：${base.source}）`)
    return entry
  }

  /**
   * 用户人工改名后，把产物目录跟着改名（含 shareByName 下共用该目录的其它会话）。
   * 安全约束：目标已存在（且不是本目录自身）就不动——绝不合并、绝不覆盖别的目录；
   * 改名失败（最常见：目录正被某个进程当作工作目录，Windows 不允许）时保留原目录，
   * 模型手上的路径继续有效。改名后模型看到的新路径由常驻引导段落提供，不注入对话。
   * @returns 改名结果摘要；未改名时说明原因。
   */
  async function renameFolder(session, newTitle) {
    const entry = sessions.get(session.id)
    if (entry === undefined) return { renamed: false, reason: '会话还没有产物目录' }
    const cleaned = sanitizeName(String(newTitle ?? ''), config.maxLength)
    if (cleaned.length === 0) return { renamed: false, reason: '新名字清洗后为空' }
    const prefix = datePrefix(config.datePrefix)
    const name = prefix.length > 0 ? `${prefix}-${cleaned}` : cleaned
    const root = dirname(entry.dir)
    const target = join(root, name)
    if (sameDir(target, entry.dir)) return { renamed: false, reason: '名字没有变化', dir: entry.dir }

    const kind = await pathKind(target)
    if (kind === 'file') {
      warn(`改名中止：目标 ${target} 已存在同名文件`)
      return { renamed: false, reason: '目标路径被一个同名文件占用', dir: entry.dir }
    }
    if (kind === 'directory') {
      const owners = ownersByDir.get(target.toLowerCase()) ?? new Set()
      const others = [...owners].filter((id) => !sameDir(sessions.get(id)?.dir ?? '', entry.dir))
      if (!config.shareByName && others.length > 0) {
        return { renamed: false, reason: '目标目录已属于另一个任务', dir: entry.dir }
      }
      const listing = await fsp.readdir(target).catch(() => ['?'])
      if (listing.length > 0) {
        warn(`改名中止：目标 ${target} 已存在且非空`)
        return { renamed: false, reason: '目标目录已存在且非空', dir: entry.dir }
      }
    }

    const affected = [...sessions.entries()].filter(([, value]) => sameDir(value.dir, entry.dir)).map(([id]) => id)
    try {
      await fsp.rename(entry.dir, target)
    } catch (error) {
      warn(`目录改名失败 ${entry.dir} → ${target}（最常见原因：目录正被用作某个进程的工作目录；原目录与旧路径保持有效）`, error)
      return { renamed: false, reason: `改名失败：${String(error instanceof Error ? error.message : error)}`, dir: entry.dir }
    }
    const oldDir = entry.dir
    for (const id of affected) {
      const record = sessions.get(id)
      if (record === undefined) continue
      record.dir = target
      record.name = name
      record.renamedAt = Date.now()
    }
    // staged 的值（目录内目标路径）也要跟着指向新目录
    for (const [key, value] of staged) {
      if (typeof value === 'string' && sameDir(dirname(value), oldDir)) {
        staged.set(key, join(target, basename(value)))
      }
    }
    rebuildOwners()
    saveMap()
    info(`任务改名：${oldDir} → ${target}（${name}）`)
    // 刻意不往会话里注入「目录已改名」通知：agent.inject 落进历史后会被下一步
    // 当成用户消息处理（装机实证：它把模型正在生成的真实回答挤成了目录播报）。
    // 模型看到新路径的正确通道是下面的 systemPrompt.section——每次组装都读最新值。
    return { renamed: true, dir: target, oldDir, affected }
  }

  async function ensureDir(dir) {
    try {
      await fsp.mkdir(dir, { recursive: true })
      return true
    } catch (error) {
      warn(`建目录失败 ${dir}`, error)
      return false
    }
  }

  /**
   * 相对/绝对路径 → 绝对路径。相对路径按会话当前 cwd 解析（与 write/present 自己的解析一致）。
   * 这里不能再用「看起来像不像路径」来过滤：`notes.md` 这种单段相对名没有分隔符，
   * 但它是完全合法的 file_path 值（装机时这个坑让 turn/end 收纳整条链路失效过）。
   */
  const toAbsolute = (session, raw) => {
    if (typeof raw !== 'string' || raw.trim().length === 0) return undefined
    return resolve(ctx.workingDirectory.get(session), raw.trim())
  }

  /**
   * 把一个产物文件收进目录。
   * @param session - 会话实体
   * @param rawPath - 绝对或相对（按会话 cwd）路径
   * @param mode - copy / move
   * @param options.explicit - 模型/用户**显式**声明的交付物（present、stage 工具）。
   *   显式声明时跳过 `neverStageNames` 与 `excludePathParts` 这类保守名单：
   *   用户要的就是这个文件，不该因为叫 README.md 或躺在 .tmp 下就被丢掉（装机实证：
   *   present 了 README.md 结果没被收纳）。自动收纳（turn/end）仍走名单，避免误伤。
   */
  async function stage(session, rawPath, mode = config.stageMode, { explicit = false } = {}) {
    const entry = await decide(session)
    if (entry === undefined) return undefined
    const source = toAbsolute(session, rawPath)
    if (source === undefined) return undefined
    const absolute = await realpathSafe(source)
    const already = staged.get(`${session.id}|${absolute}`)
    if (already !== undefined) return explicit ? already : undefined
    if (isInside(entry.dir, absolute)) return undefined
    let stat
    try {
      stat = await fsp.stat(absolute)
    } catch {
      return undefined
    }
    if (!stat.isFile()) return undefined
    if (stat.size > config.maxCopyBytes) {
      warn(`跳过超大产物 ${absolute}（${String(stat.size)} 字节）`)
      return undefined
    }
    if (!explicit) {
      if ((config.neverStageNames ?? []).includes(basename(absolute))) return undefined
      const lower = absolute.toLowerCase()
      if ((config.excludePathParts ?? []).some((part) => part.length > 0 && lower.includes(part.toLowerCase()))) return undefined
    }
    const target = await uniqueTarget(entry.dir, absolute, stat)
    try {
      await fsp.mkdir(dirname(target), { recursive: true })
      await fsp.copyFile(absolute, target)
      if (mode === 'move') await fsp.rm(absolute, { force: true })
      staged.set(`${session.id}|${absolute}`, target)
      info(`${mode === 'move' ? '移动' : '复制'}产物 ${basename(absolute)} → ${target}`)
      return target
    } catch (error) {
      warn(`收纳产物失败 ${absolute}`, error)
      return undefined
    }
  }

  async function uniqueTarget(dir, source, stat) {
    const ext = extname(source)
    const stem = basename(source, ext)
    for (let n = 0; n < 500; n += 1) {
      const candidatePath = join(dir, n === 0 ? basename(source) : `${stem} (${String(n)})${ext}`)
      let other
      try {
        other = await fsp.stat(candidatePath)
      } catch {
        return candidatePath
      }
      if (other.isFile() && other.size === stat.size && Math.abs(other.mtimeMs - stat.mtimeMs) < 2000) return candidatePath
    }
    return join(dir, `${stem} (${String(Date.now())})${ext}`)
  }

  // ---------------------------------------------------------------- 挂点

  /** 产物出现之前：定名 + 建目录。 */
  ctx.effect(() => ctx.on('tools/pre-execute', async (exec, next) => {
    const decision = await next()
    try {
      const session = exec.agent?.session
      if (session !== undefined && hasPathArg(exec.arguments)) await decide(session)
    } catch (error) {
      warn('pre-execute 决策失败', error)
    }
    return decision
  }), 'task-artifact-folder: pre-execute')

  /**
   * 判断这次工具调用是不是「要动文件」。只看参数形状，不看具体工具名，
   * 这样 office/python/bash 等任何带路径参数的工具都能触发提前建目录。
   * 注意：相对的单段文件名（`report.docx`）没有分隔符，必须靠扩展名认出来。
   */
  function hasPathArg(args) {
    if (args === null || typeof args !== 'object') return false
    return Object.entries(args).some(([key, value]) => {
      if (typeof value !== 'string') return false
      if (PATH_KEYS.has(key)) return value.trim().length > 0
      return looksLikePath(value) || HAS_EXTENSION.test(value.trim())
    })
  }

  /** 参数名里出现这些键，就认为是在动文件。 */
  const PATH_KEYS = new Set([
    'file_path', 'path', 'paths', 'filename', 'file', 'output', 'output_path', 'outputPath',
    'dir', 'directory', 'target', 'destination', 'dest', 'source', 'src', 'input', 'input_path',
    'notebook_path', 'image_path', 'attachment_path', 'workflow_path', 'resume_from',
  ])
  /** `report.docx` / `data/2026.csv` 这类带扩展名的文件名。 */
  const HAS_EXTENSION = /\.[A-Za-z0-9]{1,8}$/

  /** 标题事件：没定过名就按新标题定名；人工改名（source.kind === "user"）则目录跟随改名。 */
  ctx.effect(() => ctx.on('session/event', async (session, event) => {
    try {
      if (event.type === 'session/title') {
        const title = typeof event.data?.title === 'string' ? event.data.title : undefined
        if (sessions.get(session.id) === undefined) {
          // 直接用事件里的标题定名，不依赖投影的折叠时机
          await decide(session, undefined, title)
          return
        }
        const manual = event.data?.source?.kind === 'user'
        if (manual && config.renameFollowsTitle && title !== undefined) {
          await renameFolder(session, title)
        }
        return
      }
      if (event.type === 'deliverables/presented') {
        if (!config.copyOnPresent) return
        for (const file of event.data?.files ?? []) {
          if (typeof file?.path === 'string') await stage(session, file.path, config.stageMode, { explicit: true })
        }
        return
      }
      if (event.type === 'turn/end') await flushWrites(session)
    } catch (error) {
      warn(`处理 ${event.type} 失败`, error)
    }
  }), 'task-artifact-folder: session events')

  /** 记下本回合 write 的文件，等回合结束再收纳（防止写到一半就被搬走）。 */
  ctx.effect(() => ctx.on('tools/result', (exec, result) => {
    if (!config.collectWritten || result.isError || exec.agent === undefined || exec.name !== 'write') return
    const raw = exec.arguments?.file_path
    const absolute = toAbsolute(exec.agent.session, raw)
    if (absolute === undefined) return
    const session = exec.agent.session
    const list = pendingWrites.get(session.id) ?? []
    list.push(absolute)
    pendingWrites.set(session.id, list)
  }), 'task-artifact-folder: watch writes')

  async function flushWrites(session) {
    const list = pendingWrites.get(session.id)
    pendingWrites.set(session.id, [])
    if (list === undefined || list.length === 0) return
    const root = rootOf(session)
    for (const absolute of list) {
      const ext = extname(absolute).toLowerCase()
      if (!(config.artifactExtensions ?? []).includes(ext)) continue
      // 只收纳工作区根「直下」的文件。子目录里的（docs/notes.md、src/a.ts…）是模型
      // 自己组织好的结构，收纳会把层级拍平成 DSH分类/notes.md —— 那是破坏不是整理。
      if (root !== undefined && win32.dirname(absolute).toLowerCase() !== root.toLowerCase()) continue
      await stage(session, absolute, config.stageMode)
    }
  }

  /** 常驻引导。 */
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'task-artifact-folder:deliverables-dir',
    order: config.sectionOrder,
    interpolate: false,
    text: ({ agent }) => {
      const entry = agent === undefined ? undefined : sessions.get(agent.session.id)
      if (entry === undefined) return ''
      return [
        `本任务的产物目录是 ${JSON.stringify(entry.dir)}（工作区根下的同名文件夹，名字跟随任务标题）。`,
        `把新交付物直接写进这个目录；如果目录随任务改名而移动了，以本段给出的当前路径为准。`,
        `若文件已写在了别处，可用 artifact_folder 工具（action: stage）收进来。仅在真正涉及交付物落点时提及本目录，不要在回答正文里播报它。`,
      ].join(' ')
    },
  }), 'task-artifact-folder: section')

  // ---------------------------------------------------------------- 工具

  if (config.toolEnabled) {
    ctx.effect(() => ctx.tools.register(defineTool({
      name: 'artifact_folder',
      description:
        "Manage this task's artifact folder — the same-named directory the plugin creates at the workspace root for every new task. "
        + 'Actions: where (which folder this session uses, and whether it exists), list (what is inside it), '
        + 'stage (collect files into the folder — use it after a deliverable was written elsewhere), '
        + 'rename (rename the folder to match the current session title; the task title being renamed in the app does this automatically — use this only to sync manually). '
        + 'Prefer writing deliverables straight into the folder; stage is the fallback.',
      parameters: {
        action: { type: 'string', required: true, enum: ['where', 'list', 'stage', 'rename'], description: 'What to do.' },
        paths: { type: 'array', description: 'For stage: file paths to collect, relative to the session working directory or absolute.', items: { type: 'string' } },
        mode: { type: 'string', description: 'For stage: "copy" (default, keeps the original path usable) or "move" (removes the original; later edits at the old path fail).', enum: ['copy', 'move'] },
      },
      output: {
        schema: { type: 'object' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      async execute(args, exec) {
        if (exec.agent === undefined) throw new Error('artifact_folder 需要一个 agent 会话')
        const session = exec.agent.session
        refreshConfig()
        if (args.action === 'rename') {
          const title = titleOf(session)
          if (title === undefined) throw new Error('当前会话还没有标题，无法据此改名')
          const result = await renameFolder(session, title)
          return { action: 'rename', title, ...result }
        }
        const entry = await decide(session)
        if (entry === undefined) throw new Error('当前会话没有产物目录（可能是子代理会话，或插件被关闭）')
        if (args.action === 'where') {
          return { action: 'where', dir: entry.dir, nameFrom: entry.source, workspaceRoot: rootOf(session) ?? null }
        }
        if (args.action === 'list') {
          let names = []
          try {
            names = (await fsp.readdir(entry.dir, { withFileTypes: true })).filter((item) => item.isFile()).map((item) => item.name)
          } catch {
            /* 目录还没建出来就是空的 */
          }
          return { action: 'list', dir: entry.dir, files: names.sort() }
        }
        if ((args.paths ?? []).length === 0) throw new Error('stage 需要至少一个 paths')
        const stagedFiles = []
        for (const raw of args.paths) {
          const target = await stage(session, raw, args.mode ?? config.stageMode, { explicit: true })
          stagedFiles.push({ from: raw, to: target ?? null })
        }
        return { action: 'stage', dir: entry.dir, staged: stagedFiles }
      },
    }), 'task-artifact-folder: tool'))
  }

  /** 卸载前把 map 落盘。 */
  ctx.effect(() => () => {
    saveMap()
  }, 'task-artifact-folder: flush map')

  // 启动时确保配置目录存在，方便用户直接去里面改配置。
  void (async () => {
    try {
      await fsp.mkdir(stateDir(), { recursive: true })
    } catch {
      /* 建不出来也不致命，内存态照样工作 */
    }
  })()
}
