import fs from 'node:fs';
import path from 'node:path';

/**
 * Resolve the Codewhale executable Mona may start. Only an explicit,
 * user-controlled path or a discovered installed binary is used; Mona never
 * probes the network to find one. An empty result is reported as an actionable
 * "missing executable" state rather than a silent fallback.
 */
export function resolveEngineExecutable(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.MONA_ENGINE_EXECUTABLE ?? env.MONA_ENGINE;
  if (explicit && explicit.trim()) return explicit.trim();
  if (process.platform !== 'win32') return 'codewhale';
  const candidates = [
    env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', 'codewhale.exe') : null,
    env.ProgramFiles ? path.join(env.ProgramFiles, 'Codewhale', 'codewhale.exe') : null,
    env.USERPROFILE ? path.join(env.USERPROFILE, '.codewhale', 'bin', 'codewhale.exe') : null,
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return candidates[0] ?? 'codewhale.exe';
}
