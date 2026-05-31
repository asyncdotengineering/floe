# campus-bot

A Floe template for a university student-relationship assistant.
Three specialist roles (academic-advisor, financial-aid, wellbeing),
six lookup tools, an add/drop course flow, and policy knowledge for
SAP, withdrawal, aid, and campus wellbeing resources.

## What you get out of the box

- **Coordinator host** that delegates to one of three specialists, or
  answers simple lookups directly.
- **Mock data** for two students (`s_001` Maya Tan — junior, CS, good
  standing; `s_002` Jordan Park — sophomore, undeclared, on probation)
  so the lookup tools return realistic data immediately.
- **Add/drop flow** that switches behavior based on the current week of
  the term (set `CAMPUS_MOCK_TERM_WEEK` to test different windows).
- **Knowledge** covering academic policies, financial aid policies, and
  wellbeing resources — indexed via the workspace BM25 retriever.
- **Citation guidance** set to `'optional'` — the runtime's streaming
  sanitizer strips any hallucinated non-numeric brackets, so the audit
  trail stays clean across model providers.

## Run it

```bash
pnpm install
pnpm --filter campus-bot dev
```

Listens on `http://localhost:3000`. Try:

```bash
curl -N -X POST http://localhost:3000/agents/web/test-1 \
  -H 'content-type: application/json' \
  -H 'accept: text/event-stream' \
  -d '{"message":"I am maya.tan@uni.example. Am I on track for graduation?"}'
```

Other prompts to exercise different paths:

- `"What's the SAP rule for financial aid?"` — financial-aid role + knowledge
- `"I want to drop CS 351"` — triggers add-drop flow
- `"I've been feeling really overwhelmed lately"` — wellbeing role, surfaces Care Line
- `"What deadlines do I have coming up?"` — listUpcomingDeadlines tool

## Production checklist

- Replace the inline `STUDENTS`, `ENROLLMENTS`, `AID_PACKAGES`,
  `COURSE_CATALOG`, `DEADLINES` mocks with real SIS / Banner / Workday
  reads. The tool shapes stay the same; the bot prompts don't change.
- Replace `currentWeek()` in `flows/add-drop.ts` with a real term-
  calendar lookup.
- Wire the wellbeing role's crisis lines to your campus's actual lines.
- Decide whether to enable voice (`/voice/turn`) — the gateway needs to
  resolve a `studentId` or `email` in metadata before the turn lands.
