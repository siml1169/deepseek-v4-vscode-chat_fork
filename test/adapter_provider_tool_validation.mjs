import { check, checkMatch, summary, withConsole } from "./helpers/check.mjs";
import { toWireName } from "../out/tool_names.js";
import {
	vscode, shim, makeProvider, runTurn, userText, assistantToolCallMsg, toolResultMsg,
	toolCallChunk, finishChunk, DONE,
} from "./helpers/fakes.mjs";

const schema = {
	type: "object",
	properties: {
		location: { anyOf: [{ type: "string", minLength: 2 }, { type: "null" }] },
		limit: { type: "number", minimum: 0, maximum: 10 },
	},
	required: ["location"],
	additionalProperties: false,
};
const tools = [{ name: "mcp.weather.get", inputSchema: schema }];
const chunks = (name, args, id = "call_valid") => [
	toolCallChunk(0, { id, name, args: JSON.stringify(args) }),
	finishChunk("tool_calls"), DONE,
];
const quiet = async (fn) => (await withConsole("error", fn)).result;

async function main() {
	for (const args of [{ location: "Tokyo", limit: 1.5 }, { location: null }]) {
		shim.reset();
		const { provider } = makeProvider();
		const t = await runTurn(provider, { options: { tools }, chunks: chunks(toWireName(tools[0].name), args) });
		check("valid union/numeric arguments accepted", t.error, undefined);
		check("valid call dispatched once", t.progress.toolCalls().length, 1);
		check("host alias restored", t.progress.toolCalls()[0]?.name, tools[0].name);
		check("arguments unchanged", JSON.stringify(t.progress.toolCalls()[0]?.input), JSON.stringify(args));
		provider.dispose();
	}
	for (const args of [{}, { location: 42 }, { location: "x" }, { location: "Tokyo", limit: 11 }, { location: "Tokyo", extra: true }]) {
		shim.reset();
		const { provider } = makeProvider();
		const t = await quiet(() => runTurn(provider, { options: { tools }, chunks: chunks(toWireName(tools[0].name), args) }));
		checkMatch("schema-invalid arguments rejected", t.error?.message, /Invalid arguments for tool/);
		check("invalid call never dispatched", t.progress.toolCalls().length, 0);
		provider.dispose();
	}
	for (const name of ["unknown", tools[0].name]) {
		shim.reset();
		const { provider } = makeProvider();
		const t = await quiet(() => runTurn(provider, { options: { tools }, chunks: chunks(name, { location: "Tokyo" }) }));
		checkMatch("unknown or unaliased host name rejected", t.error?.message, /unadvertised tool/);
		check("unadvertised call never dispatched", t.progress.toolCalls().length, 0);
		provider.dispose();
	}
	{
		shim.reset();
		const { provider } = makeProvider();
		const offered = Array.from({ length: 129 }, (_, i) => ({ name: `mcp.tool.${i}` }));
		const t = await quiet(() => runTurn(provider, { options: { tools: offered }, chunks: chunks(toWireName(offered[128].name), {}) }));
		checkMatch("tool omitted by cap rejected", t.error?.message, /unadvertised tool/);
		check("omitted call never dispatched", t.progress.toolCalls().length, 0);
		provider.dispose();
	}
	{
		shim.reset();
		const { provider } = makeProvider();
		const t = await quiet(() => runTurn(provider, { chunks: chunks("unknown", {}) }));
		checkMatch("tool-less request rejects calls", t.error?.message, /unadvertised tool/);
		check("no unadvertised dispatch in tool-less request", t.progress.toolCalls().length, 0);
		provider.dispose();
	}
	{
		shim.reset();
		const { provider } = makeProvider();
		const t = await quiet(() => runTurn(provider, {
			options: {
				tools: [{ name: "bad", inputSchema: { type: "object", unsupportedKeyword: true } }],
				toolMode: vscode.LanguageModelChatToolMode.Required,
			},
		}));
		checkMatch("required mode fails when no supported tools remain", t.error?.message, /No usable tools remain/);
		check("unusable required-tool request never sent", t.captured.url, undefined);
		provider.dispose();
	}
	for (const id of [undefined, " \t"]) {
		shim.reset();
		const { provider } = makeProvider();
		const t = await quiet(() => runTurn(provider, {
			options: { tools: [{ name: "a" }] },
			chunks: [toolCallChunk(0, { id, name: "a", args: "{}" }), finishChunk("tool_calls"), DONE],
		}));
		checkMatch("missing/blank streamed ID rejected on clean finish", t.error?.message, /Missing tool call ID/);
		check("missing/blank streamed ID never dispatched", t.progress.toolCalls().length, 0);
		provider.dispose();
	}
	{
		shim.reset();
		const { provider } = makeProvider();
		const t = await quiet(() => runTurn(provider, {
			options: {
				tools: [
					{ name: "bad", inputSchema: { type: "object", unsupportedKeyword: true } },
					{ name: "good" },
				],
				toolMode: vscode.LanguageModelChatToolMode.Required,
			},
			chunks: chunks("good", {}),
		}));
		check("invalid schema does not block usable tools", t.error, undefined);
		check("skipped schema not advertised", JSON.parse(t.captured.body).tools.length, 1);
		check("required choice resolves over usable schemas", JSON.parse(t.captured.body).tool_choice.function.name, "good");
		provider.dispose();
	}
	{
		shim.reset();
		const { provider } = makeProvider();
		const t = await quiet(() => runTurn(provider, {
			options: { tools: [{ name: "a" }] },
			chunks: [
				toolCallChunk(0, { id: "same", name: "a", args: "{}" }),
				toolCallChunk(1, { id: "same", name: "a", args: "{}" }),
				finishChunk("tool_calls"), DONE,
			],
		}));
		checkMatch("duplicate streamed call IDs rejected", t.error?.message, /duplicate tool call ID/);
		check("duplicate call not dispatched", t.progress.toolCalls().length, 1);
		provider.dispose();
	}
	{
		shim.reset();
		const { provider } = makeProvider();
		const t = await quiet(() => runTurn(provider, {
			messages: [
				userText("do it"),
				assistantToolCallMsg("", [{ callId: "used", name: "a", input: {} }]),
				toolResultMsg([{ callId: "used", content: ["done"] }]),
			],
			options: { tools: [{ name: "a" }] },
			chunks: chunks("a", {}, "used"),
		}));
		checkMatch("streamed ID cannot reuse historical ID", t.error?.message, /duplicate tool call ID/);
		check("reused historical call never dispatched", t.progress.toolCalls().length, 0);
		provider.dispose();
	}
	// A whole batch is validated before any member is dispatched.
	{
		shim.reset();
		const { provider } = makeProvider();
		const t = await quiet(() => runTurn(provider, {
			options: { tools: [{ name: "a" }] },
			chunks: [
				`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [
					{ index: 0, id: "valid", function: { name: "a", arguments: "{}" } },
					{ index: 1, id: "invalid", function: { name: "unknown", arguments: "{}" } },
				] } }] })}\n\n`,
				finishChunk("tool_calls"), DONE,
			],
		}));
		checkMatch("invalid member rejects batch", t.error?.message, /unadvertised tool/);
		check("invalid batch never partially dispatched", t.progress.toolCalls().length, 0);
		provider.dispose();
	}
	{
		shim.reset();
		const { provider } = makeProvider();
		const t = await runTurn(provider, {
			options: { tools: [{ name: "a" }, { name: "b" }] },
			chunks: [
				toolCallChunk(0, { id: "a1", name: "a", args: '{"x":' }),
				toolCallChunk(1, { id: "b1", name: "b", args: '{"y":' }),
				toolCallChunk(1, { args: "2}" }),
				toolCallChunk(0, { args: "1}" }),
				finishChunk("tool_calls"), DONE,
			],
		});
		check("interleaved parallel calls still work", t.error, undefined);
		check("both parallel calls dispatched", t.progress.toolCalls().length, 2);
		check("parallel call IDs maintained", t.progress.toolCalls().map((call) => call.callId).join(","), "b1,a1");
		provider.dispose();
	}
	summary("adapter_provider_tool_validation");
}
await main();
