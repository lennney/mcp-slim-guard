export async function runHostSmoke(adapter, definition, expectation, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const result = await adapter.run(definition, expectation, controller.signal);
    return {
      host: adapter.name,
      status: result.marker === expectation.marker ? "passed" : "failed",
      tools: result.tools,
      marker: result.marker,
      reason: result.marker === expectation.marker ? "" : "marker mismatch",
    };
  } catch (error) {
    return {
      host: adapter.name,
      status: controller.signal.aborted ? "timeout" : "blocked",
      tools: [],
      marker: null,
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
    await adapter.cleanup?.();
  }
}
