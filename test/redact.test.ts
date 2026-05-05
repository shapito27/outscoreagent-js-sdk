import { redact, redactString } from "../src/redact";

describe("redact", () => {
  it("redacts top-level sensitive keys", () => {
    expect(
      redact({
        token: "abc123",
        api_key: "xyz",
        public: "ok",
      }),
    ).toEqual({
      token: "[REDACTED]",
      api_key: "[REDACTED]",
      public: "ok",
    });
  });

  it("redacts nested sensitive keys", () => {
    expect(
      redact({
        config: {
          headers: {
            Authorization: "Bearer xxx",
          },
          callback: {
            webhook_token: "abc",
          },
        },
      }),
    ).toEqual({
      config: {
        headers: { Authorization: "[REDACTED]" },
        callback: { webhook_token: "[REDACTED]" },
      },
    });
  });

  it("walks arrays without flattening", () => {
    expect(
      redact([
        { token: "1", name: "a" },
        { token: "2", name: "b" },
      ]),
    ).toEqual([
      { token: "[REDACTED]", name: "a" },
      { token: "[REDACTED]", name: "b" },
    ]);
  });

  it("does not mutate the input", () => {
    const input = { token: "abc", nested: { secret: "x" } };
    redact(input);
    expect(input.token).toBe("abc");
    expect(input.nested.secret).toBe("x");
  });

  it("handles cycles", () => {
    const a: any = { name: "a" };
    a.self = a;
    expect(() => redact(a)).not.toThrow();
  });

  it("passes primitives through unchanged", () => {
    expect(redact("hello")).toBe("hello");
    expect(redact(42)).toBe(42);
    expect(redact(null)).toBe(null);
  });

  it("respects custom keyPattern", () => {
    expect(
      redact({ pin: "1234", token: "abc" }, { keyPattern: /^pin$/ }),
    ).toEqual({ pin: "[REDACTED]", token: "abc" });
  });

  it("redacts conventional secret-name variants (private_key, pwd, passwd)", () => {
    expect(
      redact({
        private_key: "-----BEGIN RSA PRIVATE KEY-----...",
        privatekey: "abc",
        "private-key": "abc",
        pwd: "hunter2",
        passwd: "hunter2",
        username: "alice",
      }),
    ).toEqual({
      private_key: "[REDACTED]",
      privatekey: "[REDACTED]",
      "private-key": "[REDACTED]",
      pwd: "[REDACTED]",
      passwd: "[REDACTED]",
      username: "alice",
    });
  });
});

describe("redactString", () => {
  it("redacts Bearer tokens", () => {
    expect(redactString("Authorization: Bearer abc.def.ghi")).toBe(
      "Authorization: Bearer [REDACTED]",
    );
  });

  it("redacts query-string tokens", () => {
    expect(
      redactString("https://api.example.com/x?token=abc123&keep=ok"),
    ).toBe("https://api.example.com/x?token=[REDACTED]&keep=ok");
  });

  it("redacts long opaque strings (heuristic)", () => {
    const out = redactString("token: abcdefghijklmnopqrstuvwxyz1234567890");
    expect(out).toContain("[REDACTED]");
  });

  it("leaves prose alone", () => {
    expect(redactString("hello world this is fine")).toBe(
      "hello world this is fine",
    );
  });
});
