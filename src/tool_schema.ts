import Ajv from "ajv";
import addFormats from "ajv-formats";

const draft7 = "http://json-schema.org/draft-07/schema";
const dialects = new Set([draft7, `${draft7}#`, draft7.replace("http:", "https:"), `${draft7.replace("http:", "https:")}#`]);
const supportedKeywords = new Set([
	"$schema", "$id", "$ref", "$comment", "definitions",
	"type", "enum", "const", "title", "description", "default", "examples",
	"readOnly", "writeOnly", "contentMediaType", "contentEncoding",
	"multipleOf", "maximum", "exclusiveMaximum", "minimum", "exclusiveMinimum",
	"maxLength", "minLength", "pattern", "format",
	"items", "additionalItems", "maxItems", "minItems", "uniqueItems", "contains",
	"maxProperties", "minProperties", "required", "properties", "patternProperties",
	"additionalProperties", "dependencies", "propertyNames",
	"if", "then", "else", "allOf", "anyOf", "oneOf", "not",
]);
const schemaMaps = new Set(["properties", "patternProperties", "definitions"]);
const schemaValues = new Set([
	"additionalProperties", "additionalItems", "contains", "propertyNames", "if", "then", "else", "not",
]);

function snapshot(value: unknown, ancestors = new Set<object>()): unknown {
	if (value === null || typeof value === "string" || typeof value === "boolean") {
		return value;
	}
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	if (!value || typeof value !== "object") {
		throw new Error("Tool schema must contain only JSON values");
	}
	if (ancestors.has(value)) {
		throw new Error("Tool schema contains a circular reference");
	}
	ancestors.add(value);
	try {
		return Array.isArray(value)
			? value.map((entry) => snapshot(entry, ancestors))
			: Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, snapshot(entry, ancestors)]));
	} finally {
		ancestors.delete(value);
	}
}

function checkSupport(schema: unknown, formats: Set<string>, path = "#"): void {
	if (typeof schema === "boolean") {
		return;
	}
	if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
		throw new Error(`Invalid tool schema at ${path}: expected an object or boolean`);
	}
	for (const [keyword, value] of Object.entries(schema)) {
		if (!supportedKeywords.has(keyword)) {
			throw new Error(`Unsupported tool schema keyword "${keyword}" at ${path}`);
		}
		if (keyword === "$schema" && (typeof value !== "string" || !dialects.has(value))) {
			throw new Error(`Unsupported tool schema dialect at ${path}: ${String(value)} (expected draft-07)`);
		}
		if (keyword === "format" && (typeof value !== "string" || !formats.has(value))) {
			throw new Error(`Unsupported tool schema format at ${path}: ${String(value)}`);
		}
		if (schemaMaps.has(keyword) && value && typeof value === "object" && !Array.isArray(value)) {
			for (const [name, child] of Object.entries(value)) {
				if (name === "__proto__") {
					throw new Error(`Unsupported tool schema property "__proto__" at ${path}/${keyword}: Ajv omits this key`);
				}
				checkSupport(child, formats, `${path}/${keyword}/${name}`);
			}
		} else if (keyword === "dependencies" && value && typeof value === "object" && !Array.isArray(value)) {
			for (const [name, child] of Object.entries(value)) {
				if (name === "__proto__") {
					throw new Error(`Unsupported tool schema dependency "__proto__" at ${path}: Ajv omits this key`);
				}
				if (!Array.isArray(child)) {
					checkSupport(child, formats, `${path}/${keyword}/${name}`);
				}
			}
		} else if (schemaValues.has(keyword) || keyword === "items") {
			if (keyword === "items" && Array.isArray(value)) {
				value.forEach((child, i) => checkSupport(child, formats, `${path}/items/${i}`));
			} else {
				checkSupport(value, formats, `${path}/${keyword}`);
			}
		} else if (["allOf", "anyOf", "oneOf"].includes(keyword) && Array.isArray(value)) {
			value.forEach((child, i) => checkSupport(child, formats, `${path}/${keyword}/${i}`));
		}
	}
}

function compileSchema(schema: Record<string, unknown>) {
	// One instance per schema prevents host $id collisions and offers no remote
	// resolver: unresolved references fail compilation, without network access.
	const ajv = new Ajv({
		allErrors: true,
		ownProperties: true,
		coerceTypes: false,
		useDefaults: false,
		removeAdditional: false,
		strictSchema: true,
		strictTypes: false,
		strictTuples: false,
		strictRequired: false,
	});
	addFormats(ajv, { mode: "full", keywords: false });
	checkSupport(schema, new Set(Object.keys(ajv.formats)));
	const meta = ajv.getSchema(draft7)?.schema;
	if (meta && typeof meta === "object") {
		ajv.addMetaSchema(meta, draft7.replace("http:", "https:"));
	}
	try {
		return { ajv, validate: ajv.compile(schema) };
	} catch (error) {
		throw new Error(`Invalid tool schema: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function snapshotSchema(schema: unknown): Record<string, unknown> {
	const prepared = snapshot(schema ?? { type: "object", properties: {} });
	if (!prepared || typeof prepared !== "object" || Array.isArray(prepared)) {
		throw new Error("Tool parameters schema must be an object");
	}
	const result = prepared as Record<string, unknown>;
	if ((typeof result.type === "string" && result.type !== "object")
		|| (Array.isArray(result.type) && !result.type.includes("object"))) {
		throw new Error("Tool parameters schema root type must allow object arguments");
	}
	return result;
}

/** Preserve the host's schema rather than weakening its validation semantics. */
export function prepareToolSchema(schema: unknown): Record<string, unknown> {
	const result = snapshotSchema(schema);
	compileSchema(result);
	return result;
}

/** Compile once; reject invalid arguments without coercion, defaults, or mutation. */
export function createToolArgumentValidator(schema?: unknown): (args: unknown) => void {
	const { ajv, validate } = compileSchema(snapshotSchema(schema));
	return (args) => {
		if (!args || typeof args !== "object" || Array.isArray(args)) {
			throw new Error("Tool arguments must be a non-null JSON object");
		}
		if (!validate(args)) {
			throw new Error(`Invalid tool arguments: ${ajv.errorsText(validate.errors, { separator: "; " })}`);
		}
	};
}
