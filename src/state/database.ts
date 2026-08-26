import { DatabaseSync } from "node:sqlite";
import { dirname } from "@std/path";

export interface RepositorySnapshot {
  repository: string;
  stars: number;
  releaseDownloads: number;
  recordedAt: string;
}

export class StateDatabase {
  readonly #db: DatabaseSync;
  readonly #previousStatement;
  readonly #saveStatement;

  constructor(path: string) {
    if (path !== ":memory:") Deno.mkdirSync(dirname(path), { recursive: true });
    this.#db = new DatabaseSync(path);
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS repository_snapshots (
        repository TEXT NOT NULL,
        stars INTEGER NOT NULL,
        release_downloads INTEGER NOT NULL,
        recorded_at TEXT NOT NULL,
        PRIMARY KEY (repository, recorded_at)
      );
      CREATE INDEX IF NOT EXISTS repository_snapshots_lookup
        ON repository_snapshots(repository, recorded_at DESC);
    `);
    this.#previousStatement = this.#db.prepare(`
      SELECT repository, stars, release_downloads AS releaseDownloads,
             recorded_at AS recordedAt
      FROM repository_snapshots
      WHERE repository = ? AND recorded_at <= ?
      ORDER BY recorded_at DESC
      LIMIT 1
    `);
    this.#saveStatement = this.#db.prepare(`
      INSERT OR REPLACE INTO repository_snapshots
        (repository, stars, release_downloads, recorded_at)
      VALUES (?, ?, ?, ?)
    `);
  }

  previousSnapshot(repository: string, atOrBefore: string): RepositorySnapshot | null {
    const row = this.#previousStatement.get(repository, atOrBefore) as
      | RepositorySnapshot
      | undefined;
    return row ?? null;
  }

  saveSnapshot(snapshot: RepositorySnapshot): void {
    this.#saveStatement.run(
      snapshot.repository,
      snapshot.stars,
      snapshot.releaseDownloads,
      snapshot.recordedAt,
    );
  }

  close(): void {
    this.#db.close();
  }
}
