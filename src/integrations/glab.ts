import { CommandError, commandJson, runCommand } from "./command.ts";
import { ConcurrencyLimiter } from "../utils.ts";

const limiter = new ConcurrencyLimiter(6);

export function glabApi<T>(
  endpoint: string,
  host: string,
  options: { paginate?: boolean } = {},
): Promise<T> {
  const args = ["api", endpoint, "--hostname", host];
  if (!options.paginate) {
    return limiter.run(() => commandJson<T>("glab", { args, timeoutMs: 120_000 }));
  }
  args.push("--paginate", "--output", "ndjson");
  return limiter.run(() => runCommand("glab", { args, timeoutMs: 120_000 })).then((result) => {
    if (result.code !== 0) {
      throw new CommandError("glab API request failed", "glab", result.code, result.stderr);
    }
    if (!result.stdout) return [] as T;
    try {
      return result.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line)) as T;
    } catch {
      throw new CommandError("glab: returned invalid NDJSON", "glab", result.code, result.stderr);
    }
  });
}
