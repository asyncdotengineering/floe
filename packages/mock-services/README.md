# @floe/mock-services

Seedable in-memory mock backends + auto-mounting MCP servers for Floe
templates. Ships 8 v1 domain services (`okta`, `notion`, `linear`,
`subscription`, `order`, `patient-fhir`, `rx`, `billing`) plus a
`defineMockService` primitive for domains we don't bundle.

## Why

The 3 use-case templates (`templates/ops-bot`, `templates/hearth-bot`,
`templates/cedar-health`) each need 3-4 backend mocks that look + behave
like the real APIs they stand in for — Okta directory, FHIR records,
Linear tickets, etc. Before this package they would have been three
copy-pasted MCP stubs. Now they're one `mount<Domain>` call each.

## Two layers

### 1. One-liner `mount<Domain>` (the common case)

```ts
import { mountOkta, mountNotion, mountLinear } from '@floe/mock-services';
import { Assistant } from '@floe/runtime';

const [okta, notion, linear] = await Promise.all([
  mountOkta({ port: 4001 }),
  mountNotion({ port: 4002 }),
  mountLinear({ port: 4003 }),
]);

export const opsBot = new Assistant({
  name: 'ops-bot',
  mcpServers: [okta, notion, linear], // handles are McpServerConfig-shaped
  // ...
});
```

Each `mount<Domain>` returns a handle with `{ name, url, port, stop, reset }`
that drops straight into `Assistant({ mcpServers })`. The bundled seed
loads automatically; override with `seedFile: './my-seed.json'`.

### 2. `defineMockService` + `mountMockMcp` (the off-catalog case)

```ts
import { defineMockService, mountMockMcp } from '@floe/mock-services';
import * as v from 'valibot';

const retention = await defineMockService({
  name: 'retention',
  seed: './seeds/retention.json',
  operations: {
    score_user: {
      description: 'Get churn risk for a user.',
      input: v.object({ userId: v.string() }),
      handler: ({ userId }, store) =>
        store.find((r) => r.userId === userId) ?? { churnRisk: 0 },
    },
  },
});

const handle = await mountMockMcp(retention, { port: 4101 });
```

Same handle shape, same lifecycle. The 8 bundled services are worked
examples of `defineMockService`; read them as templates for your own
domains.

## v1 bundled domains

| domain | mount fn | core operations |
|---|---|---|
| Okta directory | `mountOkta` | `lookup_user_by_email`, `check_group_membership`, `find_manager`, `list_group_members` |
| Notion docs | `mountNotion` | `search_pages`, `get_page`, `list_by_tag` |
| Linear tickets | `mountLinear` | `create_issue`, `list_issues`, `get_issue`, `add_comment`, `update_state` |
| Subscriptions (meal-kit) | `mountSubscription` | `lookup_subscription`, `skip_week`, `pause_subscription`, `cancel_subscription`, `update_address`, `issue_refund` |
| Orders (shipping) | `mountOrders` | `lookup_order`, `list_orders_by_user`, `report_issue` |
| Patient FHIR | `mountPatientFhir` | `verify_identity`, `get_patient`, `list_appointments`, `schedule_appointment`, `reschedule_appointment`, `cancel_appointment` |
| Rx / prescriptions | `mountRx` | `list_for_patient`, `request_refill`, `request_renewal` |
| Billing + insurance | `mountBilling` | `list_invoices_for_patient`, `get_invoice`, `verify_insurance`, `file_dispute` |

Each ships a small but realistic default seed in `seeds/<domain>.json`.

## Latency + failure injection

For matching real-API characteristics in dev/bench:

```ts
await mountLinear({ port: 4003, latencyMs: 80, failRate: 0.05 });
```

## What's NOT in v1

- **No relational joins.** Stores are flat rows keyed by `id`. Compose
  joins in TypeScript when the domain needs them.
- **No persistence.** Stores reset on process restart (and on
  `handle.reset()`). Persistence is out of scope — these are mocks.
- **No protocol-fidelity FHIR / HL7 / SCIM.** The `patient-fhir`
  service is "FHIR-lite" — enough for orchestration, not authentic
  enough for compliance. Swap for a real client at template integration
  time.
