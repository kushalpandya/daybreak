export type SectionStatus = "ok" | "partial" | "error" | "skipped";

export interface SectionError {
  code: string;
  message: string;
}

export interface SectionResult<T> {
  status: SectionStatus;
  collectedAt: string;
  durationMs: number;
  data: T | null;
  warnings: string[];
  error?: SectionError;
}

export interface TimeWindow {
  start: string;
  end: string;
}

export interface RunContext {
  id: string;
  startedAt: string;
  reportingTime: string;
  reportingDate: string;
  timezone: string;
  windows: {
    mail: TimeWindow;
    calendar: TimeWindow;
    github: TimeWindow;
  };
}

export interface BriefOutput {
  schemaVersion: 1;
  run: RunContext & { completedAt: string };
  weather: SectionResult<unknown>;
  mail: SectionResult<unknown>;
  calendar: SectionResult<unknown>;
  github: SectionResult<unknown>;
  gitlab: SectionResult<unknown>;
}

export interface PreflightCheck {
  integration: string;
  target?: string;
  status: "ok" | "error";
  message: string;
  version?: string;
}

export interface PreflightReport {
  status: "ok" | "error";
  checks: PreflightCheck[];
}

export function skippedSection(): SectionResult<never> {
  return {
    status: "skipped",
    collectedAt: new Date().toISOString(),
    durationMs: 0,
    data: null,
    warnings: [],
  };
}

export async function collectSection<T>(
  code: string,
  collector: () => Promise<{ data: T; warnings?: string[]; partial?: boolean }>,
): Promise<SectionResult<T>> {
  const started = performance.now();
  try {
    const result = await collector();
    return {
      status: result.partial ? "partial" : "ok",
      collectedAt: new Date().toISOString(),
      durationMs: Math.round(performance.now() - started),
      data: result.data,
      warnings: result.warnings ?? [],
    };
  } catch (error) {
    return {
      status: "error",
      collectedAt: new Date().toISOString(),
      durationMs: Math.round(performance.now() - started),
      data: null,
      warnings: [],
      error: {
        code,
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}
