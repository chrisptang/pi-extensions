import { CustomEditor, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";

/**
 * Pi does not re-export `EditorFactory` from the package root, so the factory
 * type is taken from the API that consumes it.
 */
type EditorFactory = NonNullable<Parameters<ExtensionUIContext["setEditorComponent"]>[0]>;

/**
 * Build the editor factory Pi installs for the session.
 *
 * The subclass exists only to seed persisted prompts into the editor's history at
 * construction. Everything else — Up/Down browsing, the draft that Down restores,
 * consecutive-duplicate suppression, and every app keybinding Pi wires onto a
 * custom editor — is inherited unchanged, so browsing behaves exactly as it does
 * for prompts typed in the current session.
 *
 * @param entries Stored prompts, oldest first.
 */
export function createHistoryEditorFactory(entries: readonly string[]): EditorFactory {
	return (tui, theme, keybindings) => {
		const editor = new CustomEditor(tui, theme, keybindings);
		// Pi's `addToHistory` unshifts, so replaying oldest first leaves the most
		// recent prompt one Up press away.
		for (const entry of entries) editor.addToHistory(entry);
		return editor;
	};
}
