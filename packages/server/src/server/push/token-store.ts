import { existsSync, readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import type pino from "pino";
import { z } from "zod";
import { hasLegacyImportMarker, recordLegacyImportMarker } from "../db/legacy-imports.js";
import { runInTransaction } from "../db/transaction.js";
import { ensurePrivateFile } from "../private-files.js";

const LEGACY_IMPORT_STORE = "push_tokens";
const PushTokenRecordSchema = z.object({
  token: z.string().trim().min(1),
});

interface PushTokenStoreOptions {
  database: DatabaseSync;
  legacyFilePath: string;
  logger: pino.Logger;
}

interface PushTokenRow {
  payload: string;
}

/** Store for Expo push tokens. */
export class PushTokenStore {
  private readonly database: DatabaseSync;
  private readonly logger: pino.Logger;
  private readonly legacyFilePath: string;

  constructor(options: PushTokenStoreOptions) {
    this.database = options.database;
    this.logger = options.logger.child({ component: "token-store" });
    this.legacyFilePath = options.legacyFilePath;
    this.importLegacyTokens();
  }

  addToken(token: string): void {
    const parsed = PushTokenRecordSchema.safeParse({ token });
    if (!parsed.success) {
      return;
    }
    const result = this.database
      .prepare("INSERT OR IGNORE INTO push_tokens (token, payload) VALUES (?, ?)")
      .run(parsed.data.token, JSON.stringify(parsed.data));
    if (result.changes > 0) {
      this.logger.debug({ total: this.count() }, "Added token");
    }
  }

  removeToken(token: string): void {
    const normalized = token.trim();
    if (!normalized) {
      return;
    }
    const result = this.database.prepare("DELETE FROM push_tokens WHERE token = ?").run(normalized);
    if (result.changes > 0) {
      this.logger.debug({ total: this.count() }, "Removed token");
    }
  }

  getAllTokens(): string[] {
    const rows = this.database
      .prepare("SELECT payload FROM push_tokens ORDER BY rowid")
      .all() as unknown as PushTokenRow[];
    return rows.map((row) => PushTokenRecordSchema.parse(JSON.parse(row.payload)).token);
  }

  private count(): number {
    const row = this.database.prepare("SELECT count(*) AS count FROM push_tokens").get() as {
      count: number;
    };
    return row.count;
  }

  private importLegacyTokens(): void {
    if (hasLegacyImportMarker(this.database, LEGACY_IMPORT_STORE)) {
      return;
    }

    try {
      runInTransaction(this.database, () => {
        let importedCount = 0;
        let skippedCount = 0;
        if (this.count() === 0 && existsSync(this.legacyFilePath)) {
          ensurePrivateFile(this.legacyFilePath);
          const raw = readFileSync(this.legacyFilePath, "utf-8");
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw);
          } catch (error) {
            this.logger.warn(
              { err: error, filePath: this.legacyFilePath },
              "Skipping invalid legacy push token file",
            );
            skippedCount += 1;
          }

          const tokens =
            parsed &&
            typeof parsed === "object" &&
            Array.isArray((parsed as { tokens?: unknown }).tokens)
              ? (parsed as { tokens: unknown[] }).tokens
              : [];
          for (const token of tokens) {
            const record = PushTokenRecordSchema.safeParse({ token });
            if (!record.success) {
              skippedCount += 1;
              this.logger.warn(
                { filePath: this.legacyFilePath, err: record.error },
                "Skipping invalid legacy push token",
              );
              continue;
            }
            const result = this.database
              .prepare("INSERT OR IGNORE INTO push_tokens (token, payload) VALUES (?, ?)")
              .run(record.data.token, JSON.stringify(record.data));
            importedCount += Number(result.changes);
          }
        }
        recordLegacyImportMarker(this.database, LEGACY_IMPORT_STORE, {
          importedCount,
          skippedCount,
        });
        this.logger.info({ importedCount, skippedCount }, "Legacy push token import complete");
      });
    } catch (error) {
      throw new Error(`Failed to import legacy push tokens from ${this.legacyFilePath}`, {
        cause: error,
      });
    }
  }
}
