/**
 * Host-native Tool surface.
 *
 * This adapter owns only the public catalog shape and the recovery Tool. The
 * proxy supplies authorization, policy, exact upstream invocation, and the
 * shared ResultCapsuleStore behind this surface.
 *
 * @module native-tool-adapter
 */

import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  ResultCapsuleStore,
  type ResultCapsuleObservation,
  type ResultCapsuleObserver,
} from "./result-capsule-store.js";
import { READ_RESULT, readResultToolDefinition } from "./secure-projection.js";

/** One advertised Tool and the exact upstream route it represents. */
export interface NativeToolRoute {
  /** The current generic catalog name used for authorization and audit policy. */
  catalogName: string;
  /** Upstream server selected by the current catalog generation. */
  serverName: string;
  /** Original Tool name sent to the upstream server. */
  originalToolName: string;
  /** Tool definition shown to a native Host. */
  tool: Tool;
}

export interface NativeDeliveryResult {
  result: CallToolResult;
  observation?: ResultCapsuleObservation;
}

/**
 * Native Tool advertisement and recovery seam. It intentionally has no Host
 * detection logic: selecting this adapter is an explicit integration choice.
 */
export class NativeToolAdapter {
  private routes = new Map<string, NativeToolRoute>();
  private orderedRoutes: NativeToolRoute[] = [];

  constructor(
    private readonly results: ResultCapsuleStore,
    routes: NativeToolRoute[] = [],
  ) {
    this.replaceCatalog(routes);
  }

  replaceCatalog(routes: NativeToolRoute[]): void {
    this.routes.clear();
    this.orderedRoutes = [];
    for (const route of routes) {
      const name = route.tool.name;
      if (!name || name === READ_RESULT || this.routes.has(name)) {
        throw new Error("Native Tool catalog contains an invalid or duplicate route");
      }
      this.routes.set(name, route);
      this.orderedRoutes.push(route);
    }
  }

  listTools(): Tool[] {
    return [...this.orderedRoutes.map(({ tool }) => ({ ...tool })), readResultToolDefinition(true)];
  }

  handles(name: string): boolean {
    return name === READ_RESULT || this.routes.has(name);
  }

  resolve(name: string): NativeToolRoute | null {
    return this.routes.get(name) ?? null;
  }

  deliver(route: NativeToolRoute, upstreamResult: CallToolResult): NativeDeliveryResult {
    let observation: ResultCapsuleObservation | undefined;
    const observer: ResultCapsuleObserver = (value) => {
      observation = value;
    };
    const result = this.results.captureNative(upstreamResult, route.tool, observer);
    return {
      result,
      ...(observation ? { observation } : {}),
    };
  }

  read(args: Record<string, unknown>): NativeDeliveryResult {
    let observation: ResultCapsuleObservation | undefined;
    const observer: ResultCapsuleObserver = (value) => {
      observation = value;
    };
    const result = this.results.read(args, observer);
    return {
      result,
      ...(observation ? { observation } : {}),
    };
  }

  clear(): number {
    this.routes.clear();
    this.orderedRoutes = [];
    return this.results.clear();
  }
}
