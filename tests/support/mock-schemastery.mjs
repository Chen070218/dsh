/**
 * 没有 DSH 安装时的 @deepseek-ai/schemastery 契约替身。
 *
 * 工具层测试会经由 lib/index.js 间接用到 Config schema，因此它必须能在离线环境构造并**真的校验**。
 * 只实现本项目用到的子集：object / string / number / natural / boolean / array / union，
 * 外加 default / description / min / max。元数据用普通属性保存（跨模块实例也可靠）。
 */
const META_KEY = '__mockSchemastery'

function make(kind, options) {
  const schema = (input) => {
    const value = kind === 'object' ? applyDefaults(input ?? {}, options.shape) : (input === undefined ? options.def : input)
    validate(schema, value, '')
    return value
  }
  schema[META_KEY] = { kind, options }
  const clone = (patch) => make(kind, { ...options, ...patch })
  schema.default = (value) => clone({ def: value })
  schema.description = () => schema
  schema.min = (value) => clone({ min: value })
  schema.max = (value) => clone({ max: value })
  return schema
}

const meta = (schema) => (typeof schema === 'function' ? schema[META_KEY] : undefined)

function applyDefaults(input, shape) {
  const output = { ...input }
  for (const [key, schema] of Object.entries(shape ?? {})) {
    if (output[key] !== undefined) continue
    const def = meta(schema)?.options?.def
    if (def !== undefined) output[key] = typeof def === 'function' ? def() : def
  }
  return output
}

function kindOf(value) {
  if (Array.isArray(value)) return 'array'
  if (value === null) return 'null'
  return typeof value
}

function validate(schema, value, path) {
  const info = meta(schema)
  if (info === undefined) throw new Error('mock-schemastery: 非 schema 值（' + path + '）')
  const { kind, options } = info
  const at = path === '' ? '$' : '$' + path

  if (kind === 'object') {
    if (kindOf(value) !== 'object') throw new Error(at + ' 应为对象，收到 ' + kindOf(value))
    for (const [key, child] of Object.entries(options.shape ?? {})) {
      if (value[key] === undefined) continue
      validate(child, value[key], path + '.' + key)
    }
    return
  }
  if (kind === 'array') {
    if (!Array.isArray(value)) throw new Error(at + ' 应为数组，收到 ' + kindOf(value))
    value.forEach((item, index) => validate(options.inner, item, path + '[' + index + ']'))
    return
  }
  if (kind === 'union') {
    if (!options.values.includes(value)) throw new Error(at + ' 应为 ' + options.values.join('/') + '，收到 ' + JSON.stringify(value))
    return
  }
  if (kind === 'natural') {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) throw new Error(at + ' 应为非负整数，收到 ' + JSON.stringify(value))
  } else if (kindOf(value) !== kind) {
    throw new Error(at + ' 应为 ' + kind + '，收到 ' + kindOf(value))
  }
  if (options.min !== undefined && value < options.min) throw new Error(at + ' 应 >= ' + options.min + '，收到 ' + value)
  if (options.max !== undefined && value > options.max) throw new Error(at + ' 应 <= ' + options.max + '，收到 ' + value)
}

const Schema = {
  object: (shape) => make('object', { shape }),
  string: () => make('string', {}),
  number: () => make('number', {}),
  natural: () => make('natural', {}),
  boolean: () => make('boolean', {}),
  array: (inner) => make('array', { inner }),
  union: (values) => make('union', { values: [...values] }),
}

export { Schema }
export default Schema
