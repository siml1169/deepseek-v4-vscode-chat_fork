import * as vscode from "vscode";
import type { OpenAIChatMessage, OpenAIChatRole, OpenAIFunctionToolDef, OpenAIToolCall } from "./types";
import { toWireName } from "./tool_names";
import type { ToolChoice } from "./tool_choice";
import { buildToolPayload } from "./tool_payload";
import { buildUserContent, type UserContentInput } from "./image_content";

// Tool-name validation/wire-aliasing live in `./tool_names.ts` and the tool
// payload assembly (schema sanitization, skip logic, tool_choice) in
// `./tool_payload.ts` — both pure and vscode-free so unit tests can import
// them via Node ESM without a VS Code mock. Multimodal content assembly
// (image blocks, MIME gating) is the same pattern in `./image_content.ts`.

/**
 * Convert VS Code chat request messages into OpenAI-compatible message objects.
 * @param messages The VS Code chat messages to convert.
 * @param opts.imageInput Whether the selected variant accepts image input.
 *   When true, image data parts in USER messages become `image_url` blocks
 *   (content switches to the block-array shape for those messages only).
 *   When false (default), images are dropped exactly as before — the wire
 *   shape of every message stays a plain string.
 * @returns OpenAI-compatible messages array.
 */
export function convertMessages(
	messages: readonly vscode.LanguageModelChatRequestMessage[],
	opts?: { imageInput?: boolean }
): OpenAIChatMessage[] {
	const imageInput = opts?.imageInput === true;
	const out: OpenAIChatMessage[] = [];
	for (const m of messages) {
		const role = mapRole(m);
		const textParts: string[] = [];
		const contentInputs: UserContentInput[] = [];
		const toolCalls: OpenAIToolCall[] = [];
		const toolResults: { callId: string; content: string }[] = [];

		for (const part of m.content ?? []) {
			if (part instanceof vscode.LanguageModelTextPart) {
				textParts.push(part.value);
				contentInputs.push({ kind: "text", text: part.value });
			} else if (isImageDataPart(part)) {
				// Images ride only on USER turns (attachments). Assistant/system
				// turns never legitimately carry them, and DeepSeek only accepts
				// image blocks on user messages — anywhere else they are dropped
				// by the role gate below, same as before vision support.
				contentInputs.push({ kind: "image", mimeType: part.mimeType, data: part.data });
			} else if (part instanceof vscode.LanguageModelToolCallPart) {
				const id = part.callId;
				if (typeof id !== "string" || id.trim().length === 0) {
					throw new Error("Invalid request: Tool call must have a nonempty callId.");
				}
				let args = "{}";
				try {
					args = JSON.stringify(part.input ?? {});
				} catch {
					args = "{}";
				}
				// History tool calls carry HOST names (the reverse-mapped names
				// we reported to VS Code); re-alias them so the API sees the
				// same wire name it saw when it issued the call. toWireName is
				// pure, so this round-trips identically across requests.
				toolCalls.push({ id, type: "function", function: { name: toWireName(part.name), arguments: args } });
			} else if (isToolResultPart(part)) {
				const callId = (part as { callId?: string }).callId ?? "";
				const content = collectToolResultText(part as { content?: ReadonlyArray<unknown> });
				toolResults.push({ callId, content });
			}
		}

		let emittedAssistantToolCall = false;
		if (toolCalls.length > 0) {
			out.push({ role: "assistant", content: textParts.join("") || undefined, tool_calls: toolCalls });
			emittedAssistantToolCall = true;
		}

		for (const tr of toolResults) {
			out.push({ role: "tool", tool_call_id: tr.callId, content: tr.content || "" });
		}

		if (role === "user") {
			// User turns may be multimodal: assemble ordered text/image blocks.
			// buildUserContent collapses back to the legacy plain string when no
			// image survives (vision disabled, unsupported MIME, or text-only),
			// keeping text-only requests byte-identical to previous versions.
			const built = buildUserContent(contentInputs, imageInput);
			if (built.droppedNoVision > 0) {
				console.warn(
					`[DeepSeek V4] dropped ${built.droppedNoVision} image attachment(s): the selected model variant has no image input. Pick a Vision variant to send images.`
				);
			}
			if (built.droppedUnsupported > 0) {
				console.warn(
					`[DeepSeek V4] dropped ${built.droppedUnsupported} image attachment(s) with unsupported MIME type (Vision accepts JPEG/PNG/GIF/WebP).`
				);
			}
			if (built.content.length > 0) {
				out.push({ role, content: built.content });
			}
			continue;
		}

		const text = textParts.join("");
		if (text && (role === "system" || (role === "assistant" && !emittedAssistantToolCall))) {
			out.push({ role, content: text });
		}
	}
	return out;
}

/**
 * Type guard for image-bearing data parts. Structural rather than
 * `instanceof vscode.LanguageModelDataPart` — real instances pass it, and so
 * does a part serialized across the extension-host boundary ({mimeType,
 * data}), which instanceof would miss (same reason the cache_control
 * sentinel in collectToolResultText is duck-typed). MIME support is NOT
 * checked here — unsupported images must reach buildUserContent so they are
 * counted and warned about, not silently ignored as unknown parts.
 */
function isImageDataPart(value: unknown): value is { mimeType: string; data: Uint8Array } {
	if (!value || typeof value !== "object") {
		return false;
	}
	const obj = value as { mimeType?: unknown; data?: unknown };
	return typeof obj.mimeType === "string" && obj.mimeType.startsWith("image/") && obj.data instanceof Uint8Array;
}

