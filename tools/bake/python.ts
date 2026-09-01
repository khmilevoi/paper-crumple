/**
 * Running the bake tools' Python from a Vitest test (spec 11, 13).
 *
 * `pack.py` is pure Python by its own header and the fixture check needs no Blender, so the
 * cross-language contract can be asserted at level 1 — but only if a test can find an
 * interpreter. Nothing here throws: a missing interpreter is an `Error` value, and the test
 * that receives it fails loudly rather than skipping, because a skipped cross-language check
 * is the tier not running at all.
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/** The repository root, which every path passed to Python is relative to. */
export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))

/** Tried in order when `$PYTHON` is unset. */
const CANDIDATES = ['python3', 'python'] as const

/**
 * The interpreter to run: `$PYTHON` when set, else the first candidate that answers `-V` with a
 * Python 3 banner. The banner check is what rejects Windows' App Execution Alias stub, which
 * exists on PATH as `python3.exe`, prints a Store advertisement and exits non-zero.
 */
export function pythonExecutable(env: NodeJS.ProcessEnv = process.env): Error | string {
  const explicit = env.PYTHON?.trim()
  const candidates = explicit ? [explicit] : [...CANDIDATES]
  let lastFailure: Error | undefined
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['-V'], { encoding: 'utf8' })
    const banner = `${probe.stdout}${probe.stderr}`.trim()
    // Python 2 printed the banner on stderr; check both rather than assume.
    if (!probe.error && probe.status === 0 && /^Python 3\./.test(banner)) return candidate
    lastFailure =
      probe.error ??
      new Error(`${candidate} -V exited ${String(probe.status)}: ${banner || '(no output)'}`)
  }
  return new Error(
    `no Python 3 interpreter found (tried ${candidates.join(', ')}). ` +
      'Set PYTHON=<path to python> — tools/bake/pack.py is the reference pack writer and its ' +
      'cross-language fixture check is level 1 (spec 11).',
    { cause: lastFailure },
  )
}

/** One finished Python process. */
export interface PythonRun {
  readonly status: number
  readonly stdout: string
  readonly stderr: string
}

/**
 * Runs Python from the repository root with bytecode writing off, so a test leaves no
 * `__pycache__` behind. `args` are passed after `-B`.
 */
export function runPython(args: readonly string[], cwd: string = REPO_ROOT): Error | PythonRun {
  const exe = pythonExecutable()
  if (exe instanceof Error) return exe
  const result = spawnSync(exe, ['-B', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  })
  if (result.error) {
    return new Error(`python ${args.join(' ')}: ${result.error.message}`, { cause: result.error })
  }
  if (result.status === null) {
    return new Error(`python ${args.join(' ')} was killed by ${String(result.signal)}`)
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}
