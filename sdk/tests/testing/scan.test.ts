import { describe, it, expect } from "vitest";
import { scan } from "../../src/utils/scan.js";
/** 
declare function scan(
  gen: AsyncGenerator<boolean | undefined, void, number | undefined>,
  start: number // inclusive
): Promise<void>;
*/
describe("scan tests", () => {
  const testSizes = [0, 1, 2, 3, 5, 8, 10, 16, 17, 32, 47, 100];

  for (const size of testSizes) {
    it(`handles array of size ${size}`, async () => {
      const touched = new Array(size).fill(0);

      async function probe(i: number): Promise<boolean> {
        // Simulate async work
        await new Promise((r) => setTimeout(r, 0));

        if (i < size) {
          touched[i]++;
        }

        void new Promise((r) => setTimeout(r, 0));
        return i < size;
      }

      await scan(probe, 0);

      // Wait for all async operations to settle
      await new Promise((r) => setTimeout(r, 50));

      // Check all elements were touched exactly once
      let i;
      for (i = 0; i < size; i++) {
        expect(touched[i], `element ${i} should be touched exactly once`).toBe(1);
      }

      expect(touched.length, "touched array should be the same size as the test size").toBe(size);
    });
  }
});
