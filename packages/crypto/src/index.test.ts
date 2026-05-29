import { describe, expect, it } from "vitest";

import { CredentialCryptoError, decryptJson, encryptJson } from "./index.js";

describe("credential crypto", () => {
  it("round-trips encrypted JSON", () => {
    const encrypted = encryptJson({ token: "secret" }, "a-long-enough-secret");

    expect(decryptJson<{ token: string }>(encrypted, "a-long-enough-secret")).toEqual({
      token: "secret"
    });
  });

  it("fails safely with the wrong key", () => {
    const encrypted = encryptJson({ token: "secret" }, "a-long-enough-secret");

    expect(() => decryptJson(encrypted, "a-different-long-secret")).toThrow(CredentialCryptoError);
  });
});
