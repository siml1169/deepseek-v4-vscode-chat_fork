import type { OpenAIFunctionToolDef } from "./types";
import { MAX_TOOLS_PER_REQUEST } from "./tool_limit";

/**
 * Prefer explicitly configured host names when the host offers too many
 * tools. Never enable tools the host has not offered, or reorder the retained
 * definitions: stable order also preserves the server's prompt-cache prefix.
 */
export function selectAdvertisedTools(
	tools: readonly OpenAIFunctionToolDef[],
	wireToHost: ReadonlyMap<string, string>,
	preferredNames: unknown
): OpenAIFunctionToolDef[] {
	if (tools.length <= MAX_TOOLS_PER_REQUEST) {
		return [...tools];
	}
	const preferred = new Set(
		Array.isArray(preferredNames) ? preferredNames.filter((name): name is string => typeof name === "string") : []
	);
	const chosen = new Set<string>();
	for (const tool of tools) {
		if (preferred.has(wireToHost.get(tool.function.name) ?? "") && chosen.size < MAX_TOOLS_PER_REQUEST) {
			chosen.add(tool.function.name);
		}
	}
	for (const tool of tools) {
		if (chosen.size >= MAX_TOOLS_PER_REQUEST) {
			break;
		}
		chosen.add(tool.function.name);
	}
	return tools.filter((tool) => chosen.has(tool.function.name));
}
