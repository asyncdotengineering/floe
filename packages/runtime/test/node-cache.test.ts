import { describe, expect, it } from 'vitest';
import {
	_clearAllNodeCaches,
	cacheNode,
	clearFlowCache,
	getCachedNode,
} from '../src/node-cache.ts';
import type { Node } from '../src/types.ts';

function makeNode(name: string): Node<undefined> {
	return {
		name,
		prompt: 'noop',
		async handler() {
			return { kind: 'end' };
		},
	} as unknown as Node<undefined>;
}

describe('node-cache', () => {
	it('returns undefined on a clean miss', () => {
		_clearAllNodeCaches();
		expect(getCachedNode('inst-a', 'refund', 'check-eligibility')).toBeUndefined();
	});

	it('round-trips a cached node by (instanceId, flowName, nodeName)', () => {
		_clearAllNodeCaches();
		const node = makeNode('check-eligibility');
		cacheNode('inst-a', 'refund', node);
		expect(getCachedNode('inst-a', 'refund', 'check-eligibility')).toBe(node);
	});

	it('isolates cache entries across conversation instances', () => {
		_clearAllNodeCaches();
		const nodeA = makeNode('ask');
		const nodeB = makeNode('ask');
		cacheNode('inst-a', 'refund', nodeA);
		cacheNode('inst-b', 'refund', nodeB);
		// Same flow + node name, but different instance → different objects.
		expect(getCachedNode('inst-a', 'refund', 'ask')).toBe(nodeA);
		expect(getCachedNode('inst-b', 'refund', 'ask')).toBe(nodeB);
	});

	it('isolates cache entries across flow names', () => {
		_clearAllNodeCaches();
		const refundNode = makeNode('start');
		const signupNode = makeNode('start');
		cacheNode('inst-a', 'refund', refundNode);
		cacheNode('inst-a', 'signup', signupNode);
		expect(getCachedNode('inst-a', 'refund', 'start')).toBe(refundNode);
		expect(getCachedNode('inst-a', 'signup', 'start')).toBe(signupNode);
	});

	it('clearFlowCache removes only the targeted flow', () => {
		_clearAllNodeCaches();
		cacheNode('inst-a', 'refund', makeNode('x'));
		cacheNode('inst-a', 'signup', makeNode('y'));
		clearFlowCache('inst-a', 'refund');
		expect(getCachedNode('inst-a', 'refund', 'x')).toBeUndefined();
		expect(getCachedNode('inst-a', 'signup', 'y')).toBeDefined();
	});
});
