import { describe, expect, it } from "vitest";
import * as publicExports from "../../src/index.js";

describe("public package exports", () => {
  it("exposes the documented Host-native construction seam from the package root", () => {
    expect(publicExports).toMatchObject({
      GuardProxy: expect.any(Function),
      ServerManager: expect.any(Function),
      AuditLogger: expect.any(Function),
      PolicyPipeline: expect.any(Function),
      WhitelistPolicy: expect.any(Function),
    });
  });
});
