/**
 * Browser globals supplied by the DSH client module loader.
 * The factory receives `require`, which resolves React from the host table.
 */
interface DshModuleLoader {
  load(spec: {
    id: string
    factory(require: (id: string) => any): unknown
  }): void
}

interface Window {
  __ModuleLoader__: DshModuleLoader
}
