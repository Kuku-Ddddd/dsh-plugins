/**
 * 插件自己的小仓库：config.json（可改，热读）+ map.json（会话→产物目录，冻结用）。
 * 只用 node 内置，不 import 任何 @deepseek-ai 包——本插件是 link: 挂进 profile 的，
 * 裸导入解析不到宿主 node_modules（装机实证：ERR_MODULE_NOT_FOUND）。
 */
import { readFileSync, existsSync, statSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DIR_NAME = 'task-artifact-folder'
const MAP_FILE = 'map.json'
const CONFIG_FILE = 'config.json'
const MAX_MAP_ENTRIES = 2000

export function dshHome() {
  const env = process.env.DSH_HOME
  if (typeof env === 'string' && env.trim().length > 0) return env
  return join(homedir(), '.dsh')
}

export function stateDir() {
  return join(dshHome(), DIR_NAME)
}

export function configPath() {
  return join(stateDir(), CONFIG_FILE)
}

export function mapPath() {
  return join(stateDir(), MAP_FILE)
}

/** 同步读 JSON；不存在或坏掉都返回 undefined，让调用方走默认。 */
export function readJsonSync(path) {
  try {
    if (!existsSync(path)) return undefined
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

/** 只接受与默认值同类型的已知键，防止手滑把数组写成字符串。 */
export function pickKnown(source, defaults) {
  const out = {}
  if (source === null || typeof source !== 'object' || Array.isArray(source)) return out
  for (const key of Object.keys(defaults)) {
    if (!Object.hasOwn(source, key)) continue
    const value = source[key]
    const fallback = defaults[key]
    const arrayOk = Array.isArray(fallback)
      ? Array.isArray(value) && value.every((item) => typeof item === 'string')
      : typeof value === typeof fallback
    if (arrayOk) out[key] = value
  }
  return out
}

/** 原子写 JSON（同目录 tmp + rename）。 */
export function writeJsonSync(path, data) {
  mkdirSync(join(path, '..'), { recursive: true })
  const tmp = `${path}.${process.pid}.${String(Date.now())}.tmp`
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  renameSync(tmp, path)
}

/** config.json 的 mtime，用来判断要不要重新读。 */
export function stampOf(path) {
  try {
    return statSync(path).mtimeMs
  } catch {
    return 0
  }
}

/** 按 updatedAt 保留最近 N 条，防止 map.json 无限增长。 */
export function trimSessions(sessions, cap = MAX_MAP_ENTRIES) {
  const entries = Object.entries(sessions)
  if (entries.length <= cap) return sessions
  entries.sort((a, b) => (a[1]?.updatedAt ?? 0) - (b[1]?.updatedAt ?? 0))
  return Object.fromEntries(entries.slice(entries.length - cap))
}
