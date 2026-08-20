/**
 * Minimal type shims for the dsh peer packages. These packages resolve at
 * runtime from the dsh installation's shared instance; the shims only give
 * the type checker the small surface this package actually uses (they are
 * erased at build time and never shipped).
 */

declare module '@deepseek-ai/cordis' {
  export interface Context {
    get(name: string): unknown
    [key: string]: unknown
  }

  export class Service<T = never> {
    protected readonly ctx: Context
    readonly name: string
    constructor(ctx: Context, name?: string)
  }

  export class Plugin {
    constructor(ctx: Context)
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  import type { Context, Service } from '@deepseek-ai/cordis'

  export class TypertRemoteService<T = never> extends Service<T> {
    readonly typertRemote: { service: this; serviceKey: string; namespace: string }
    protected constructor(ctx: Context, serviceKey: string)
  }

  export function Remote(methodOrExportName: string): <This extends object, Args extends unknown[], Result>(
    method: (this: This, ...args: Args) => Result,
    context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Result>,
  ) => void

  export interface TypertSchema<Output = unknown> {
    parse(value: unknown): Output
  }

  export type TypertCodec =
    | { mode: 'strict'; typeSymbol: string; schema: TypertSchema }
    | { mode: 'src-json' }

  export interface InvocationParameterDescriptor {
    name: string
    wire: string
    source: 'json' | 'lookup'
    lookup?: string
    codec: TypertCodec
    acceptsUndefined?: true
  }

  export interface InvocationDescriptor {
    id: string
    service: string
    namespace: string
    method: string
    implementation?: string
    invocation: { kind: 'direct' } | { kind: 'context'; context: string; wire: string; codec: TypertCodec }
    parameters: InvocationParameterDescriptor[]
    result: TypertCodec
    cancellation?: { parameter: 'signal' }
    scope?: { context: string; wire: string }
  }

  export interface RemoteFailure {
    code: string
    message: string
    details: object
  }

  export type RemoteResult<T> =
    | { ok: true; value: T }
    | { ok: false; error: RemoteFailure }

  export interface TypertRemoteContribution {
    package: string
    descriptors: InvocationDescriptor[]
  }

  export type TypertRemoteNamespace<Namespace extends string> = Record<string, never>

  export interface TypertRemoteMap {}

  export interface TypertRemoteNamespaceMap {}

  export interface TypertClientRemote {
    $mount(contribution: TypertRemoteContribution): Promise<() => Promise<void>>
    $on(event: string, listener: (...args: never[]) => void): () => void
    $dispatch(event: string, args: readonly unknown[]): void
  }
}

declare module '*.json' {
  const value: unknown
  export default value
}
