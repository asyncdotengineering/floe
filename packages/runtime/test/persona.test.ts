import { describe, expect, it } from 'vitest';
import { renderPersona } from '../src/prompt-build.ts';

describe('persona', () => {
	it('returns null when undefined', () => {
		expect(renderPersona(undefined)).toBeNull();
	});

	it('returns null when persona has no useful fields', () => {
		expect(renderPersona({})).toBeNull();
		expect(renderPersona({ avoidPhrases: [], notes: [] })).toBeNull();
	});

	it('renders voice + tone + register as Markdown bullets', () => {
		const out = renderPersona({
			voice: 'warm and curious',
			tone: 'patient',
			register: 'casual',
		});
		expect(out).toContain('# Persona');
		expect(out).toContain('**Voice**: warm and curious');
		expect(out).toContain('**Tone**: patient');
		expect(out).toContain('**Register**: casual');
	});

	it('renders avoidPhrases and signatureTransitions with quoting', () => {
		const out = renderPersona({
			avoidPhrases: ['I understand your frustration', 'unfortunately'],
			signatureTransitions: ['Hmm, let me think...'],
		});
		expect(out).toContain('"I understand your frustration"');
		expect(out).toContain('"unfortunately"');
		expect(out).toContain('"Hmm, let me think..."');
	});

	it('appends free-form notes as bullets', () => {
		const out = renderPersona({ notes: ['Always end with a question'] });
		expect(out).toContain('- Always end with a question');
	});

	it('includes pronouns when set', () => {
		const out = renderPersona({ pronouns: 'they/them' });
		expect(out).toContain('**Pronouns**: they/them');
	});
});
