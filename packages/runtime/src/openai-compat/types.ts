/**
 * OpenAI-compatible HTTP shapes. The minimal subset Floe implements as a
 * drop-in `LLM service` — `POST /v1/chat/completions` (stream + non-stream),
 * `GET /v1/models`, `POST /v1/embeddings`.
 *
 * Fidelity to OpenAI's wire format is what lets the OpenAI SDK,
 * LangChain, LlamaIndex, AI SDK, OpenWebUI, Cursor, etc. all point at
 * a Floe deployment with just a `baseURL` change.
 *
 * These types are written to match OpenAI's published schema as of 2026
 * (the surface has been stable since 2023). We intentionally use loose
 * `Record<string, unknown>` for fields we accept but don't act on
 * (`temperature`, `top_p`, etc.) — passthrough without dropping.
 */

export interface OpenAIChatMessage {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content: string | null;
	name?: string;
	tool_calls?: OpenAIToolCall[];
	tool_call_id?: string;
}

export interface OpenAIToolCall {
	id: string;
	type: 'function';
	function: { name: string; arguments: string };
}

export interface OpenAIToolDefinition {
	type: 'function';
	function: {
		name: string;
		description?: string;
		parameters?: Record<string, unknown>;
	};
}

export interface OpenAIChatCompletionRequest {
	model: string;
	messages: OpenAIChatMessage[];
	stream?: boolean;
	temperature?: number;
	top_p?: number;
	n?: number;
	max_tokens?: number;
	stop?: string | string[] | null;
	user?: string;
	tools?: OpenAIToolDefinition[];
	tool_choice?: 'none' | 'auto' | { type: 'function'; function: { name: string } };
	/** Floe-specific: pass through to the channel as `metadata`. */
	metadata?: Record<string, unknown>;
	[key: string]: unknown;
}

export interface OpenAIUsage {
	prompt_tokens: number;
	completion_tokens: number;
	total_tokens: number;
}

export interface OpenAIChatCompletionChoice {
	index: number;
	message: { role: 'assistant'; content: string; tool_calls?: OpenAIToolCall[] };
	finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null;
}

export interface OpenAIChatCompletion {
	id: string;
	object: 'chat.completion';
	created: number;
	model: string;
	choices: OpenAIChatCompletionChoice[];
	usage: OpenAIUsage;
	system_fingerprint?: string;
}

export interface OpenAIChatCompletionChunkChoice {
	index: number;
	delta: { role?: 'assistant'; content?: string; tool_calls?: OpenAIToolCall[] };
	finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null;
}

export interface OpenAIChatCompletionChunk {
	id: string;
	object: 'chat.completion.chunk';
	created: number;
	model: string;
	choices: OpenAIChatCompletionChunkChoice[];
}

export interface OpenAIModel {
	id: string;
	object: 'model';
	created: number;
	owned_by: string;
	/** Floe extension: which conversation+agent this id maps to. */
	floe?: {
		conversation: string;
		agent?: string;
	};
}

export interface OpenAIModelList {
	object: 'list';
	data: OpenAIModel[];
}

export interface OpenAIEmbeddingRequest {
	model: string;
	input: string | string[];
	user?: string;
	dimensions?: number;
	encoding_format?: 'float' | 'base64';
}

export interface OpenAIEmbeddingResponse {
	object: 'list';
	data: Array<{ object: 'embedding'; embedding: number[]; index: number }>;
	model: string;
	usage: { prompt_tokens: number; total_tokens: number };
}

export interface OpenAIErrorResponse {
	error: { message: string; type: string; param?: string | null; code?: string | null };
}
