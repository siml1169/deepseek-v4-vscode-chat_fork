/**
 * Pure (vscode-free) assembly of the OpenAI tool payload from host tool
 * descriptors: schema validation, wire-name aliasing with first-wins
 * collision/unusable skips (issue #20), and tool_choice resolution.
 *
 * Extracted from `convertTools` in utils.ts — which remains as a thin vscode
 * adapter (enum → boolean) — so the REAL skip-then-count path is importable
 * by the Node unit harness (test/unit_tool_limit.mjs) without a vscode mock.
 * Third instance of the repo's vscode-free extraction pattern
 * (tool_names.ts, tool_choice.ts).
 */

import type { OpenAIFunctionToolDef } from "./types";
import { toWireName, buildWireNameMap } from "./tool_names";
import { resolveToolChoice, type ToolChoice } from "./tool_choice";
import { prepareToolSchema } from "./tool_schema";

/**
 * Structural view of a host tool entry (VS Code's `LanguageModelChatTool`),
 * kept loose enough for the defensive guards below to stay meaningful.
 */
export interface HostToolDescriptor {
	readonly name: string;
	readonly description?: string;
	readonly inputSchema?: object;
}

/**
 * Build the OpenAI function tool defs and tool_choice for one request.
 * @param tools Host tool descriptors (VS Code's `options.tools`).
 * @param requiredMode True when the host demands a tool call (VS Code's
 *   `LanguageModelChatToolMode.Required`).
 */
export function buildToolPayload(
	tools: ReadonlyArray<HostToolDescriptor | null | undefined>,
	requiredMode: boolean
): {
	tools?: OpenAIFunctionToolDef[];
	tool_choice?: ToolChoice;
} {
	if (!tools || tools.length === 0) {
		return {};
	}

	// Every name is deterministically aliased onto DeepSeek's spec
	// (^[A-Za-z0-9_-]{1,64}$) by toWireName — spec-legal names pass through
	// untouched. The stream layer reverse-maps the model's echoed alias back
	// to the host name before reporting (provider.ts), so aliasing is
	// invisible to VS Code's tool registry. Earlier revisions hard-threw on
	// the first illegal name instead, which turned one over-long MCP tool
	// name into a total chat outage (issue #20).
	const wireToHost = buildWireNameMap(tools.map((t) => t?.name));

	const toolDefs: OpenAIFunctionToolDef[] = [];
	const seenHostNames = new Set<string>();
	for (const t of tools) {
		if (!t || typeof t !== "object") {
			continue;
		}
		const wire = typeof t.name === "string" ? toWireName(t.name) : "";
		// The typeof guard must be explicit: for `t.name === undefined`,
		// `wireToHost.get("")` is ALSO undefined, so the membership check
		// alone would pass (`undefined !== undefined` → false) and advertise
		// an empty function name — a guaranteed API 400 that kills the whole
		// request, the exact failure class this aliasing layer exists to
		// eliminate.
		if (typeof t.name !== "string" || wireToHost.get(wire) !== t.name || seenHostNames.has(t.name)) {
			// Unusable name (empty / non-string) or wire-name collision with
			// an earlier tool — advertising it would let the model call a
			// name that dispatches to the wrong tool. Skip just this tool;
			// the rest of the request proceeds.
			console.error("[DeepSeek V4] Skipping tool with unusable or colliding name", {
				name: t.name,
				wire,
				collidesWith: wireToHost.get(wire),
			});
			continue;
		}
		seenHostNames.add(t.name);
		const description = typeof t.description === "string" ? t.description : "";
		let params: Record<string, unknown>;
		try {
			params = prepareToolSchema(t.inputSchema);
		} catch (error) {
			console.error("[DeepSeek V4] Skipping tool with invalid or unsupported schema", {
				name: t.name,
				reason: error instanceof Error ? error.message : String(error),
			});
			continue;
		}
		toolDefs.push({
			type: "function" as const,
			function: {
				name: wire,
				description,
				parameters: params,
			},
		} satisfies OpenAIFunctionToolDef);
	}

	if (toolDefs.length === 0) {
		return {};
	}

	// Resolution lives in `tool_choice.ts` (vscode-free, unit-tested).
	// Count and name refer to the ADVERTISED (wire) tool set — a forced
	// named-function tool_choice must match a name the API was given.
	const tool_choice = resolveToolChoice(requiredMode, toolDefs.length, toolDefs[0]?.function.name);

	return { tools: toolDefs, tool_choice };
}
