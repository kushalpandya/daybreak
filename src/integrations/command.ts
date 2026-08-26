export interface CommandOptions {
  args?: string[];
  env?: Record<string, string>;
  timeoutMs?: number;
  stdin?: string;
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export class CommandError extends Error {
  constructor(
    message: string,
    public readonly command: string,
    public readonly code: number,
    public readonly stderr: string,
  ) {
    super(message);
    this.name = "CommandError";
  }
}

export async function runCommand(
  command: string,
  options: CommandOptions = {},
): Promise<CommandResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 60_000);
  try {
    const child = new Deno.Command(command, {
      args: options.args ?? [],
      env: options.env,
      stdin: options.stdin === undefined ? "null" : "piped",
      stdout: "piped",
      stderr: "piped",
      signal: controller.signal,
    }).spawn();
    if (options.stdin !== undefined && child.stdin) {
      const writer = child.stdin.getWriter();
      await writer.write(new TextEncoder().encode(options.stdin));
      await writer.close();
    }
    const output = await child.output();
    return {
      code: output.code,
      stdout: new TextDecoder().decode(output.stdout).trim(),
      stderr: new TextDecoder().decode(output.stderr).trim(),
    };
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new CommandError(`${command}: command not found`, command, 127, "");
    }
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new CommandError(`${command}: command timed out`, command, 124, "");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function commandJson<T>(command: string, options: CommandOptions = {}): Promise<T> {
  const result = await runCommand(command, options);
  if (result.code !== 0) {
    throw new CommandError(
      conciseCommandError(command, result.stderr, result.stdout),
      command,
      result.code,
      result.stderr,
    );
  }
  try {
    return JSON.parse(result.stdout) as T;
  } catch {
    throw new CommandError(
      `${command}: returned invalid JSON`,
      command,
      result.code,
      result.stderr,
    );
  }
}

function conciseCommandError(command: string, stderr: string, stdout: string): string {
  const source = stderr || stdout || `exited with a nonzero status`;
  const line = source.split("\n").find((line) => line.trim() !== "")?.trim() ?? source;
  return `${command}: ${line}`;
}
