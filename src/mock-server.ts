#!/usr/bin/env node
/**
 * Mock MCP Server for integration testing.
 *
 * A lightweight MCP server that:
 * 1. Can be spawned as a subprocess (receives STDIO transport)
 * 2. Exposes test tools that return predictable results
 * 3. Uses the same UpstreamServer config format: {command, args, env}
 *
 * @module mock-server
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/**
 * Handler for the "echo" tool.
 * Echoes back the input message.
 */
export async function handleEcho(args: {
  message: string;
}): Promise<CallToolResult> {
  return {
    content: [{ type: "text", text: JSON.stringify({ echoed: args.message }) }],
  };
}

/**
 * Handler for the "add" tool.
 * Adds two numbers and returns the result.
 */
export async function handleAdd(args: {
  a: number;
  b: number;
}): Promise<CallToolResult> {
  return {
    content: [{ type: "text", text: String(args.a + args.b) }],
  };
}

/**
 * Handler for the "get_time" tool.
 * Returns the current timestamp as an ISO string.
 */
export async function handleGetTime(): Promise<CallToolResult> {
  return {
    content: [{ type: "text", text: new Date().toISOString() }],
  };
}

/**
 * Starts the mock MCP server.
 * Creates an McpServer instance, registers test tools,
 * and connects to STDIO transport.
 */
export async function startMockServer(): Promise<void> {
  const server = new McpServer({
    name: "mock-mcp-server",
    version: "1.0.0",
  });

  server.registerTool(
    "echo",
    {
      description: "Echoes back the input message",
      inputSchema: { message: z.string() },
    },
    async ({ message }) => handleEcho({ message }),
  );

  server.registerTool(
    "add",
    {
      description: "Adds two numbers and returns the result",
      inputSchema: { a: z.number(), b: z.number() },
    },
    async ({ a, b }) => handleAdd({ a, b }),
  );

  server.registerTool(
    "get_time",
    {
      description: "Returns current timestamp as ISO string",
    },
    async () => handleGetTime(),
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  startMockServer().catch(console.error);
}
