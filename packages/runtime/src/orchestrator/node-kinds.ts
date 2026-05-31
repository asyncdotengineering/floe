/**
 * Predicates for the four Node kinds. See `types.ts` for the union shape
 * + cascading rules.
 */
import type {
	CaptureNode,
	ComputeNode,
	ExtractionNode,
	Node,
	ReplyNode,
} from '../types.ts';

export function isExtractionNode(node: unknown): node is ExtractionNode {
	return (
		typeof node === 'object' &&
		node !== null &&
		(node as Node).kind === 'extraction'
	);
}

export function isCaptureNode(node: unknown): node is CaptureNode {
	return (
		typeof node === 'object' &&
		node !== null &&
		(node as Node).kind === 'capture'
	);
}

export function isComputeNode(node: unknown): node is ComputeNode {
	return (
		typeof node === 'object' &&
		node !== null &&
		(node as Node).kind === 'compute'
	);
}

export function isReplyNode(node: unknown): node is ReplyNode {
	return (
		typeof node === 'object' &&
		node !== null &&
		(node as Node).kind === 'reply'
	);
}
