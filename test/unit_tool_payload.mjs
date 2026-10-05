// Pins buildToolPayload's faithful schemas and tool_choice passthrough —
// the part of the tool wire shape not covered by unit_tool_limit (which
// covers the skip/cap path) or unit_tool_wire_name (aliasing).
//
//     npm test
import { check, checkDeep, summary } from "./helpers/check.mjs";
import { buildToolPayload } from "../out/tool_payload.js";

const one = (tool, required = false) => buildToolPayload([tool], required).tools[0].function;
const silent = (fn) => {
	const orig = console.error;
	console.error = () => {};
	try {
		return fn();
	} finally {
		console.error = orig;
	}
};

// --- envelope ---
check("no tools → {}", JSON.stringify(buildToolPayload([], false)), "{}");
checkDeep("function envelope", buildToolPayload([{ name: "ping" }], false).tools[0], {
	type: "function",
	function: { name: "ping", description: "", parameters: { type: "object", properties: {} } },
});
check("description passthrough", one({ name: "a", description: "desc" }).description, "desc");
check("non-string description → empty", one({ name: "a", description: 42 }).description, "");

// --- tool_choice ---
check("auto when not required", buildToolPayload([{ name: "a" }], false).tool_choice, "auto");
checkDeep("single tool + required → named force", buildToolPayload([{ name: "a" }], true).tool_choice, { type: "function", function: { name: "a" } });
check("multiple tools + required → 'required'", buildToolPayload([{ name: "a" }, { name: "b" }], true).tool_choice, "required");
check("named force uses the WIRE name of an aliased tool", buildToolPayload([{ name: "weather.get" }], true).tool_choice.function.name.startsWith("weather_get_"), true);

// --- schema fidelity ---
checkDeep("null schema → empty object schema", one({ name: "a", inputSchema: null }).parameters, { type: "object", properties: {} });
checkDeep("missing type is not invented", one({ name: "a", inputSchema: { properties: { x: { type: "string" } } } }).parameters, {
	properties: { x: { type: "string" } },
});
checkDeep(
	"anyOf retains every branch",
	one({ name: "a", inputSchema: { type: "object", properties: { v: { anyOf: [{ type: "number" }, { type: "string", description: "s" }] } } } }).parameters.properties.v,
	{ anyOf: [{ type: "number" }, { type: "string", description: "s" }] },
);
checkDeep(
	"oneOf retains every branch",
	one({ name: "a", inputSchema: { type: "object", properties: { v: { oneOf: [{ type: "integer" }, { type: "boolean" }] } } } }).parameters.properties.v,
	{ oneOf: [{ type: "integer" }, { type: "boolean" }] },
);
check("integer-like names do not change number semantics", one({ name: "a", inputSchema: { type: "object", properties: { limit: { type: "number" } } } }).parameters.properties.limit.type, "number");
check("…also *_id", one({ name: "a", inputSchema: { type: "object", properties: { user_id: { type: "number" } } } }).parameters.properties.user_id.type, "number");
check("non-integer-like number stays number", one({ name: "a", inputSchema: { type: "object", properties: { ratio: { type: "number" } } } }).parameters.properties.ratio.type, "number");
checkDeep("schema-valued additionalProperties retained", one({ name: "a", inputSchema: { type: "object", properties: {}, additionalProperties: { type: "string" } } }).parameters.additionalProperties, { type: "string" });
check("boolean additionalProperties kept", one({ name: "a", inputSchema: { type: "object", properties: {}, additionalProperties: false } }).parameters.additionalProperties, false);
checkDeep("array tuples retained", one({ name: "a", inputSchema: { type: "object", properties: { l: { type: "array", items: [{ type: "number" }, { type: "string" }] } } } }).parameters.properties.l.items, [{ type: "number" }, { type: "string" }]);
check("array items: missing stays missing", "items" in one({ name: "a", inputSchema: { type: "object", properties: { l: { type: "array" } } } }).parameters.properties.l, false);

const faithful = {
	$schema: "http://json-schema.org/draft-07/schema#",
	title: "tool", description: "desc", type: "object",
	properties: { count: { type: "number", default: 1.5 }, flag: true },
	allOf: [{ required: ["count"] }, { minProperties: 1 }],
	additionalProperties: false,
};
const before = JSON.stringify(faithful);
const prepared = one({ name: "a", inputSchema: faithful }).parameters;
checkDeep("annotations, boolean schemas and composites retained", prepared, faithful);
check("host schema was not mutated", JSON.stringify(faithful), before);
prepared.properties.count.type = "string";
check("advertised schema does not alias host schema", faithful.properties.count.type, "number");
checkDeep("standard format preserved", one({
	name: "date", inputSchema: { properties: { timestamp: { type: "string", format: "date-time" } } },
}).parameters.properties.timestamp, { type: "string", format: "date-time" });

for (const schema of [
	[], { type: "object", required: ["x", 1, null] }, { required: "x" },
	{ type: "string" }, { type: "array", items: { type: "string" } },
	{ $schema: "x" }, { properties: { nested: { type: "object", nope: 1 } } },
	{ properties: { date: { type: "string", format: "unknown-custom-format" } } },
	{ $ref: "https://example.invalid/schema" },
]) {
	const logs = [];
	const original = console.error;
	console.error = (...args) => logs.push(args);
	let payload;
	try {
		payload = buildToolPayload([{ name: "bad", inputSchema: schema }, { name: "good" }], true);
	} finally {
		console.error = original;
	}
	check("invalid schema skipped without breaking request", payload.tools.length, 1);
	check("remaining tool is forced in required mode", payload.tool_choice.function.name, "good");
	check("invalid schema gets a diagnostic", logs.length, 1);
}
const duplicates = silent(() => buildToolPayload([{ name: "same", description: "first" }, { name: "same", description: "second" }], true));
check("exact duplicate host name is skipped", duplicates.tools.length, 1);
check("first duplicate wins", duplicates.tools[0].function.description, "first");
checkDeep("all invalid schemas omit tools", silent(() => buildToolPayload([{ name: "bad", inputSchema: [] }], true)), {});

// --- skips (already covered in unit_tool_limit; one representative here) ---
const skipped = silent(() => buildToolPayload([{ name: "ok" }, { name: "" }, null, { name: 7 }], false));
check("unusable entries skipped, usable kept", skipped.tools.length, 1);
summary("unit_tool_payload");
