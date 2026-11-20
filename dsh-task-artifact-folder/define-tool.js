/**
 * defineTool 本地实现（vendor 自 @deepseek-ai/dsh-tools 0.2.1-rc.2 的语义子集）。
 *
 * 为什么要本地化：宿主里 dsh-tools 存在，但本插件是 `link:` 挂在 profile 的
 * node_modules 之外，ESM 裸导入按目录逐级上找 node_modules 找不到它
 * （装机实证同 dsh-browser-control：ERR_MODULE_NOT_FOUND）。把它声明成依赖也不通
 * —— dsh-tools 及其 peer 全在宿主 plugin-manager 的 protectedModules 名单里。
 *
 * 覆盖本插件用到的全部语义：type=string/number/integer/boolean/array/object、
 * required、enum、items、properties、additionalProperties。校验失败抛普通 Error
 * （等价 dsh-tools 的 ToolArgsError：无效输入变成普通错误结果，不中止回合）。
 */

function specToJsonSchema(spec) {
  const properties = {}
  const required = []
  for (const [key, p] of Object.entries(spec ?? {})) {
    properties[key] = {
      ...(p.type === undefined ? {} : { type: p.type }),
      ...(p.enum === undefined ? {} : { enum: p.enum }),
      ...(p.description === undefined ? {} : { description: p.description }),
      ...(p.items === undefined ? {} : { items: specToJsonSchemaInner(p.items) }),
    }
    if (p.required) required.push(key)
  }
  const schema = { type: 'object', properties }
  if (required.length > 0) schema.required = required
  schema.additionalProperties = false
  return schema
}

function specToJsonSchemaInner(p) {
  if (p.type === 'object') {
    const nested = { type: 'object' }
    if (p.properties !== undefined) {
      const inner = specToJsonSchema(p.properties)
      nested.properties = inner.properties
      if (inner.required !== undefined) nested.required = inner.required
    }
    nested.additionalProperties = p.additionalProperties ?? false
    return nested
  }
  const out = { ...(p.type === undefined ? {} : { type: p.type }) }
  if (p.enum !== undefined) out.enum = p.enum
  if (p.description !== undefined) out.description = p.description
  if (p.items !== undefined) out.items = specToJsonSchemaInner(p.items)
  return out
}

const TYPE_OF = (v) => (typeof v === 'number' && Number.isFinite(v) ? 'number'
  : Number.isInteger(v) ? 'integer'
  : typeof v === 'string' ? 'string'
  : typeof v === 'boolean' ? 'boolean'
  : Array.isArray(v) ? 'array'
  : v !== null && typeof v === 'object' ? 'object'
  : undefined)

function typeOk(actual, expected) {
  if (expected === 'number') return actual === 'number' || actual === 'integer'
  if (expected === 'integer') return actual === 'integer'
  return actual === expected
}

function validateValue(schema, value, where, bad) {
  if (schema.type !== undefined && !typeOk(TYPE_OF(value), schema.type)) {
    bad.push(`${where} 需要 ${schema.type}`)
    return
  }
  if (schema.enum !== undefined && !schema.enum.includes(value)) {
    bad.push(`${where} 必须是 ${schema.enum.join('|')} 之一`)
  }
  if (Array.isArray(value) && schema.items !== undefined) {
    value.forEach((item, i) => validateValue(schema.items, item, `${where}[${String(i)}]`, bad))
  }
  if (schema.type === 'object' && value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) {
      const sub = schema.properties?.[k]
      if (sub === undefined) {
        if (schema.additionalProperties !== true) bad.push(`${where} 含未知字段 ${k}`)
        continue
      }
      validateValue(sub, v, `${where}.${k}`, bad)
    }
    for (const k of schema.required ?? []) {
      if (value[k] === undefined) bad.push(`${where} 缺少必填字段 ${k}`)
    }
  }
}

function validate(parameters, args) {
  const bad = []
  const a = args ?? {}
  for (const key of parameters.required ?? []) {
    if (a[key] === undefined) bad.push(`缺少必填参数 ${key}`)
  }
  for (const [key, value] of Object.entries(a)) {
    const p = parameters.properties?.[key]
    if (p === undefined) {
      bad.push(`未知参数 ${key}`)
      continue
    }
    validateValue(p, value, key, bad)
  }
  return bad
}

export function defineTool(options) {
  if (options.output?.render === undefined) throw new Error(`defineTool(${options.name}): 需要 output.render`)
  const parameters = specToJsonSchema(options.parameters)
  const userRender = options.output.render
  const userExecute = options.execute
  return {
    name: options.name,
    description: options.description,
    parameters,
    output: {
      schema: options.output.schema ?? { type: 'object' },
      render: (args, value) => userRender(args, value),
    },
    async execute(args, exec) {
      const violations = validate(parameters, args)
      if (violations.length > 0) throw new Error(`无效参数：${violations.join('；')}`)
      return userExecute(args, exec)
    },
  }
}
