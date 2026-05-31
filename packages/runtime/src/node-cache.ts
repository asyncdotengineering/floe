/**
 * Process-local cache of Node objects keyed by conversation instance + flow.
 *
 * Nodes returned from `handler()` are runtime objects (with closures, schemas,
 * tool refs) — they aren't JSON-serializable. We can't stash them in
 * `session.metadata.floe` without bloating it and losing closure references.
 *
 * Instead: cache in process memory. State holds only the node name; the
 * orchestrator resolves the name to a live Node via this cache.
 *
 * **Cache miss semantics**: on Node restart or CF DO hibernation, the cache
 * is empty. The orchestrator falls back to the flow's `startNode()`. The
 * user's `state.activeFlow.data` is preserved (it was persisted), so they
 * keep their context — they just re-enter the flow start. This is the
 * pragmatic v1 trade-off; v1.x can add a persistent node registry.
 */
import type { Node } from './types.ts';

const cache = new Map<string, Map<string, Node>>();

function key(instanceId: string, flowName: string): string {
	return `${instanceId}::${flowName}`;
}

export function cacheNode(
	instanceId: string,
	flowName: string,
	node: Node,
): void {
	const k = key(instanceId, flowName);
	let inner = cache.get(k);
	if (!inner) {
		inner = new Map();
		cache.set(k, inner);
	}
	inner.set(node.name, node);
}

export function getCachedNode(
	instanceId: string,
	flowName: string,
	nodeName: string,
): Node | undefined {
	return cache.get(key(instanceId, flowName))?.get(nodeName);
}

export function clearFlowCache(instanceId: string, flowName: string): void {
	cache.delete(key(instanceId, flowName));
}

/** For tests. */
export function _clearAllNodeCaches(): void {
	cache.clear();
}
