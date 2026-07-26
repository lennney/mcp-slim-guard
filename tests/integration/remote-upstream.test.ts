import { createServer, type Server as HttpServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { ServerManager } from "../../src/server-manager.js";

async function listen(server: HttpServer): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Test HTTP server did not expose a TCP port");
  }
  return address.port;
}

describe("remote upstream integration", () => {
  let httpServer: HttpServer | undefined;

  afterEach(async () => {
    delete process.env.SLIM_GUARD_REMOTE_MODE;
    if (httpServer?.listening) {
      await new Promise<void>((resolve, reject) => {
        httpServer!.close((error) => (error ? reject(error) : resolve()));
      });
    }
    httpServer = undefined;
  });

  it("discovers and invokes a real Streamable HTTP MCP server", async () => {
    let receivedMode: string | undefined;
    httpServer = createServer(async (request, response) => {
      if (request.url !== "/mcp") {
        response.writeHead(404).end();
        return;
      }
      receivedMode = request.headers["x-slim-guard-mode"] as string | undefined;

      const mcp = new McpServer({
        name: "remote-integration-server",
        version: "1.0.0",
      });
      mcp.registerTool(
        "echo",
        {
          description: "Echo a remote message",
          inputSchema: { message: z.string() },
        },
        async ({ message }) => ({
          content: [{ type: "text", text: `remote:${message}` }],
          structuredContent: { source: "streamable-http" },
        }),
      );

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      try {
        await mcp.connect(transport);
        response.once("close", () => {
          void mcp.close();
        });
        await transport.handleRequest(request, response);
      } catch {
        if (!response.headersSent) {
          response.writeHead(500).end();
        }
      }
    });

    const port = await listen(httpServer);
    process.env.SLIM_GUARD_REMOTE_MODE = "integration";
    const manager = new ServerManager({
      remote: {
        type: "http",
        url: `http://127.0.0.1:${port}/mcp`,
        headers: {
          "X-Slim-Guard-Mode": "${SLIM_GUARD_REMOTE_MODE}",
        },
      },
    });

    await manager.start();
    try {
      expect(manager.getTools().map((tool) => tool.name)).toContain("remote_echo");
      await expect(manager.callTool("remote", "echo", { message: "hello" })).resolves.toMatchObject({
        content: [{ type: "text", text: "remote:hello" }],
        structuredContent: { source: "streamable-http" },
      });
      expect(receivedMode).toBe("integration");
    } finally {
      await manager.stop();
    }
  });
});
