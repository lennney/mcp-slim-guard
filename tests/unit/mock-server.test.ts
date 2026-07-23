/**
 * Tests for Mock MCP Server.
 *
 * Tests the tool handler logic directly without spawning subprocesses.
 * The mock server is mainly for integration tests (Task 13), so these
 * unit tests are minimal.
 */

/**
 * Tests for Mock MCP Server.
 *
 * Tests the tool handler logic directly without spawning subprocesses.
 * The mock server is mainly for integration tests (Task 13), so these
 * unit tests are minimal.
 */

import { describe, it, expect } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Import the SUT — note: startMockServer() is not called here because it
// connects to STDIO transport; we test the handler functions directly.
// ---------------------------------------------------------------------------
import { handleEcho, handleAdd, handleGetTime, startMockServer } from "../../src/mock-server.js";

// ---------------------------------------------------------------------------
// Helper: extract text from a CallToolResult content entry
// ---------------------------------------------------------------------------
function getTextContent(content: Array<{ type: string; text?: string }>): string {
  const entry = content[0];
  if (!entry || entry.type !== "text" || entry.text === undefined) {
    throw new Error("Expected text content");
  }
  return entry.text;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MockMcpServer", () => {
  // 1. Module exports exist
  it("should export startMockServer function", () => {
    expect(startMockServer).toBeDefined();
    expect(typeof startMockServer).toBe("function");
  });

  // 2. Echo handler returns echoed message
  it("handleEcho should echo back the input message", async () => {
    const result = await handleEcho({ message: "hello world" });
    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toHaveProperty("type", "text");
    const text = getTextContent(result.content);
    const parsed = JSON.parse(text);
    expect(parsed).toEqual({ echoed: "hello world" });
  });

  // 3. Echo handler handles special characters
  it("handleEcho should handle special characters", async () => {
    const result = await handleEcho({ message: 'a"b{c}' });
    const text = getTextContent(result.content);
    const parsed = JSON.parse(text);
    expect(parsed).toEqual({ echoed: 'a"b{c}' });
  });

  // 4. Add handler returns correct sum
  it("handleAdd should return the sum of two numbers", async () => {
    const result = await handleAdd({ a: 3, b: 4 });
    expect(getTextContent(result.content)).toBe("7");
  });

  // 5. Add handler handles negative numbers
  it("handleAdd should handle negative numbers", async () => {
    const result = await handleAdd({ a: -5, b: 10 });
    expect(getTextContent(result.content)).toBe("5");
  });

  // 6. Add handler handles zero
  it("handleAdd should handle zero values", async () => {
    const result = await handleAdd({ a: 0, b: 0 });
    expect(getTextContent(result.content)).toBe("0");
  });

  // 7. GetTime handler returns ISO timestamp
  it("handleGetTime should return an ISO timestamp", async () => {
    const result = await handleGetTime();
    const timeStr = getTextContent(result.content);
    // ISO 8601 format: 2026-07-20T...
    expect(timeStr).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  // 8. GetTime handler returns current time (within reasonable window)
  it("handleGetTime should return a time close to now", async () => {
    const before = Date.now();
    const result = await handleGetTime();
    const after = Date.now();
    const timeStr = getTextContent(result.content);
    const returnedTime = new Date(timeStr).getTime();
    expect(returnedTime).toBeGreaterThanOrEqual(before);
    expect(returnedTime).toBeLessThanOrEqual(after);
  });

  // 9. McpServer can be instantiated with mock config
  it("should create McpServer with mock config", () => {
    const server = new McpServer({
      name: "mock-mcp-server",
      version: "1.0.0",
    });
    expect(server).toBeDefined();
    expect(server.server).toBeDefined();
  });

  // 10. Tools can be registered on the server
  it("should register tools without throwing", () => {
    const server = new McpServer({
      name: "mock-mcp-server",
      version: "1.0.0",
    });

    expect(() => {
      server.registerTool(
        "echo",
        {
          description: "Echoes back the input message",
          inputSchema: { message: z.string() },
        },
        async ({ message }: { message: string }) => handleEcho({ message }),
      );
    }).not.toThrow();

    expect(() => {
      server.registerTool(
        "add",
        {
          description: "Adds two numbers",
          inputSchema: { a: z.number(), b: z.number() },
        },
        async ({ a, b }: { a: number; b: number }) => handleAdd({ a, b }),
      );
    }).not.toThrow();

    expect(() => {
      server.registerTool(
        "get_time",
        {
          description: "Returns current timestamp",
        },
        async () => handleGetTime(),
      );
    }).not.toThrow();
  });
});
