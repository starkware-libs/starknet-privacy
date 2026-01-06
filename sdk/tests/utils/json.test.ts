import { describe, expect, it } from "vitest";
import { jsonStringify, jsonParse } from "../../src/utils/json.js";

describe("jsonStringify / jsonParse", () => {
  describe("BigInt handling", () => {
    it("serializes and restores bigint values", () => {
      const original = { key: 12345n, nested: { value: 99999999999999999999n } };
      const json = jsonStringify(original);
      const restored = jsonParse<typeof original>(json);

      expect(restored.key).toBe(12345n);
      expect(typeof restored.key).toBe("bigint");
      expect(restored.nested.value).toBe(99999999999999999999n);
    });

    it("handles bigint in arrays", () => {
      const original = [1n, 2n, 3n];
      const restored = jsonParse<bigint[]>(jsonStringify(original));

      expect(restored).toEqual([1n, 2n, 3n]);
      expect(typeof restored[0]).toBe("bigint");
    });

    it("handles zero and negative-like bigints", () => {
      const original = { zero: 0n, large: 2n ** 256n };
      const restored = jsonParse<typeof original>(jsonStringify(original));

      expect(restored.zero).toBe(0n);
      expect(restored.large).toBe(2n ** 256n);
    });
  });

  describe("Map handling", () => {
    it("serializes and restores Map", () => {
      const original = new Map([
        ["a", 1],
        ["b", 2],
      ]);
      const json = jsonStringify(original);
      const restored = jsonParse<Map<string, number>>(json);

      expect(restored instanceof Map).toBe(true);
      expect(restored.get("a")).toBe(1);
      expect(restored.get("b")).toBe(2);
      expect(restored.size).toBe(2);
    });

    it("serializes Map with bigint keys", () => {
      const original = new Map([
        [100n, "hello"],
        [200n, "world"],
      ]);
      const restored = jsonParse<Map<bigint, string>>(jsonStringify(original));

      expect(restored instanceof Map).toBe(true);
      expect(restored.get(100n)).toBe("hello");
      expect(restored.get(200n)).toBe("world");
    });

    it("serializes nested Map in object", () => {
      const original = {
        data: new Map([["key", [1, 2, 3]]]),
      };
      const restored = jsonParse<typeof original>(jsonStringify(original));

      expect(restored.data instanceof Map).toBe(true);
      expect(restored.data.get("key")).toEqual([1, 2, 3]);
    });
  });

  describe("Set handling", () => {
    it("serializes and restores Set", () => {
      const original = new Set([1, 2, 3]);
      const restored = jsonParse<Set<number>>(jsonStringify(original));

      expect(restored instanceof Set).toBe(true);
      expect(restored.has(1)).toBe(true);
      expect(restored.has(2)).toBe(true);
      expect(restored.has(3)).toBe(true);
      expect(restored.size).toBe(3);
    });

    it("serializes Set with bigint values", () => {
      const original = new Set([1n, 2n, 3n]);
      const restored = jsonParse<Set<bigint>>(jsonStringify(original));

      expect(restored instanceof Set).toBe(true);
      expect(restored.has(1n)).toBe(true);
      expect(restored.has(2n)).toBe(true);
    });
  });

  describe("mixed types", () => {
    it("handles complex nested structures", () => {
      const original = {
        id: 42n,
        map: new Map([[1n, new Set([10n, 20n])]]),
        array: [{ nested: 100n }],
      };
      const restored = jsonParse<typeof original>(jsonStringify(original));

      expect(restored.id).toBe(42n);
      expect(restored.map instanceof Map).toBe(true);
      expect(restored.map.get(1n) instanceof Set).toBe(true);
      expect(restored.map.get(1n)?.has(10n)).toBe(true);
      expect(restored.array[0].nested).toBe(100n);
    });
  });
});
