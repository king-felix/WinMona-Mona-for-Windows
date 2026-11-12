import { spawn } from 'node:child_process';

export type CliResult<T> = { ok: true; value: T } | { ok: false; detail: string };

/**
 * Minimal, bounded wrapper around the engine's own configuration CLI. The CLI
 * is authoritative for config.toml: it preserves unknown keys and applies the
 * engine's own validation. Mona never edits config.toml by hand.
 */
export class EngineConfigCli {
  private readonly executable: string;
  private readonly timeoutMs: number;
  private readonly env: NodeJS.ProcessEnv;

  constructor(options: { executable: string; timeoutMs?: number; env?: NodeJS.ProcessEnv }) {
    this.executable = options.executable;
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.env = options.env ?? process.env;
  }

  async path(): Promise<CliResult<string>> {
    return await this.run(['config', 'path']);
  }

  async get(key: string): Promise<CliResult<string | null>> {
    const result = await this.run(['config', 'get', key]);
    if (!result.ok) {
      if (/key not found/i.test(result.detail)) return { ok: true, value: null };
      return result;
    }
    return { ok: true, value: result.value.trim() };
  }

  async set(key: string, value: string): Promise<CliResult<string>> {
    return await this.run(['config', 'set', key, value]);
  }

  async doctorJson(): Promise<CliResult<unknown>> {
    const result = await this.run(['doctor', '--json']);
    if (!result.ok) return result;
    try {
      return { ok: true, value: JSON.parse(result.value) as unknown };
    } catch {
      return { ok: false, detail: 'doctor --json did not return JSON' };
    }
  }

  private async run(args: string[]): Promise<CliResult<string>> {
    return await new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      const finish = (result: CliResult<string>): void => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      const child = spawn(this.executable, args, {
        env: this.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      const timer = setTimeout(() => {
        child.kill();
        finish({ ok: false, detail: `engine ${args.join(' ')} timed out after ${this.timeoutMs} ms` });
      }, this.timeoutMs);
      const append = (target: 'stdout' | 'stderr', chunk: Buffer): void => {
        const text = chunk.toString('utf8');
        if (target === 'stdout') {
          if (stdout.length < 1_000_000) stdout += text;
        } else if (stderr.length < 1_000_000) {
          stderr += text;
        }
      };
      child.stdout?.on('data', (chunk: Buffer) => append('stdout', chunk));
      child.stderr?.on('data', (chunk: Buffer) => append('stderr', chunk));
      child.on('error', (error) => {
        clearTimeout(timer);
        finish({ ok: false, detail: `engine could not start: ${error.message.slice(0, 300)}` });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) finish({ ok: true, value: stdout });
        else {
          // The engine prints usage notices on stderr even on success. Only a
          // non-zero exit is treated as failure; keep the tail, no secrets.
          finish({ ok: false, detail: (stderr || stdout).slice(-1_200) || `exit code ${code ?? 'unknown'}` });
        }
      });
    });
  }
}
