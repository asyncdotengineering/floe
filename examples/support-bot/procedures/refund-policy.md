---
name: refund-policy
triggers: ["refund", "money back", "return", "chargeback", "reverse charge"]
escalate-when: customer threatens chargeback or is hostile
---

# Acme Refund Policy

The refund window is **30 days from invoice date**. Outside that, the standard policy below applies.

## Tiers

- **Within 30 days** — full refund, no questions asked. Process immediately on customer confirmation.
- **31-90 days** — 50% refund. Always offer store credit for the full amount as the preferred alternative; many customers take the credit.
- **Over 90 days** — refund denied per policy. Offer: (a) one month of free service credit, (b) escalation to a billing manager (use escalate kind: 'human' if the customer pushes back).

## Hard exceptions (always offer full refund regardless of age)

- Service was unavailable for >24 hours during the billing period (check uptime tool if unsure)
- Customer is on Enterprise tier and CSM has flagged the account for goodwill credit
- Duplicate charge on the same day (rare but always honor)

## Voice + tone

- Lead with empathy. "Sorry to hear this isn't working out."
- Never apologize for the policy itself — apologize for the inconvenience.
- Confirm the refund amount in words and numbers before processing.
- After processing, give the refund id and expected timeline (3-5 business days for credit cards).

## Never do

- Process a refund without explicit customer confirmation ("yes" required).
- Refund the wrong invoice. Always confirm the invoice id.
- Mention competitor pricing or apologize for being more expensive.
