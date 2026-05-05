import { extractToken, safeCompareToken } from "../src/auth";

describe("safeCompareToken", () => {
  it("returns true for equal strings", () => {
    expect(safeCompareToken("abcdef", "abcdef")).toBe(true);
  });
  it("returns false for different lengths", () => {
    expect(safeCompareToken("abc", "abcdef")).toBe(false);
  });
  it("returns false for unequal same-length strings", () => {
    expect(safeCompareToken("abcdef", "abcdeg")).toBe(false);
  });
  it("returns false for null/undefined", () => {
    expect(safeCompareToken(null, "x")).toBe(false);
    expect(safeCompareToken("x", undefined)).toBe(false);
  });
});

describe("extractToken", () => {
  it("prefers X-OutscoreAgent-Token", () => {
    expect(
      extractToken({
        "x-outscoreagent-token": "abc",
        authorization: "Bearer xyz",
      }),
    ).toBe("abc");
  });
  it("falls back to Authorization Bearer", () => {
    expect(extractToken({ authorization: "Bearer xyz" })).toBe("xyz");
  });
  it("returns null without any auth header", () => {
    expect(extractToken({})).toBe(null);
  });
  it("ignores non-Bearer authorization schemes", () => {
    expect(extractToken({ authorization: "Basic xyz" })).toBe(null);
  });
});