/**
 * Convert VS Code tool definitions to OpenAI function tool definitions.
 * Thin vscode adapter: the actual assembly (aliasing, skips, sanitization,
 * tool_choice) is the pure `buildToolPayload` in `tool_payload.ts`.
 * @param options Request options containing tools and toolMode.
 */
export function convertTools(options: vscode.ProvideLanguageModelChatResponseOptions): {
	tools?: OpenAIFunctionToolDef[];
	tool_choice?: ToolChoice;
} {
	return buildToolPayload(options.tools ?? [], options.toolMode === vscode.LanguageModelChatToolMode.Required);
}

/**
 * Validate the request message sequence for correct tool call/result pairing.
 * Call IDs are unique across the full history; pending calls allow only
 * consecutive User messages containing matching, single-use tool results.
 * @param messages The full request message list.
 */
export function validateRequest(messages: readonly vscode.LanguageModelChatRequestMessage[]): void {
	const lastMessage = messages[messages.length - 1];
	if (!lastMessage) {
		console.error("[DeepSeek V4] No messages in request");
		throw new Error("Invalid request: no messages.");
	}

	const seenCallIds = new Set<string>();
	const pendingCallIds = new Set<string>();
	const fail = (reason: string): never => {
		console.error(`[DeepSeek V4] Validation failed: ${reason}`);
		throw new Error(`Invalid request: ${reason}`);
	};
	const missingResult =
		"Tool call part must be followed by a User message with a LanguageModelToolResultPart with a matching callId.";

	for (const message of messages) {
		const content = message.content ?? [];
		if (pendingCallIds.size > 0) {
			if (
				message.role !== vscode.LanguageModelChatMessageRole.User ||
				content.length === 0 ||
				!content.every(isToolResultPart)
			) {
				fail(missingResult);
			}
		}

		for (const part of content) {
			if (part instanceof vscode.LanguageModelToolCallPart) {
				if (message.role !== vscode.LanguageModelChatMessageRole.Assistant) {
					fail("Tool call part must belong to an Assistant message.");
				}
				const callId = part.callId;
				if (typeof callId !== "string" || callId.trim().length === 0) {
					fail("Tool call must have a nonempty callId.");
				}
				if (seenCallIds.has(callId)) {
					fail("Duplicate tool call callId.");
				}
				seenCallIds.add(callId);
				pendingCallIds.add(callId);
			} else if (part instanceof vscode.LanguageModelToolResultPart || isToolResultPart(part)) {
				if (message.role !== vscode.LanguageModelChatMessageRole.User || !pendingCallIds.delete(part.callId)) {
					fail("Tool result must match an outstanding callId exactly once in a User message.");
				}
			}
		}
	}
	if (pendingCallIds.size > 0) {
		fail(missingResult);
	}
}

/**
 * Type guard for LanguageModelToolResultPart-like values.
 * @param value Unknown value to test.
 */
export function isToolResultPart(value: unknown): value is { callId: string; content?: ReadonlyArray<unknown> } {
	if (!value || typeof value !== "object") {
		return false;
	}
	const obj = value as Record<string, unknown>;
	const hasCallId = typeof obj.callId === "string";
	const hasContent = "content" in obj;
	return hasCallId && hasContent;
}

/**
 * Map VS Code message role to OpenAI message role string.
 * @param message The message whose role is mapped.
 */
function mapRole(message: vscode.LanguageModelChatRequestMessage): Exclude<OpenAIChatRole, "tool"> {
	const USER = vscode.LanguageModelChatMessageRole.User as unknown as number;
	const ASSISTANT = vscode.LanguageModelChatMessageRole.Assistant as unknown as number;
	const r = message.role as unknown as number;
	if (r === USER) {
		return "user";
	}
	if (r === ASSISTANT) {
		return "assistant";
	}
	return "system";
}

/**
 * Concatenate tool result content into a single text string.
 * @param pr Tool result-like object with content array.
 */
function collectToolResultText(pr: { content?: ReadonlyArray<unknown> }): string {
	let text = "";
	for (const c of pr.content ?? []) {
		if (c instanceof vscode.LanguageModelTextPart) {
			text += c.value;
		} else if (typeof c === "string") {
			text += c;
		} else {
			// VS Code 1.118+ appends an internal LanguageModelDataPart
			// sentinel (mimeType "cache_control", data "ephemeral") at the
			// end of tool-result turns; the matching enum is private, so a
			// fallback JSON.stringify(c) here used to inject
			// {"$mid":24,"mimeType":"cache_control","data":"ZXBoZW1lcmFs"}
			// into tool output the model sees (see issue #11). Drop everything
			// non-text now, but warn on truly novel parts — quiet on the
			// known sentinel — so future host changes show up in the
			// Extension Host devtools without spamming users.
			const isObj = !!c && typeof c === "object";
			const mimeType = isObj ? (c as { mimeType?: unknown }).mimeType : undefined;
			if (mimeType !== "cache_control") {
				const ctor = isObj
					? (Object.getPrototypeOf(c as object) as { constructor?: { name?: string } } | undefined)?.constructor?.name
					: undefined;
				console.warn(
					`[DeepSeek V4] dropped unknown tool-result part: ctor=${ctor ?? typeof c} mimeType=${String(mimeType)}`
				);
			}
		}
	}
	return text;
}

// tryParseJSONObject moved to sse.ts: its only consumers are the tool-call
// assembly paths, and keeping it here would drag this module's `vscode`
// import into sse.ts's vscode-free unit-test import chain.
