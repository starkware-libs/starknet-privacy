import { num, BigNumberish } from "starknet";

// ============ Utility Classes ============

/**
 * A flexible Map with optional key conversion and default value generation.
 *
 * @typeParam K - The key type used in the public API
 * @typeParam V - The value type
 * @typeParam InternalK - The internal key type used for storage (defaults to K)
 *
 * Features:
 * - Key conversion: Transform keys before storage (e.g., BigNumberish → bigint)
 * - Default factory: Auto-create values for missing keys
 *
 * Iteration methods (entries, keys, forEach) use InternalK for keys.
 */
export class AdvancedMap<K, V, InternalK = K> {
  private map = new Map<InternalK, V>();

  constructor(
    private options: {
      /** Convert external key K to internal key InternalK */
      keyConverter?: (key: K) => InternalK;
      /** Create default value when key is missing (makes get() always return V) */
      defaultFactory?: (key: K) => V;
    } = {}
  ) {}

  private toInternalKey(key: K): InternalK {
    return this.options.keyConverter
      ? this.options.keyConverter(key)
      : (key as unknown as InternalK);
  }

  get(key: K): V | undefined {
    const internalKey = this.toInternalKey(key);
    if (!this.map.has(internalKey) && this.options.defaultFactory) {
      this.map.set(internalKey, this.options.defaultFactory(key));
    }
    return this.map.get(internalKey);
  }

  set(key: K, value: V): this {
    this.map.set(this.toInternalKey(key), value);
    return this;
  }

  has(key: K): boolean {
    return this.map.has(this.toInternalKey(key));
  }

  delete(key: K): boolean {
    return this.map.delete(this.toInternalKey(key));
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }

  /** Iterate over entries with internal keys */
  entries(): IterableIterator<[InternalK, V]> {
    return this.map.entries();
  }

  /** Iterate over internal keys */
  keys(): IterableIterator<InternalK> {
    return this.map.keys();
  }

  /** Iterate over values */
  values(): IterableIterator<V> {
    return this.map.values();
  }

  /** ForEach with internal keys */
  forEach(callbackfn: (value: V, key: InternalK, map: Map<InternalK, V>) => void): void {
    this.map.forEach(callbackfn);
  }

  [Symbol.iterator](): IterableIterator<[InternalK, V]> {
    return this.map[Symbol.iterator]();
  }

  get [Symbol.toStringTag](): string {
    return "AdvancedMap";
  }
}

/**
 * A Map that accepts BigNumberish keys and normalizes them to bigint.
 * Optionally auto-creates default values for missing keys.
 *
 * @example
 * // Without defaults - get() returns V | undefined
 * const map = new AddressMap<number>();
 * map.get("0x1"); // number | undefined
 *
 * // With defaults - get() returns V (use non-null assertion or check)
 * const mapWithDefault = new AddressMap<number[]>(() => []);
 * mapWithDefault.get("0x1")!.push(42); // safe when defaultFactory provided
 */
export class AddressMap<V> extends AdvancedMap<BigNumberish, V, bigint> {
  constructor(defaultFactory?: (key: BigNumberish) => V) {
    super({
      keyConverter: (key: BigNumberish): bigint => num.toBigInt(key),
      defaultFactory,
    });
  }
}
