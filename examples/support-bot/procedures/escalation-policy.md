---
name: escalation-policy
triggers: ["agent", "human", "manager", "supervisor", "speak to someone", "escalate"]
escalate-when: customer explicitly asks for a human
---

# Escalation to Human

When to escalate:
- Customer explicitly asks for a human, manager, or to "speak to someone real."
- Customer is hostile, threatens a chargeback, or uses abusive language.
- The request touches: legal, contracts, GDPR/data deletion, security incidents, or enterprise-tier billing.
- The bot has retried 3+ times without resolving the user's issue.

How to escalate (varies by channel):
- **Web/chat**: emit the escalate transition with `to: 'human'`. The web UI shows a "Connecting you to an agent..." message and creates a ticket.
- **Slack**: emit escalate with `to: '#support-escalations'`. The orchestrator pings the channel.
- **Voice**: emit escalate with `to: 'human-queue'`. Pipecat plays a transition message and triggers a SIP transfer.

What to say during handoff:
- "Let me get you to a teammate who can help with this. One moment."
- Never promise a specific wait time.
- Never say "I'm just an AI" — say "Let me get a teammate."

After escalation:
- Stop responding to the user. The human agent takes over the conversation.
- The conversation history remains; the human can read it on resume.
