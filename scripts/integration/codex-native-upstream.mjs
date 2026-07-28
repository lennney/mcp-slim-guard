#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({
  name: "codex-native-acceptance-upstream",
  version: "1.0.0",
});

server.registerTool(
  "add",
  {
    description: "Adds two numbers",
    inputSchema: { a: z.number(), b: z.number() },
  },
  async ({ a, b }) => ({
    content: [{ type: "text", text: String(a + b) }],
  }),
);

server.registerTool(
  "large_text",
  {
    description: "Returns a large deterministic text whose exact final marker must be recovered",
  },
  async () => {
    const lines = Array.from(
      { length: 240 },
      (_, index) => `acceptance-line-${String(index + 1).padStart(3, "0")}:${"x".repeat(180)}`,
    );
    lines.push("EXACT-END-MARKER:SLIM-GUARD-CODEX-NATIVE-RECOVERY-PASSED");
    return {
      content: [{ type: "text", text: lines.join("\n") }],
    };
  },
);

await server.connect(new StdioServerTransport());
