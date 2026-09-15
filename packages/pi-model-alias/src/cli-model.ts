/**
 * Reading the startup `--model` value.
 *
 * Pi resolves `--model` against its own model catalog before a session exists, and
 * exposes neither the raw value nor a hook in that path, so an alias name reaches
 * `resolveCliModel` as an ordinary pattern and fuzzy-matches some unrelated model.
 * The value is therefore read back from `process.argv`, mirroring Pi's own parsing
 * in `cli/args.ts`, so the alias can be applied once the session is up.
 */

/** Matches Pi's own parsing: `--model <value>`, space separated, no `=` form. */
export function readCliModelArgument(argv: readonly string[]): string | undefined {
	for (let index = 0; index < argv.length; index += 1) {
		// An explicit provider means the user addressed Pi's catalog directly, so the
		// value is a model pattern for that provider and never an alias name.
		if (argv[index] === "--provider") return undefined;
	}
	for (let index = 0; index < argv.length - 1; index += 1) {
		if (argv[index] === "--model") return argv[index + 1];
	}
	return undefined;
}
