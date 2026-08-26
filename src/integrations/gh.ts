import { commandJson } from "./command.ts";

export function ghApi<T>(endpoint: string, fields: Record<string, string> = {}): Promise<T> {
  const args = ["api", endpoint];
  for (const [key, value] of Object.entries(fields)) args.push("-f", `${key}=${value}`);
  return commandJson<T>("gh", { args, timeoutMs: 120_000 });
}

export function ghGraphql<T>(
  query: string,
  variables: Record<string, string | number> = {},
): Promise<T> {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [key, value] of Object.entries(variables)) {
    args.push(typeof value === "number" ? "-F" : "-f", `${key}=${value}`);
  }
  return commandJson<T>("gh", { args, timeoutMs: 120_000 });
}

export async function ghPaginated<T>(endpoint: string): Promise<T[]> {
  const pages = await commandJson<T[][]>("gh", {
    args: ["api", endpoint, "--paginate", "--slurp"],
    timeoutMs: 120_000,
  });
  return pages.flat();
}

export function ghList<T>(endpoint: string): Promise<T[]> {
  return commandJson<T[]>("gh", { args: ["api", endpoint], timeoutMs: 120_000 });
}
