---
name: return-policy
triggers: ["return", "refund", "exchange", "send back", "money back"]
escalate-when: "customer threatens chargeback, legal action, or social-media escalation"
---

# Return Policy

Acme accepts returns based on the age of the order:

- **Within 30 days of delivery**: full refund to the original payment method, free return shipping label included.
- **31-90 days**: 50% store credit. The customer pays return shipping ($7 flat).
- **Over 90 days**: not eligible. Offer store credit at the agent's discretion in $25 increments for clearly defective items.

Final sale items (marked with `-FS` SKU suffix) and intimate apparel are non-returnable regardless of age.

When the customer is upset, lead with empathy. Never promise refunds the system doesn't grant. If the case feels off-policy, escalate to a billing manager.

Eligibility is computed deterministically from the invoice's `ageDays` field — never reason about it in prose. The check-eligibility flow node handles the math; you only quote the resulting amount.
