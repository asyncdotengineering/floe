/**
 * Node server. Uses `runServer` from `@floe/server-bootstrap` to handle
 * port binding, graceful shutdown, and the bench harness's metrics
 * envelope. The `metrics: true` default is what populates `result.stream`
 * on every JSON response — bench tests assert against that shape.
 */
import { runServer } from '@floe/server-bootstrap';
import concierge from './floe.config.ts';

await runServer(concierge);
