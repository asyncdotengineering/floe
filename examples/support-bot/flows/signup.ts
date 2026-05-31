/**
 * Signup flow — first-principles shape.
 *
 *   collect-signup-info (Extraction) → provision-account (Compute)
 *                                            ├→ welcome (Reply, end)
 *                                            └→ needs-email (Reply, end)
 */
import {
	defineComputeNode,
	defineExtractionNode,
	defineFlow,
	defineReplyNode,
} from '@floe/runtime';
import * as v from 'valibot';

let provisionAccount: ReturnType<typeof defineProvisionAccount>;
let welcome: ReturnType<typeof defineWelcome>;
let needsEmail: ReturnType<typeof defineNeedsEmail>;

const collectSignupInfo = defineExtractionNode({
	name: 'collect-signup-info',
	prompt: `Collect three fields for a new trial signup:

  - **email** — required, a work email.
  - **companyName** — optional, the customer's company.
  - **seatCount** — optional, expected team size.

If they gave any of these in their message, submit them. The email is the only required field; if missing, ask warmly for a work email in ONE short sentence.`,
	schema: v.object({
		email: v.string(),
		companyName: v.optional(v.string()),
		seatCount: v.optional(v.number()),
	}),
	requiredFields: ['email'],
	async onComplete({ email, companyName, seatCount }, ctx) {
		ctx.state.email = email;
		ctx.state.companyName = companyName;
		ctx.state.seatCount = seatCount;
		return { kind: 'node', node: provisionAccount };
	},
});

function defineProvisionAccount() {
	return defineComputeNode({
		name: 'provision-account',
		async compute(ctx) {
			const email = (ctx.state.email as string | undefined) ?? '';
			if (!email) {
				ctx.state.provisionError = 'email_required';
				return { kind: 'node', node: needsEmail };
			}
			const customerId = `cus_${Math.random().toString(36).slice(2, 8)}`;
			ctx.state.customerId = customerId;
			ctx.state.trialEndsOn = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10);
			ctx.state.loginUrl = `https://acme.example/login?token=${customerId}`;
			return { kind: 'node', node: welcome };
		},
	});
}
provisionAccount = defineProvisionAccount();

function defineWelcome() {
	return defineReplyNode({
		name: 'welcome',
		prompt: (ctx) => {
			const s = ctx.state as {
				email: string;
				trialEndsOn: string;
				loginUrl: string;
				companyName?: string;
			};
			return `Welcome the customer to their new Acme trial. ONE warm sentence + a second line with the login link. Plain prose.

# Inputs

- email: ${s.email}
- trialEndsOn: ${s.trialEndsOn}
- loginUrl: ${s.loginUrl}
- companyName: ${s.companyName ?? '(not provided)'}

# Output rules

- MUST contain the literal "${s.trialEndsOn}" AND "${s.loginUrl}".

Example: "Your Acme trial is live${s.companyName ? `, ${s.companyName}` : ''} — it runs through ${s.trialEndsOn}. Log in here: ${s.loginUrl}."`;
		},
		next: { kind: 'end', reason: 'signup flow complete' },
	});
}
welcome = defineWelcome();

function defineNeedsEmail() {
	return defineReplyNode({
		name: 'needs-email',
		prompt: `We couldn't create the trial because no email was provided. Apologize briefly and ask for a work email in ONE short sentence. Plain prose.

Example: "I'll need a work email to set up your trial — what's the best one to use?"`,
		next: { kind: 'end', reason: 'signup blocked: missing email' },
	});
}
needsEmail = defineNeedsEmail();

export const signupFlow = defineFlow({
	name: 'signup',
	description:
		'New-customer signup: extract email + optional company/team-size, create a 14-day trial, confirm. Triggered when a prospect wants to sign up or start a free trial.',
	startNode: () => collectSignupInfo,
});
