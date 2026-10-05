import { createRequire } from "node:module";
import { check, summary } from "./helpers/check.mjs";
const require = createRequire(import.meta.url);
const { countHistoryChars, countToolChars, estimateInputTokens } = require("../out/input_accounting.js");

const history = [
	{ role: "system", content: "sys" },
	{ role: "user", content: [{ type: "text", text: "hello" }, { type: "image_url", image_url: { url: "very long base64" } }] },
	{ role: "assistant", content: "answer", reasoning_content: "thought", tool_calls: [{ function: { arguments: '{"x":1}' } }] },
	{ role: "tool", content: "tool-result" },
];
check("wire text, tool result, arguments and included reasoning counted", countHistoryChars(history), 3 + 5 + 6 + 7 + 7 + 11);
delete history[2].reasoning_content;
check("omitted reasoning does not count", countHistoryChars(history), 32);
check("empty tools have zero cost", countToolChars([]), 0);
const tools = [{ type: "function", function: { name: "t", parameters: { type: "object" } } }];
check("advertised schemas counted exactly once", countToolChars(tools), JSON.stringify(tools).length);
check("round once, then add image ceiling", estimateInputTokens(7, 3, 384), 387);
summary("unit_input_accounting");
