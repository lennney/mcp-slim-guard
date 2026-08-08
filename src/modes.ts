/** Public model-facing delivery modes. */

export const GUARD_MODES = ["compact", "native", "extreme"] as const;
export type GuardMode = (typeof GUARD_MODES)[number];
export type ClaudeInstallationMode = Exclude<GuardMode, "native">;

export function isGuardMode(value: string): value is GuardMode {
  return (GUARD_MODES as readonly string[]).includes(value);
}

export function assertClaudeInstallationMode(mode: GuardMode): asserts mode is ClaudeInstallationMode {
  if (mode === "native") {
    throw new Error("Claude Code native mode is not a verified installation target. Use compact or extreme.");
  }
}
