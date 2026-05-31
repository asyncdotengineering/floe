/**
 * Identity + TenantId — partition primitives.
 *
 * Per REFACTOR-FIN-HARNESS §3.6 + §4.4: identity is a request-level
 * concern, resolved ONCE at the HTTP boundary (not per-conversation),
 * and travels with the request context into every store call, tool
 * execution, and memory query.
 *
 * This file ships the bare types. C-2 lands the `IdentityResolver`
 * implementations + the `bin/migrate-c2-tenant.ts` script that adds
 * `tenant_id` columns to existing Turso tables.
 */

/** Opaque tenant key — partition primitive on every store operation. */
export type TenantId = string;

export interface Identity {
	tenantId: TenantId;
	userId?: string;
	channelId?: string;
	/** Source channel/transport (web, slack, voice, openai_compat). */
	source?: string;
	/** Free-form metadata propagated from the HTTP request. */
	metadata?: Record<string, unknown>;
}
