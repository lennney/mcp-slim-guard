/** Authorization-only catalog selection shared by every public mode. */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import micromatch from "micromatch";

const { isMatch } = micromatch;

export type ToolNameAliasProvider = (name: string) => readonly string[];

export function isToolAuthorized(
  name: string,
  allow: string[],
  deny: string[],
  denyAliases: ToolNameAliasProvider = () => [],
): boolean {
  const denyCandidates = [name, ...denyAliases(name)];
  if (deny.some((pattern) => denyCandidates.some((candidate) => isMatch(candidate, pattern)))) return false;
  return allow.some((pattern) => isMatch(name, pattern));
}

export function authorizedTools(
  tools: Tool[],
  allow: string[],
  deny: string[],
  denyAliases: ToolNameAliasProvider = () => [],
): Tool[] {
  return tools.filter((tool) => isToolAuthorized(tool.name, allow, deny, denyAliases));
}
