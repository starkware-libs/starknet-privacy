// ============ Logging Utilities ============

/** Callback type for logging method calls */
export type LogCallback = (
  targetName: string,
  methodName: string,
  args: unknown[],
  result?: unknown
) => void;

/**
 * Wraps an object to intercept all method calls and invoke a callback.
 * Useful for debugging/logging.
 *
 * @param target - The object to wrap
 * @param name - Name to identify this object in logs
 * @param callback - Function called for each method invocation (with result after execution)
 */
export function withLogging<T extends object>(target: T, name: string, callback: LogCallback): T {
  return new Proxy(target, {
    get(obj, prop, receiver) {
      const value = Reflect.get(obj, prop, receiver);
      if (typeof value === "function" && typeof prop === "string" && !prop.startsWith("_")) {
        return function (this: unknown, ...args: unknown[]) {
          const result = value.apply(this === receiver ? obj : this, args);
          // Handle promises - log result when resolved
          if (result instanceof Promise) {
            return result.then((resolved) => {
              callback(name, prop, args, resolved);
              return resolved;
            });
          }
          callback(name, prop, args, result);
          return result;
        };
      }
      return value;
    },
  });
}

/**
 * Console logging callback for use with withLogging.
 * Logs method calls to console in format: [TargetName.method] (arg1, arg2, ...) => result
 */
export const consoleLogCallback: LogCallback = (targetName, methodName, args, result) => {
  const format = (value: unknown): string => {
    const replacer = (_: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);
    return JSON.stringify(value, replacer);
  };
  const argsStr = args.map(format).join(", ");
  const resultStr = result !== undefined ? ` => ${format(result)}` : "";
  console.log(`[${targetName}.${methodName}] (${argsStr})${resultStr}`);
};
