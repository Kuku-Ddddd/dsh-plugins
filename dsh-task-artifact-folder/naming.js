/**
 * 纯函数：把任务上下文变成合法的目录名。
 * 单独成文件，方便单元测试，也避免插件主体依赖任何东西。
 */

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i
/** Windows 目录名不允许的字符（保留 . - _ 空格与全部 CJK）。 */
const INVALID = /[<>:"/\\|?*\u0000-\u001f\u007f~]/g
const QUOTES = /[“”‘’「」『』《》【】\[\]()]/g

/** 词数上限：CJK 一个字符算一词，拉丁按空格分词。 */
export function capWords(text, maxWords) {
  const source = String(text ?? '').trim()
  if (source.length === 0) return ''
  if (!/[\u2e80-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\uff01-\uff60]/.test(source)) {
    const words = source.split(/\s+/).filter(Boolean)
    return words.length <= maxWords ? source : words.slice(0, maxWords).join(' ')
  }
  return Array.from(source).slice(0, Math.max(4, maxWords * 2)).join('')
}

/**
 * 把任意上下文文本（标题 / 首条消息）清洗成安全的目录名片段。
 * 保序：先做无效字符替换再压缩空白，避免把分隔符吃成粘连。
 */
export function sanitizeName(input, maxLength = 48) {
  let s = String(input ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(INVALID, ' ')
    .replace(QUOTES, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '')
  s = s.replace(/\s+/g, ' ').trim().replace(/[.\s]+$/, '')
  const cps = Array.from(s)
  if (cps.length > maxLength) s = cps.slice(0, maxLength).join('').replace(/[.\s]+$/, '')
  if (s.length === 0) return ''
  if (RESERVED.test(s)) s = `#${s}`
  return s
}

/** none / ymd / ymd-hm */
export function datePrefix(mode, at = Date.now()) {
  if (mode === undefined || mode === 'none') return ''
  const d = new Date(at)
  const p = (n) => String(n).padStart(2, '0')
  const ymd = `${String(d.getFullYear())}${p(d.getMonth() + 1)}${p(d.getDate())}`
  return mode === 'ymd-hm' ? `${ymd}-${p(d.getHours())}${p(d.getMinutes())}` : ymd
}

/** session-011d5205-56a6-4142-895a-3ae647c21a70 → 3ae647c21a70 */
export function shortId(sessionId) {
  const raw = String(sessionId ?? '').replace(/[^A-Za-z0-9]/g, '')
  if (raw.length === 0) return 'task'
  return raw.length <= 10 ? raw : raw.slice(-10)
}
