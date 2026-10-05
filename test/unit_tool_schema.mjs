import { check, checkDeep, checkMatch, summary } from "./helpers/check.mjs";
import { createToolArgumentValidator, prepareToolSchema } from "../out/tool_schema.js";
import Ajv from "ajv";

function failure(fn) {
	try {
		fn();
		return "";
	} catch (error) {
		return error.message;
	}
}
const valid = (validator, args) => failure(() => validator(args)) === "";
const field = (schema) => createToolArgumentValidator({
	type: "object", properties: { value: schema }, required: ["value"], additionalProperties: false,
});
check("omitted schema accepts object arguments", valid(createToolArgumentValidator(), {}), true);
check("omitted schema still rejects non-object arguments", valid(createToolArgumentValidator(), []), false);

for (const schema of [undefined, null, {}]) {
	const validator = createToolArgumentValidator(schema);
	check("no constraints accepts object", valid(validator, { any: 1 }), true);
	for (const args of [null, undefined, [], "{}", 1, true]) {
		check("all schemas still require object argument root", valid(validator, args), false);
	}
}
checkDeep("missing schema has empty object schema", prepareToolSchema(undefined), { type: "object", properties: {} });
for (const type of ["string", "array", "number", "integer", "boolean", "null", ["string", "array"]]) {
	checkMatch("non-object root schema rejected before advertising", failure(() => prepareToolSchema({ type })), /root type must allow object/);
	checkMatch("non-object root validator fails compilation explicitly", failure(() => createToolArgumentValidator({ type })), /root type must allow object/);
}
const rootUnion = createToolArgumentValidator({ type: ["object", "null"] });
check("object-containing root union is accepted", valid(rootUnion, {}), true);
check("nullable root union still requires object call arguments", valid(rootUnion, null), false);
const compositeRoot = createToolArgumentValidator({
	oneOf: [
		{ type: "object", properties: { kind: { const: "first" } }, required: ["kind"] },
		{ type: "object", properties: { kind: { const: "second" } }, required: ["kind"] },
	],
});
check("untyped root with object-based composites is accepted", valid(compositeRoot, { kind: "first" }), true);
check("object-based root composite constraints preserved", valid(compositeRoot, { kind: "unknown" }), false);
for (const schema of [
	[], "object", true, { type: "bogus" }, { required: "name" },
	{ required: ["name", "name"] }, { minimum: "zero" }, { pattern: "[" },
	{ properties: { name: { type: "bogus" } } }, { oneOf: [] },
	{ $ref: "#/definitions/missing" }, { $ref: "https://example.invalid/remote" },
]) {
	check("bad schema compilation fails", failure(() => createToolArgumentValidator(schema)) !== "", true);
}
checkMatch("unsupported keyword is diagnosed", failure(() => createToolArgumentValidator({ unevaluatedProperties: false })), /Unsupported.*keyword.*unevaluatedProperties/);
checkMatch("unused definition unknown keyword is diagnosed", failure(() => createToolArgumentValidator({ definitions: { unused: { unknown: 1 } } })), /Unsupported.*keyword.*unknown/);
checkMatch("unknown format is diagnosed even in unused schema", failure(() => createToolArgumentValidator({ definitions: { unused: { format: "unknown-custom-format" } } })), /Unsupported.*format.*unknown-custom-format/);
for (const name of ["__proto__", "constructor", "toString"]) {
	checkMatch("prototype-named format cannot bypass support check", failure(() => createToolArgumentValidator({ format: name })), /Unsupported.*format/);
}
checkMatch("unsupported dialect is diagnosed", failure(() => createToolArgumentValidator({ $schema: "https://json-schema.org/draft/2020-12/schema" })), /Unsupported.*dialect/);
checkMatch("async schemas cannot bypass synchronous validation", failure(() => createToolArgumentValidator({ $async: true })), /Unsupported.*keyword/);
for (const keyword of ["properties", "patternProperties", "dependencies"]) {
	checkMatch("Ajv-omitted prototype schema key is diagnosed", failure(() => createToolArgumentValidator(JSON.parse(`{"${keyword}":{"__proto__":{"type":"integer"}}}`))), /Unsupported.*__proto__/);
}
check("HTTPS draft-07 dialect resolves locally", valid(createToolArgumentValidator({
	$schema: "https://json-schema.org/draft-07/schema#", type: "object",
}), {}), true);
const circular = {};
circular.properties = { recursive: circular };
checkMatch("circular JS schema fails explicitly", failure(() => createToolArgumentValidator(circular)), /circular/);

