/**
 * Minimal valibot → JSON Schema converter, sufficient for the v1
 * mock-service catalog (flat objects with string/number/boolean/enum
 * properties + required-fields list).
 *
 * Users with richer schemas can wrap `defineMockService` and pass a
 * pre-built JSON Schema directly via the operation — but every domain
 * in v1 fits this subset, so the conversion is a one-shot helper, not
 * a public API.
 */
import * as v from 'valibot';

interface JsonSchemaProperty {
	type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object';
	description?: string;
	enum?: string[];
	items?: JsonSchemaProperty;
	properties?: Record<string, JsonSchemaProperty>;
}

export interface JsonSchema {
	type: 'object';
	properties: Record<string, JsonSchemaProperty>;
	required: string[];
	additionalProperties?: boolean;
}

export function valibotToJsonSchema(
	schema: v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>,
): JsonSchema {
	const root = unwrap(schema);
	if (root.type !== 'object') {
		throw new Error(`[mock-services:jsonschema] only object schemas supported at root, got ${root.type}`);
	}
	const properties: Record<string, JsonSchemaProperty> = {};
	const required: string[] = [];
	const entries = (root as v.ObjectSchema<v.ObjectEntries, undefined>).entries;
	for (const [key, propSchema] of Object.entries(entries)) {
		const { schema: inner, optional } = peelOptional(propSchema as v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>);
		properties[key] = toJsonProperty(inner);
		if (!optional) required.push(key);
	}
	return {
		type: 'object',
		properties,
		required,
		additionalProperties: false,
	};
}

function unwrap(
	schema: v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>,
): v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>> {
	let s = schema;
	while (s.type === 'pipe') {
		s = (s as unknown as { pipe: v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>[] }).pipe[0]!;
	}
	return s;
}

function peelOptional(
	schema: v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>,
): { schema: v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>; optional: boolean } {
	if (schema.type === 'optional') {
		return {
			schema: (schema as unknown as { wrapped: v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>> }).wrapped,
			optional: true,
		};
	}
	return { schema, optional: false };
}

function toJsonProperty(
	schema: v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>,
): JsonSchemaProperty {
	const inner = unwrap(schema);
	switch (inner.type) {
		case 'string':
			return { type: 'string' };
		case 'number':
			return { type: 'number' };
		case 'boolean':
			return { type: 'boolean' };
		case 'picklist': {
			const options = (inner as unknown as { options: readonly string[] }).options;
			return { type: 'string', enum: [...options] };
		}
		case 'array': {
			const item = (inner as unknown as {
				item: v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>;
			}).item;
			return { type: 'array', items: toJsonProperty(item) };
		}
		case 'object': {
			const sub = valibotToJsonSchema(inner);
			return {
				type: 'object',
				properties: sub.properties,
			};
		}
		default:
			// Fallback — treat unknown leaf schemas as strings. Hits e.g.
			// `v.union` (we don't use unions in v1 ops); the mock will
			// still pass the raw value through to the handler.
			return { type: 'string' };
	}
}
