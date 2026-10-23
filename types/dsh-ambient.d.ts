/**
 * DSH 宿主包的模块声明。
 *
 * 为什么需要：DSH 发布产物里没有附带 @deepseek-ai/* 的 .d.ts（package.json 指向的 lib/types 目录不存在），
 * 所以本地/CI 的 tsc 无法从 node_modules 解析这些包。这里按宿主源码里核实过的签名提供最小声明，
 * 只覆盖本项目实际使用的 API；真实宿主在运行时仍用真实实现。
 */
declare module '@deepseek-ai/dsh-tools' {
  export interface ParameterSpec {
    type: 'string' | 'number' | 'integer' | 'boolean' | 'null' | 'array' | 'object' | 'json' | 'oneOf'
    required?: boolean
    description?: string
    enum?: readonly string[]
    items?: ParameterSpec | Record<string, unknown>
    properties?: Record<string, ParameterSpec>
    additionalProperties?: boolean
    oneOf?: readonly ParameterSpec[]
    const?: unknown
    title?: string
    default?: unknown
    examples?: readonly unknown[]
  }

  export interface ToolContent {
    type: 'text'
    text: string
  }

  export interface ToolExecutionContext {
    signal: AbortSignal
    agent?: { session?: { header?: { cwd?: string } } }
  }

  export interface ToolOutputSpec<T> {
    schema: Record<string, unknown>
    render: (args: Record<string, unknown>, value: T) => ToolContent[]
    presentationMeta?: (args: Record<string, unknown>, value: T) => unknown
  }

  export interface ToolDefinition<A = Record<string, unknown>, R = unknown> {
    name: string
    description: string
    parameters: Record<string, unknown>
    output: { schema: Record<string, unknown>; render: (args: A, value: R) => ToolContent[] }
    execute: (args: A, exec: ToolExecutionContext) => Promise<R>
  }

  export interface DefineToolOptions<A, R> {
    name: string
    description: string
    parameters: Record<string, ParameterSpec>
    output: ToolOutputSpec<R>
    isConcurrencySafe?: () => boolean
    timeoutMs?: number
    deferLoading?: boolean
    execute: (args: A, exec: ToolExecutionContext) => Promise<R>
    finalizeContent?: (exec: ToolExecutionContext, result: unknown) => unknown
    projectContent?: (exec: ToolExecutionContext, result: unknown) => unknown
    presentCall?: (args: A) => unknown
    presentResult?: (args: A, value: R) => unknown
  }

  export function defineTool<A = any, R = any>(options: DefineToolOptions<A, R>): ToolDefinition<A, R>
  export function assertSupportedJsonSchema(schema: unknown): void
  export function assertObjectJsonSchema(schema: unknown): void
  export function validateArgs(parameters: Record<string, ParameterSpec>, args: unknown): string[]
  export function parameterSchemaSpecToJsonSchema(parameters: Record<string, ParameterSpec>): Record<string, unknown>
  export class ToolArgsError extends Error {}
  export class ToolOutputError extends Error {}
}

declare module '@deepseek-ai/cordis' {
  export class Context {
    constructor(parent?: Context)
    plugin(plugin: unknown, config?: unknown): void
    effect(callback: () => () => void, label?: string): unknown
    on(event: string, listener: (...args: unknown[]) => void): unknown
    dispose(): void
    [key: string]: unknown
  }
  export class Service {
    constructor(ctx: Context, name: string)
  }
}

declare module '@deepseek-ai/schemastery' {
  export interface Schema<T = unknown> {
    (value?: unknown): T
    default(value: unknown): Schema<T>
    description(text: string): Schema<T>
    min(value: number): Schema<T>
    max(value: number): Schema<T>
  }
  export interface SchemaStatic {
    object(shape: Record<string, Schema<unknown>>): Schema<Record<string, unknown>>
    string(): Schema<string>
    number(): Schema<number>
    natural(): Schema<number>
    boolean(): Schema<boolean>
    array(inner: Schema<unknown>): Schema<unknown[]>
    union(values: readonly string[]): Schema<string>
  }
  const Schema: SchemaStatic
  export default Schema
}
