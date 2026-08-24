import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

/** Deployment configuration for the CAE tool set. */
export interface Config {
  /** Interpreter that has build123d, gmsh, pyvista, meshio importable (CalculiX `ccx` on PATH). */
  python: string
  /** Directory (relative to the agent cwd) holding all CAE artifacts. */
  workdir: string
  /** Per-stage wall-clock budget in ms; exceeded kills the stage process group. */
  stageTimeoutMs: number
  /** Absolute path to an OpenFOAM etc/bashrc; omit to auto-detect ($FOAM_BASHRC, /opt/openfoam*, /usr/lib/openfoam*). */
  openfoamBashrc?: string | null
}

/** Schemastery configuration for the dsh-cae bundle. */
export const Config: z<Config> = z.object({
  python: z.string().default('python3').description('Interpreter with build123d/gmsh/pyvista/meshio installed'),
  workdir: z.string().default('./cae').description('Artifact directory for STEP/MSH/INP/FRD/VTU/PNG and CFD case files'),
  stageTimeoutMs: z.number().default(600000).description('Per-stage timeout in milliseconds'),
  openfoamBashrc: z.string().description('OpenFOAM etc/bashrc path; omit to auto-detect ($FOAM_BASHRC, /opt/openfoam*, /usr/lib/openfoam*)'),
})

/** Plugin context type re-export so tool modules need one import site. */
export type PluginContext = Context
