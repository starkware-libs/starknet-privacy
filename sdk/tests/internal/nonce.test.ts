import { describe, expect, it } from "vitest";
import { TokenNonce, NoteNonce } from "../../src/internal/index.js";

describe("TokenNonce", () => {
  it("starts at sequence 0 by default", () => {
    const nonce = new TokenNonce();
    expect(nonce.sequence).toBe(0);
  });

  it("can be created with a specific sequence", () => {
    const nonce = new TokenNonce(5);
    expect(nonce.sequence).toBe(5);
  });

  it("increment returns a new nonce with sequence + 1", () => {
    const nonce = new TokenNonce(3);
    const incremented = nonce.increment();

    expect(incremented.sequence).toBe(4);
    expect(nonce.sequence).toBe(3); // original unchanged
  });

  it("decrement returns a new nonce with sequence - 1", () => {
    const nonce = new TokenNonce(3);
    const decremented = nonce.decrement();

    expect(decremented.sequence).toBe(2);
    expect(nonce.sequence).toBe(3); // original unchanged
  });

  it("throws when decrementing below 0", () => {
    const nonce = new TokenNonce(0);
    expect(() => nonce.decrement()).toThrow("Invalid nonce: cannot decrement below 0");
  });
});

describe("NoteNonce", () => {
  it("starts at sequence 0 by default", () => {
    const nonce = new NoteNonce();
    expect(nonce.sequence).toBe(0);
  });

  it("can be created with a specific sequence", () => {
    const nonce = new NoteNonce(10);
    expect(nonce.sequence).toBe(10);
  });

  it("increment returns a new nonce with sequence + 1", () => {
    const nonce = new NoteNonce(7);
    const incremented = nonce.increment();

    expect(incremented.sequence).toBe(8);
    expect(nonce.sequence).toBe(7); // original unchanged
  });

  it("decrement returns a new nonce with sequence - 1", () => {
    const nonce = new NoteNonce(5);
    const decremented = nonce.decrement();

    expect(decremented.sequence).toBe(4);
    expect(nonce.sequence).toBe(5); // original unchanged
  });

  it("throws when decrementing below 0", () => {
    const nonce = new NoteNonce(0);
    expect(() => nonce.decrement()).toThrow("Invalid nonce: cannot decrement below 0");
  });
});
