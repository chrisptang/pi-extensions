import { createRequire } from "node:module";

type SQLiteValue = string | number | null;
type SQLiteRow = Record<string, unknown>;

interface NativeStatement {
	all(...values: SQLiteValue[]): SQLiteRow[];
	get(...values: SQLiteValue[]): SQLiteRow | null | undefined;
	run(...values: SQLiteValue[]): void;
}

interface NativeDatabase {
	exec(sql: string): void;
	prepare(sql: string): NativeStatement;
	close(): void;
}

export interface SQLiteStatement {
	all(...values: SQLiteValue[]): SQLiteRow[];
	get(...values: SQLiteValue[]): SQLiteRow | undefined;
	run(...values: SQLiteValue[]): void;
}

// A variable specifier keeps Node's SQLite module out of Bun standalone's static imports.
const isBun = Boolean(process.versions.bun);
const sqliteModule = isBun ? "bun:sqlite" : "node:sqlite";
const native = createRequire(import.meta.url)(sqliteModule) as {
	Database: new (path: string, options: { create: true }) => NativeDatabase;
	DatabaseSync: new (path: string) => NativeDatabase;
};

export class DatabaseSync {
	private readonly database: NativeDatabase;

	constructor(path: string, options: { timeout?: number } = {}) {
		const database = isBun
			? new native.Database(path, { create: true })
			: new native.DatabaseSync(path);
		try {
			// Node enables foreign keys by default; Bun does not.
			database.exec("PRAGMA foreign_keys = ON");
			database.exec(`PRAGMA busy_timeout = ${options.timeout ?? 0}`);
		} catch (error) {
			database.close();
			throw error;
		}
		this.database = database;
	}

	exec(sql: string): void {
		this.database.exec(sql);
	}

	prepare(sql: string): SQLiteStatement {
		const statement = this.database.prepare(sql);
		return {
			all: (...values) => statement.all(...values),
			get: (...values) => statement.get(...values) ?? undefined,
			run: (...values) => {
				statement.run(...values);
			},
		};
	}

	close(): void {
		this.database.close();
	}
}
