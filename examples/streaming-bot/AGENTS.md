# Streaming-Bot

A single-agent help-center FAQ assistant.

- One agent (`faq`), no triage call (triage: 'first-agent' skips the LLM call)
- Knowledge: workspaceBm25 over `knowledge/*.md`
- No flows, no procedures, no validators in the gate path

The point: show the lower bound on TTFT when the path is one LLM call with retrieval.
