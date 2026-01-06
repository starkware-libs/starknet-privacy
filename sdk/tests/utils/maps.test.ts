import { describe, expect, it } from "vitest";
import { AdvancedMap, AddressMap } from "../../src/utils/maps.js";

describe("AdvancedMap", () => {
  describe("without key conversion", () => {
    it("stores and retrieves values", () => {
      const map = new AdvancedMap<string, number>();
      map.set("a", 1);
      map.set("b", 2);

      expect(map.get("a")).toBe(1);
      expect(map.get("b")).toBe(2);
      expect(map.get("c")).toBeUndefined();
    });

    it("has/delete/clear work correctly", () => {
      const map = new AdvancedMap<string, number>();
      map.set("a", 1);

      expect(map.has("a")).toBe(true);
      expect(map.has("b")).toBe(false);

      map.delete("a");
      expect(map.has("a")).toBe(false);

      map.set("x", 10);
      map.clear();
      expect(map.size).toBe(0);
    });
  });

  describe("with key conversion", () => {
    it("converts keys before storage", () => {
      const map = new AdvancedMap<string, number, number>({
        keyConverter: (key) => parseInt(key, 10),
      });

      map.set("123", 100);
      map.set("123", 200); // Same internal key

      expect(map.get("123")).toBe(200);
      expect(map.size).toBe(1);

      // Different string, same numeric value
      map.set("0123", 300); // parseInt("0123") = 123
      expect(map.size).toBe(1);
      expect(map.get("123")).toBe(300);
    });

    it("entries() returns internal keys", () => {
      const map = new AdvancedMap<string, number, number>({
        keyConverter: (key) => parseInt(key, 10),
      });

      map.set("42", 100);
      const entries = Array.from(map.entries());

      expect(entries).toEqual([[42, 100]]); // Internal key is number, not string
    });
  });

  describe("with default factory", () => {
    it("creates default value on get", () => {
      const map = new AdvancedMap<string, number[]>({
        defaultFactory: () => [],
      });

      // First access creates empty array
      map.get("a")!.push(1);
      map.get("a")!.push(2);

      expect(map.get("a")).toEqual([1, 2]);
      expect(map.size).toBe(1);
    });

    it("default factory receives the key", () => {
      const map = new AdvancedMap<string, string>({
        defaultFactory: (key) => `default-${key}`,
      });

      expect(map.get("foo")).toBe("default-foo");
      expect(map.get("bar")).toBe("default-bar");
    });
  });
});

describe("AddressMap", () => {
  it("normalizes hex strings to bigint", () => {
    const map = new AddressMap<string>();
    map.set("0xabc", "hello");

    // All these refer to the same key (2748n)
    expect(map.get("0xabc")).toBe("hello");
    expect(map.get("0xABC")).toBe("hello"); // case insensitive
    expect(map.get(2748)).toBe("hello"); // number
    expect(map.get(2748n)).toBe("hello"); // bigint
  });

  it("entries returns bigint keys", () => {
    const map = new AddressMap<number>();
    map.set("0xff", 255);

    const entries = Array.from(map.entries());
    expect(entries).toEqual([[255n, 255]]);
    expect(typeof entries[0][0]).toBe("bigint");
  });

  it("works with default factory", () => {
    const map = new AddressMap<number[]>(() => []);

    map.get("0x1")!.push(10);
    map.get("0x1")!.push(20);
    map.get(1n)!.push(30); // Same key

    expect(map.get("0x1")).toEqual([10, 20, 30]);
  });
});
