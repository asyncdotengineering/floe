/**
 * Floe server for the MCP example. Boots once, lazy-connects to the MCP
 * server on the first turn. See ./mcp-stub-server.ts for the stub.
 */
import { runServer } from '@floe/server-bootstrap';
import inventory from './floe.config.ts';

await runServer(inventory);
