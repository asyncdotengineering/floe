export { simulateConversation } from './simulate.ts';
export type {
	ScriptedTurn,
	SimulateOptions,
	SimulationResult,
	SimulationTurnResult,
} from './simulate.ts';

/**
 * Faux LLM provider — zero-cost regression testing. Register with
 * scripted responses, address as `model: 'faux/<modelId>'`.
 *
 * @see ./faux.ts for the full helper, response builders, and usage example.
 */
export {
	registerFloeFaux,
	fauxAssistantMessage,
	fauxText,
	fauxThinking,
	fauxToolCall,
} from './faux.ts';
export type {
	FloeFauxOptions,
	FloeFauxHandle,
	FauxResponseStep,
	FauxResponseFactory,
	FauxModelDefinition,
} from './faux.ts';