const required = createToolArgumentValidator({
	type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false,
});
check("required property is enforced", valid(required, {}), false);
check("extra property is rejected", valid(required, { name: "ok", extra: true }), false);
check("valid required object", valid(required, { name: "ok" }), true);
check("inherited required property does not satisfy requirement", valid(required, Object.create({ name: "inherited" })), false);
const inheritedExtra = Object.assign(Object.create({ extra: true }), { name: "own" });
check("inherited extra property is not a JSON property", valid(required, inheritedExtra), true);
const arbitrary = createToolArgumentValidator({ type: "object", additionalProperties: { type: "integer" } });
check("schema additionalProperties accepts correct type", valid(arbitrary, { first: 1 }), true);
check("schema additionalProperties enforces type", valid(arbitrary, { first: "1" }), false);
check("schema additionalProperties checks own prototype-named key", valid(arbitrary, JSON.parse('{"__proto__":"bad"}')), false);
const specialNames = createToolArgumentValidator({
	properties: { constructor: { type: "string" }, toString: { type: "integer" } },
	required: ["constructor", "toString"], additionalProperties: false,
});
check("Object.prototype properties do not satisfy required", valid(specialNames, {}), false);
check("own prototype-named properties validated normally", valid(specialNames, { constructor: "own", toString: 1 }), true);
check("own prototype-named properties cannot bypass type", valid(specialNames, { constructor: 1, toString: "bad" }), false);

