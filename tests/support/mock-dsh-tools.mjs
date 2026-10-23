/**
 * 没有 DSH 安装时的 @deepseek-ai/dsh-tools 契约替身。
 *
 * 目的不是"假装有宿主"，而是让工具层（参数/输出 schema、渲染、错误映射）在没有 DSH 的 CI 上也能被测。
 * 它实现了与真实包一致的**受支持 schema 子集**校验规则，因此 schema 写错会在这里失败。
 */
const ALLOWED_KEYWORDS = new Set([
  'type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const',
  'description', 'title', 'default', 'examples',
])
const SCALAR_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'null'])
const ANNOTATION_KEYS = ['description', 'title', 'default', 'examples']

function fail(message) {
  throw new Error('mock dsh-tools: ' + message)
}

/** 与真实实现同规则：受支持子集之外的写法一律拒绝。 */
export function assertSupportedJsonSchema(schema, path = 'schema') {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) fail(path + ' 必须是对象')
  for (const key of Object.keys(schema)) {
    if (!ALLOWED_KEYWORDS.has(key)) fail(path + ' 含不支持的关键字: ' + key)
  }
  if ('oneOf' in schema) {
    if (Object.hasOwn(schema, 'type')) fail(path + ' 不能同时声明 type 与 oneOf')
    if (!Array.isArray(schema.oneOf) || schema.oneOf.length < 2) fail(path + '.oneOf 至少两个分支')
    schema.oneOf.forEach((node, index) => assertSupportedJsonSchema(node, path + '.oneOf[' + index + ']'))
    return
  }
  const type = schema.type
  if (type === 'object') {
    if (typeof schema.additionalProperties !== 'boolean') fail(path + '.additionalProperties 必须显式 true/false')
    if (schema.properties !== undefined) {
      if (typeof schema.properties !== 'object') fail(path + '.properties 必须是对象')
      for (const [name, node] of Object.entries(schema.properties)) {
        const { required, ...rest } = node
        if (required !== undefined && typeof required !== 'boolean') fail(path + '.properties.' + name + '.required 必须是布尔')
        assertSupportedJsonSchema(rest, path + '.properties.' + name)
      }
    }
    if (schema.required !== undefined && !Array.isArray(schema.required)) fail(path + '.required 必须是数组')
    return
  }
  if (type === 'array') {
    if (schema.items !== undefined) assertSupportedJsonSchema(schema.items, path + '.items')
    return
  }
  if (type === 'json') return
  if (!SCALAR_TYPES.has(type)) fail(path + '.type 不支持: ' + String(type))
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length === 0)) fail(path + '.enum 必须是非空数组')
}

function compileParameters(parameters) {
  const properties = {}
  const required = []
  for (const [name, spec] of Object.entries(parameters ?? {})) {
    const { required: isRequired, ...rest } = spec
    if (isRequired === true) required.push(name)
    assertSupportedJsonSchema({ ...rest, type: rest.type }, 'parameters.' + name)
    properties[name] = { type: rest.type, ...(rest.enum === undefined ? {} : { enum: rest.enum }), ...(rest.items === undefined ? {} : { items: rest.items }) }
  }
  return { type: 'object', properties, ...(required.length === 0 ? {} : { required }) }
}

/** 与真实 defineTool 同形：返回带 execute/output.render 的定义，并做参数/输出校验。 */
export function defineTool(options) {
  if (typeof options?.name !== 'string' || options.name === '') fail('工具缺少 name')
  if (typeof options.description !== 'string' || options.description === '') fail(options.name + ' 缺少 description')
  const parameterSchema = compileParameters(options.parameters)
  assertSupportedJsonSchema(options.output.schema, options.name + '.output.schema')
  if (typeof options.output.render !== 'function') fail(options.name + ' 缺少 output.render')
  const validate = (args) => {
    for (const key of parameterSchema.required ?? []) {
      if (args?.[key] === undefined) throw new Error('invalid arguments: missing required property "' + key + '"')
    }
  }
  return {
    name: options.name,
    description: options.description,
    parameters: parameterSchema,
    output: { schema: options.output.schema, render: options.output.render },
    async execute(args, exec) {
      validate(args)
      return options.execute(args, exec)
    },
  }
}

export function validateArgs(parameters, args) {
  return []
}

export function parameterSchemaSpecToJsonSchema(parameters) {
  return compileParameters(parameters)
}

export default { defineTool, assertSupportedJsonSchema }
