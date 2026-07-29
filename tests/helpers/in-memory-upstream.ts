import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { UpstreamServer } from "../../src/config-types.js";
import type { ConnectedUpstream, UpstreamConnector, UpstreamTransportKind } from "../../src/upstream-connector.js";

export interface InMemoryUpstreamDefinition {
  tools: Tool[];
  transportKind?: UpstreamTransportKind;
  connectError?: Error;
  closeError?: Error;
  call?: (toolName: string, args: Record<string, unknown>) => Promise<CallToolResult>;
}

export interface InMemoryCall {
  toolName: string;
  args: Record<string, unknown>;
}

export interface InMemorySessionState {
  calls: InMemoryCall[];
  closed: boolean;
}

class InMemoryConnectedUpstream implements ConnectedUpstream {
  readonly state: InMemorySessionState = {
    calls: [],
    closed: false,
  };

  constructor(private readonly definition: InMemoryUpstreamDefinition) {}

  get tools(): Tool[] {
    return this.definition.tools;
  }

  get transportKind(): UpstreamTransportKind {
    return this.definition.transportKind ?? "stdio";
  }

  async callTool(toolName: string, args: Record<string, unknown>): Promise<CallToolResult> {
    this.state.calls.push({ toolName, args });
    if (this.definition.call) {
      return this.definition.call(toolName, args);
    }
    return {
      content: [{ type: "text", text: `${toolName} called` }],
    };
  }

  async close(): Promise<void> {
    this.state.closed = true;
    if (this.definition.closeError) {
      throw this.definition.closeError;
    }
  }
}

/**
 * Test adapter for the same external seam used by the production SDK adapter.
 * It does not bypass ServerManager routing or lifecycle behavior.
 */
export class InMemoryUpstreamConnector implements UpstreamConnector {
  readonly connectCalls: Array<{ serverName: string; server: UpstreamServer }> = [];
  readonly sessions = new Map<string, InMemoryConnectedUpstream>();

  constructor(private readonly definitions: Record<string, InMemoryUpstreamDefinition>) {}

  async connect(serverName: string, server: UpstreamServer): Promise<ConnectedUpstream> {
    this.connectCalls.push({ serverName, server });
    const definition = this.definitions[serverName];
    if (!definition) {
      throw new Error(`No in-memory upstream named "${serverName}"`);
    }
    if (definition.connectError) {
      throw definition.connectError;
    }

    const session = new InMemoryConnectedUpstream(definition);
    this.sessions.set(serverName, session);
    return session;
  }

  state(serverName: string): InMemorySessionState {
    const session = this.sessions.get(serverName);
    if (!session) {
      throw new Error(`Upstream "${serverName}" is not connected`);
    }
    return session.state;
  }
}