for (const [schema, good, bad] of [
	[{ anyOf: [{ type: "string", minLength: 2 }, { type: "number", minimum: 2 }] }, ["ok", 2.5], [true, "x", 1]],
	[{ oneOf: [{ type: "number" }, { type: "integer" }] }, [1.5], [1, "x"]],
	[{ allOf: [{ type: "number", minimum: 2 }, { maximum: 4 }] }, [2, 4], [1, 5]],
	[{ not: { type: "string" } }, [1, false], ["string"]],
	[{ type: ["string", "null"] }, [null, "ok"], [1]],
	[{ type: "number", exclusiveMinimum: 0, maximum: 3, multipleOf: 0.5 }, [0.5, 3], [0, 3.5, 0.75, "1"]],
	[{ type: "integer", minimum: -1, exclusiveMaximum: 3 }, [-1, 2], [-2, 3, 1.5]],
	[{ type: "string", minLength: 2, maxLength: 4, pattern: "^a" }, ["ab", "abcd"], ["a", "abcde", "bb"]],
	[{ type: "array", minItems: 1, maxItems: 2, uniqueItems: true, items: { type: "integer" } }, [[1], [1, 2]], [[], [1, 2, 3], [1, 1], ["1"]]],
	[{ type: "array", items: [{ type: "number" }, { type: "string" }], additionalItems: false }, [[1, "ok"], [1]], [[1, 2], [1, "ok", true]]],
	[{ type: "array", contains: { const: "needle" } }, [["needle", 1]], [[1, 2]]],
	[{ enum: ["a", "b"] }, ["a", "b"], ["c"]],
	[{ type: "string", format: "uri" }, ["https://example.com/path?q=1", "urn:example:tool"], ["relative/path", "https://bad host/"]],
	[{ type: "string", format: "uri-reference" }, ["relative/path", "#fragment"], ["bad uri with spaces"]],
	[{ type: "string", format: "date-time" }, ["2026-10-05T12:00:00Z", "2024-02-29T00:00:00+01:00"], ["2026-02-29T00:00:00Z", "2026-10-05", "2026-10-05T99:00:00Z"]],
	[{ type: "string", format: "date" }, ["2024-02-29"], ["2026-02-29"]],
	[{ type: "string", format: "email" }, ["tool@example.com"], ["not-an-email"]],
	[{ type: "string", format: "uuid" }, ["123e4567-e89b-12d3-a456-426614174000"], ["not-a-uuid"]],
]) {
	const validator = field(schema);
	for (const value of good) {
		check("schema accepts valid value", valid(validator, { value }), true);
	}
	for (const value of bad) {
		check("schema rejects invalid value", valid(validator, { value }), false);
	}
}
const ref = createToolArgumentValidator({
	$schema: "http://json-schema.org/draft-07/schema#", $id: "https://example.invalid/local",
	type: "object", definitions: { positive: { type: "integer", minimum: 1 } },
	properties: { value: { $ref: "#/definitions/positive" } },
});
check("local references resolve without fetching", valid(ref, { value: 1 }), true);
check("local reference constraints enforced", valid(ref, { value: 0 }), false);
const conditional = createToolArgumentValidator({
	type: "object", properties: { flag: { type: "boolean" }, value: { type: "integer" } },
	if: { properties: { flag: { const: true } }, required: ["flag"] },
	then: { required: ["value"] }, else: { not: { required: ["value"] } },
});
check("conditional then enforced", valid(conditional, { flag: true }), false);
check("conditional else enforced", valid(conditional, { flag: false, value: 1 }), false);
check("conditional valid then", valid(conditional, { flag: true, value: 1 }), true);
const dependent = createToolArgumentValidator({
	type: "object", dependencies: { first: ["second"] }, propertyNames: { pattern: "^[a-z]+$" },
});
check("dependencies enforced", valid(dependent, { first: 1 }), false);
check("propertyNames enforced", valid(dependent, { Upper: 1 }), false);
check("dependencies satisfied", valid(dependent, { first: 1, second: 2 }), true);
const pattern = createToolArgumentValidator({
	type: "object", minProperties: 1, maxProperties: 2,
	patternProperties: { "^x": { type: "integer" } }, additionalProperties: false,
});
check("patternProperties valid", valid(pattern, { x1: 1 }), true);
for (const args of [{}, { x1: "1" }, { unknown: 1 }, { x1: 1, x2: 2, x3: 3 }]) {
	check("pattern and object bounds enforced", valid(pattern, args), false);
}

const schema = {
	type: "object", properties: { count: { type: "number", default: 2 }, text: { type: "string" } },
	required: ["count", "text"], additionalProperties: false,
};
const original = JSON.stringify(schema);
const validator = createToolArgumentValidator(schema);
check("compilation does not mutate schema", JSON.stringify(schema), original);
const args = { count: "2", unexpected: true };
const argsBefore = JSON.stringify(args);
const message = failure(() => validator(args));
checkMatch("all-errors includes required", message, /required property 'text'/);
checkMatch("all-errors includes additionalProperties", message, /additional properties/);
checkMatch("all-errors includes type", message, /must be number/);
check("validation does not coerce or remove properties", JSON.stringify(args), argsBefore);
const missing = { text: "ok" };
check("defaults not inserted", valid(validator, missing), false);
checkDeep("failed validation leaves missing property missing", missing, { text: "ok" });
check("valid fractional count not guessed integer", valid(validator, Object.freeze({ count: 1.5, text: "ok" })), true);
schema.properties.count.type = "string";
check("compiled validator isolated from later schema mutations", valid(validator, { count: 1.5, text: "ok" }), true);
check("separate schema compile with same $id is independent", valid(createToolArgumentValidator({
	$id: "https://example.invalid/local", properties: { value: { type: "string" } },
}), { value: "yes" }), true);

