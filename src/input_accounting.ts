import type { OpenAIChatMessage, OpenAIFunctionToolDef } from "./types";

/** Count only text present in the converted wire history, never base64 images. */
export function countHistoryChars(messages: readonly OpenAIChatMessage[]): number {
	let chars = 0;
	for (const message of messages) {
		if (typeof message.content === "string") {
			chars += message.content.length;
		} else if (Array.isArray(message.content)) {
			for (const block of message.content) {
				if (block.type === "text") {
					chars += block.text.length;
				}
			}
		}
		chars += message.reasoning_content?.length ?? 0;
		for (const call of message.tool_calls ?? []) {
			chars += call.function.arguments.length;
		}
	}
	return chars;
}

export function countToolChars(tools: readonly OpenAIFunctionToolDef[] | undefined): number {
	return tools?.length ? JSON.stringify(tools).length : 0;
}

export function estimateInputTokens(chars: number, charsPerToken: number, imageTokens = 0): number {
	return Math.ceil(chars / charsPerToken) + imageTokens;
}
