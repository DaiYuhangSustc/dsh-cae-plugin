/**
 * dsh-cae: natural-language-driven CAE pipeline for DeepSeek Harness.
 * Registers nine stage tools (structural + CFD chains) on `ctx.tools`; domain work runs in bundled
 * Python modules via one-shot subprocesses. Spec: docs/specs.
 * @module dsh-cae
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Config } from './config.js'
import { defineCaeStepImportTool } from './tools/step-import.js'
import { defineCaeCadTool } from './tools/cad.js'
import { defineCaeMeshTool } from './tools/mesh.js'
import { defineCaeSolveTool } from './tools/solve.js'
import { defineCaePostTool } from './tools/post.js'
import { defineCaeCfdMeshTool } from './tools/cfd-mesh.js'
import { defineCaeCfdSteadyTool } from './tools/cfd-steady.js'
import { defineCaeCfdTransientTool } from './tools/cfd-transient.js'

export const name = 'dsh-cae'
export const inject = ['tools']

export { Config } from './config.js'

/**
 * Register the six CAE stage tools (structural + CFD chains) on the tool registry.
 * @param ctx - registrant context carrying the tool registry.
 * @param config - deployment configuration.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.tools.register(defineCaeStepImportTool(config))
  ctx.tools.register(defineCaeCadTool(config))
  ctx.tools.register(defineCaeMeshTool(config))
  ctx.tools.register(defineCaeSolveTool(config))
  ctx.tools.register(defineCaePostTool(config))
  ctx.tools.register(defineCaeCfdMeshTool(config))
  ctx.tools.register(defineCaeCfdSteadyTool(config))
  ctx.tools.register(defineCaeCfdTransientTool(config))
}