// Instrument the existing compiler to pin reuse/eviction without production
// telemetry or timing assertions that would be flaky on slower runners.
const originalCompile = Ajv.prototype.compile;
let compilationCount = 0;
Ajv.prototype.compile = function (...args) {
	compilationCount++;
	return Reflect.apply(originalCompile, this, args);
};
try {
	const reusable = {
		title: "cache-reuse-fixture", type: "object",
		properties: { value: { enum: [{ nested: { flag: true } }] } },
	};
	const advertised = prepareToolSchema(reusable);
	const firstCompilationCount = compilationCount;
	const originalValidator = createToolArgumentValidator(reusable);
	for (let i = 0; i < 300; i++) {
		createToolArgumentValidator(prepareToolSchema(structuredClone(reusable)));
	}
	check("identical snapshots share compilation across 300 tools", compilationCount, firstCompilationCount);
	advertised.properties.value.enum[0].nested.flag = false;
	check("advertised mutation cannot corrupt cached enum references", valid(originalValidator, { value: { nested: { flag: true } } }), true);
	check("cached validator retains original constraint", valid(originalValidator, { value: { nested: { flag: false } } }), false);
	const changedValidator = createToolArgumentValidator(advertised);
	check("advertised content mutation forces recompilation", compilationCount, firstCompilationCount + 1);
	check("changed schema uses changed constraint", valid(changedValidator, { value: { nested: { flag: false } } }), true);
	reusable.properties.value.enum[0].nested.flag = false;
	const mutatedHostValidator = createToolArgumentValidator(reusable);
	check("host mutation uses changed content key", valid(mutatedHostValidator, { value: { nested: { flag: true } } }), false);
	check("old validators stay isolated after host mutation", valid(originalValidator, { value: { nested: { flag: true } } }), true);

	const collisionSchema = (type) => ({
		$id: "https://example.invalid/cache-root", type: "object",
		definitions: { child: { $id: "https://example.invalid/cache-child", type } },
		properties: { value: { $ref: "https://example.invalid/cache-child" } },
	});
	const strings = createToolArgumentValidator(collisionSchema("string"));
	const integers = createToolArgumentValidator(collisionSchema("integer"));
	check("same root and nested $id do not collide between cached schemas", valid(strings, { value: "string" }) && valid(integers, { value: 1 }), true);
	check("same $id does not cross-contaminate constraints", valid(strings, { value: 1 }) || valid(integers, { value: "string" }), false);
	check("cached $id schema remains reusable independently", valid(createToolArgumentValidator(collisionSchema("string")), { value: "string" }), true);

	const oldest = { title: "cache-oldest-fixture", type: "object" };
	createToolArgumentValidator(oldest);
	const beforeEntries = compilationCount;
	for (let i = 0; i < 128; i++) {
		createToolArgumentValidator({ title: `cache-entry-bound-${i}`, type: "object" });
	}
	check("distinct schema contents compile independently", compilationCount, beforeEntries + 128);
	createToolArgumentValidator(oldest);
	check("128-entry limit evicts old schemas", compilationCount, beforeEntries + 129);

	const recent = { title: "cache-lru-recent", type: "object" };
	const lessRecent = { title: "cache-lru-less-recent", type: "object" };
	createToolArgumentValidator(recent);
	createToolArgumentValidator(lessRecent);
	createToolArgumentValidator(recent);
	for (let i = 0; i < 127; i++) {
		createToolArgumentValidator({ title: `cache-lru-filler-${i}`, type: "object" });
	}
	const beforeLruCheck = compilationCount;
	createToolArgumentValidator(recent);
	check("cache hit refreshes recency", compilationCount, beforeLruCheck);
	createToolArgumentValidator(lessRecent);
	check("less recently used schema is evicted first", compilationCount, beforeLruCheck + 1);

	const large = { title: "a".repeat(700 * 1024), type: "object" };
	const anotherLarge = { title: "b".repeat(700 * 1024), type: "object" };
	createToolArgumentValidator(large);
	const beforeBytes = compilationCount;
	createToolArgumentValidator(anotherLarge);
	createToolArgumentValidator(large);
	check("schema byte budget evicts entries below count limit", compilationCount, beforeBytes + 2);
	const tooLarge = { title: "z".repeat(1024 * 1024), type: "object" };
	const beforeOversize = compilationCount;
	createToolArgumentValidator(tooLarge);
	createToolArgumentValidator(tooLarge);
	check("schemas exceeding byte budget are not retained", compilationCount, beforeOversize + 2);
} finally {
	Ajv.prototype.compile = originalCompile;
}

summary("unit_tool_schema");
