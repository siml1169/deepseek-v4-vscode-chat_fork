// Reasoning round-trip through the real provider: attachReasoningToHistory
// (hit / unavailable-original diagnosis / non-thinking strip / stats gating), persistReasoningForTurn
// anchors (tc: / tx:, wire names), and cross-instance restore from globalState.
import { createRequire } from "node:module";
import { check, checkMatch, summary, until, withConsole } from "./helpers/check.mjs";
import { OUT, shim, makeProvider, runTurn, model, userText, assistantText, assistantToolCallMsg, toolResultMsg, reasoningChunk, contentChunk, toolCallChunk, finishChunk, usageChunk, DONE, cancellation } from "./helpers/fakes.mjs";

const require = createRequire(import.meta.url);
const { fingerprintAssistantTurn } = require(OUT("reasoning_cache.js"));
const { convertMessages } = require(OUT("utils.js"));

async function main() {
	// --- attachReasoningToHistory: hit, miss, stats ---
	{
		const { provider, output } = makeProvider();
		const fpHit = fingerprintAssistantTurn({ text: "Cached answer.", toolCalls: [] });
		provider._reasoningCache.set(fpHit, "my reasoning");
		const msgs = convertMessages([userText("q"), assistantText("Cached answer."), userText("q2"), assistantText("Uncached answer."), userText("q3")]);
		let missing;
		try { provider.attachReasoningToHistory(msgs, true); } catch (error) { missing = error; }
		checkMatch("plain-text unavailable original fails locally", missing?.message, /original assistant reasoning is unavailable/);
		check("hit gets the cached reasoning", msgs[1].reasoning_content, "my reasoning");
		check("miss never invents an empty original", msgs[3].reasoning_content, undefined);
		check("user turns untouched", msgs[0].reasoning_content, undefined);
		const cs = provider.getCacheStats();
		check("real turn counts toward cache stats (gets)", cs.totalGets, 2);
		check("…hits", cs.totalHits, 1);
		const msgs2 = convertMessages([userText("q"), assistantText("Uncached answer.")]);
		let auxiliaryMissing;
		try { provider.attachReasoningToHistory(msgs2, false); } catch (error) { auxiliaryMissing = error; }
		checkMatch("tool-enabled auxiliary history cannot fabricate originals", auxiliaryMissing?.message, /original assistant reasoning is unavailable/);
		check("…but stats unchanged (countStats=false)", provider.getCacheStats().totalGets, 2);
		check("pre-existing reasoning_content is kept, not re-looked-up", (() => { const m = [{ role: "assistant", content: "x", reasoning_content: "keep" }]; provider.attachReasoningToHistory(m); return m[0].reasoning_content; })(), "keep");
		checkMatch("miss is logged with the fingerprint", output.text(), /cache\.MISS.*"mode":"tx"/);
		checkMatch("error explains original unavailable and guidance", shim.calls.showErrorMessage.at(-1)?.message, /original assistant reasoning is unavailable.*Start a new chat.*Show Log/);
		provider.dispose();
	}

	// --- tool-call anchor: set side (stream) → get side (next request), wire names ---
	{
		shim.reset();
		const { provider, memento } = makeProvider();
		const tools = [{ name: "weather.get", description: "d", inputSchema: { type: "object", properties: {} } }];
		const t1 = await runTurn(provider, {
			model: model("deepseek-v4-pro::thinking"),
			messages: [userText("weather?")],
			options: { tools },
			chunks: [reasoningChunk("Think."), toolCallChunk(0, { id: "call_1", name: "weather_get_" }), DONE],
		});
		// The aliased wire name must be completed by the assembler; use the real alias:
		const wire = convertMessages([assistantToolCallMsg("", [{ callId: "call_1", name: "weather.get", input: {} }])])[0].tool_calls[0].function.name;
		check("turn 1 setup: no error", t1.error, undefined);
		// Re-run with the exact wire name so the tool call completes and is reported.
		const t1b = await runTurn(provider, {
			model: model("deepseek-v4-pro::thinking"),
			messages: [userText("weather?")],
			options: { tools },
			chunks: [reasoningChunk("Think harder."), toolCallChunk(0, { id: "call_2", name: wire, args: "{}" }), finishChunk("tool_calls"), DONE],
		});
		check("tool call reported to the host", t1b.progress.toolCalls().length, 1);
		check("…under the HOST name (reverse-mapped)", t1b.progress.toolCalls()[0].name, "weather.get");
		const fp = fingerprintAssistantTurn({ text: "", toolCalls: [{ id: "call_2", name: wire }] });
		check("reasoning cached under the tc: fingerprint keyed on the WIRE name", provider._reasoningCache.get(fp, false), "Think harder.");
		check("fingerprint mode is tc:", fp.startsWith("tc:"), true);
		// Next request: host history carries the HOST name; attach must hit.
		const next = convertMessages([userText("weather?"), assistantToolCallMsg("", [{ callId: "call_2", name: "weather.get", input: {} }]), toolResultMsg([{ callId: "call_2", content: ["Sunny"] }]), userText("ok")]);
		const stats = provider.attachReasoningToHistory(next, true);
		check("next turn: tool-call turn hits", stats.hits, 1);
		check("…with the streamed reasoning", next[1].reasoning_content, "Think harder.");
		// Persistence: debounced write to globalState. Poll for the entry rather
		// than sleeping past the debounce — no tuned delay, no race.
		const persisted = await until(() => (memento.get("deepseekv4.reasoningCache") ?? []).some((e) => e.fingerprint === fp));
		check("cache persisted to globalState under the frozen key", persisted, true);
		check("…as an array of entries", Array.isArray(memento.get("deepseekv4.reasoningCache")), true);
		provider.dispose();

		// Cross-instance restore (simulates VS Code restart / extension upgrade).
		const second = makeProvider({ memento });
		const again = convertMessages([userText("weather?"), assistantToolCallMsg("", [{ callId: "call_2", name: "weather.get", input: {} }]), toolResultMsg([{ callId: "call_2", content: ["Sunny"] }]), userText("ok")]);
		check("new instance restored the entry and hits", second.provider.attachReasoningToHistory(again, true).hits, 1);
		second.provider.dispose();
	}

	// --- text anchor, and the 💭-only turn is not cached ---
	{
		shim.reset();
		const { provider } = makeProvider();
		const t = await runTurn(provider, { messages: [userText("hi")], chunks: [reasoningChunk("R1"), contentChunk("Hello there."), finishChunk("stop"), DONE] });
		check("text turn: no error", t.error, undefined);
		// Anchor text is whatever was actually reported to the host as visible
		// text, not the raw content delta: on hosts without
		// LanguageModelThinkingPart (the shim's default — see adapter_smoke),
		// the "💭 Thinking..." fallback hint is itself a real TextPart emitted
		// before "Hello there.", so it is part of ctx.emittedText and thus part
		// of the tx: fingerprint. Hardcoding "Hello there." as the anchor text
		// undercounts that prefix and always misses.
		const emittedText = t.progress.texts().join("");
		checkMatch("fallback hint prefixes the emitted text (no host ThinkingPart)", emittedText, /^💭.*Hello there\.$/s);
		check("text reasoning cached under tx: (keyed on the actual emitted text, hint included)", provider._reasoningCache.get(fingerprintAssistantTurn({ text: emittedText, toolCalls: [] }), false), "R1");
		const before = provider._reasoningCache.size();
		const only = await runTurn(provider, { messages: [userText("hi2")], chunks: [reasoningChunk("R2"), finishChunk("stop"), DONE] });
		check("💭-only turn (no host ThinkingPart, no content): no error", only.error, undefined);
		check("…emitted the one-shot 💭 hint", only.progress.texts().some((s) => s.startsWith("💭")), true);
		check("…is NOT cached (no anchor)", provider._reasoningCache.size(), before);
		provider.dispose();
	}

	// --- non-thinking variant strips reasoning_content from history ---
	{
		shim.reset();
		const { provider } = makeProvider();
		const fp = fingerprintAssistantTurn({ text: "Cached answer.", toolCalls: [] });
		provider._reasoningCache.set(fp, "stale");
		const t = await runTurn(provider, { model: model("deepseek-v4-flash"), messages: [userText("q"), assistantText("Cached answer."), userText("q2")], chunks: [contentChunk("ok"), finishChunk("stop"), DONE] });
		check("non-thinking turn: no error", t.error, undefined);
		check("non-thinking body carries no reasoning_content", String(t.captured.body).includes("reasoning_content"), false);
		check("thinking disabled on the wire", String(t.captured.body).includes('"thinking":{"type":"disabled"}'), true);
		provider.dispose();
	}
	// --- no-tool thinking ignores reasoning, but preserves it for later tools ---
	{
		shim.reset();
		const { provider } = makeProvider();
		const first = await runTurn(provider, { chunks: [reasoningChunk("original"), contentChunk("answer"), finishChunk("stop"), DONE] });
		const answer = first.progress.texts().join("");
		const history = [userText("q"), assistantText(answer), userText("next")];
		const before = provider.getCacheStats().totalGets;
		const noTools = await runTurn(provider, { messages: history });
		check("thinking without advertised tools omits reasoning", JSON.parse(noTools.captured.body).messages[1].reasoning_content, undefined);
		check("no-tool requests do not look up reasoning", provider.getCacheStats().totalGets, before);
		const withTools = await runTurn(provider, { messages: history, options: { tools: [{ name: "t" }] } });
		check("later tools restore original from no-tool turn", JSON.parse(withTools.captured.body).messages[1].reasoning_content, "original");
		const unavailable = [userText("q"), assistantToolCallMsg("", [{ callId: "unknown", name: "t", input: {} }]), toolResultMsg([{ callId: "unknown", content: ["done"] }])];
		const rejected = (await withConsole("error", () => runTurn(provider, { messages: unavailable, options: { tools: [{ name: "t" }] } }))).result;
		checkMatch("missing tool-call original fails before network", rejected.error?.message, /original assistant reasoning is unavailable/);
		check("missing original was not sent", rejected.captured.url, undefined);
		check("missing original guidance is actionable", shim.calls.showErrorMessage.at(-1)?.items.join(","), "Start New Chat,Show Log");
		// Eviction/clear of a known nonempty original must not be mistaken for empty.
		provider._reasoningCache.clear();
		const lost = (await withConsole("error", () => runTurn(provider, { messages: history, options: { tools: [{ name: "t" }] } }))).result;
		checkMatch("known nonempty text original loss also fails locally", lost.error?.message, /original assistant reasoning is unavailable/);
		check("known original loss was not sent", lost.captured.url, undefined);
		provider.dispose();
	}
	// --- completed thinking tools can have a genuinely empty original, including after reload ---
	{
		shim.reset();
		const { provider, memento } = makeProvider();
		const tools = [{ name: "t" }];
		await runTurn(provider, { model: model("deepseek-v4-pro::thinking"), options: { tools }, chunks: [toolCallChunk(0, { id: "empty", name: "t", args: "{}" }), finishChunk("tool_calls"), DONE] });
		await runTurn(provider, { chunks: [contentChunk("completed empty text"), finishChunk("stop"), DONE] });
		provider.dispose();
		const second = makeProvider({ memento }).provider;
		const textHistory = convertMessages([assistantText("completed empty text")]);
		check("completed thinking text empty original restored after reload", second.attachReasoningToHistory(textHistory).hits, 1);
		check("completed text original is genuinely empty", textHistory[0].reasoning_content, "");
		const history = [userText("q"), assistantToolCallMsg("", [{ callId: "empty", name: "t", input: {} }]), toolResultMsg([{ callId: "empty", content: ["done"] }])];
		const replay = await runTurn(second, { messages: history, options: { tools } });
		check("known empty completed thinking reasoning does not block continuation", replay.error, undefined);
		check("only genuinely empty original gets empty string", JSON.parse(replay.captured.body).messages[1].reasoning_content, "");
		second.dispose();
	}
	// --- disabled, incomplete and cancelled no-reasoning streams never invent empty originals ---
	{
		shim.reset();
		const { provider } = makeProvider();
		for (const [label, turn] of [
			["disabled", { model: model("deepseek-v4-pro"), chunks: [contentChunk("disabled answer"), finishChunk("stop"), DONE] }],
			["incomplete", { chunks: [contentChunk("incomplete answer"), DONE] }],
			["truncated", { chunks: [contentChunk("truncated answer"), finishChunk("length"), DONE] }],
		]) {
			await runTurn(provider, turn);
			check(`${label}: no fabricated empty original`, provider._reasoningCache.size(), 0);
		}
		const cancel = cancellation();
		await runTurn(provider, {
			chunks: [contentChunk("cancelled answer"), DONE],
			cancellation: cancel,
			progress: { report: () => cancel.cancel() },
		});
		check("cancelled: no fabricated empty original", provider._reasoningCache.size(), 0);
		check("unavailable original is not stored as empty", provider._reasoningCache.size(), 0);
		provider.dispose();
	}
	// --- failed clean-finish validation cannot prove an empty original ---
	{
		shim.reset();
		const { provider } = makeProvider();
		const failed = (await withConsole("error", () => runTurn(provider, {
			options: { tools: [{ name: "t" }] },
			chunks: [
				contentChunk("failed tool answer"),
				toolCallChunk(0, { id: "invalid", name: "t", args: "{" }),
				finishChunk("tool_calls"), DONE,
			],
		}))).result;
		check("malformed tool arguments fail the response", Boolean(failed.error), true);
		check("failed response does not create an empty original", provider._reasoningCache.size(), 0);
		provider.dispose();
	}
	// --- every prior assistant round is restored, including completed rounds ---
	{
		shim.reset();
		const { provider } = makeProvider();
		const history = [
			userText("one"),
			assistantToolCallMsg("", [{ callId: "old", name: "t", input: {} }]),
			toolResultMsg([{ callId: "old", content: ["done"] }]),
			assistantText("completed old round"),
			userText("two"),
			assistantText("completed new round"),
			userText("three"),
		];
		for (const message of convertMessages(history).filter((m) => m.role === "assistant")) {
			const fp = fingerprintAssistantTurn({ text: message.content ?? "", toolCalls: (message.tool_calls ?? []).map((call) => ({ id: call.id, name: call.function.name })) });
			provider._reasoningCache.set(fp, `original:${fp}`);
		}
		const replay = await runTurn(provider, { messages: history, options: { tools: [{ name: "t" }] } });
		check("completed-round replay succeeds", replay.error, undefined);
		check("all assistants, not just latest round, carry originals", JSON.parse(replay.captured.body).messages.filter((m) => m.role === "assistant").every((m) => m.reasoning_content?.startsWith("original:")), true);
		provider.dispose();
	}
	summary("adapter_provider_reasoning");
}
main().catch((e) => {
	console.error(e);
	process.exit(1);
});
