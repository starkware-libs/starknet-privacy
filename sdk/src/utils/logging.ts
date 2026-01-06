// ============ Logging Utilities ============

/** Callback type for logging method calls */
export type LogCallback = (targetName: string, methodName: string, args: unknown[]) => void;

/**
 * Wraps an object to intercept all method calls and invoke a callback.
 * Useful for debugging/logging.
 *
 * @param target - The object to wrap
 * @param name - Name to identify this object in logs
 * @param callback - Function called for each method invocation
 */
export function withLogging<T extends object>(target: T, name: string, callback: LogCallback): T {
  return new Proxy(target, {
    get(obj, prop, receiver) {
      const value = Reflect.get(obj, prop, receiver);
      if (typeof value === "function" && typeof prop === "string" && !prop.startsWith("_")) {
        return function (this: unknown, ...args: unknown[]) {
          callback(name, prop, args);
          return value.apply(this === receiver ? obj : this, args);
        };
      }
      return value;
    },
  });
}

/**
 * Console logging callback for use with withLogging.
 * Logs method calls to console in format: [TargetName.method] (arg1, arg2, ...)
 */
export const consoleLogCallback: LogCallback = (targetName, methodName, args) => {
  const formatArgs = (args: unknown[]): string => {
    const replacer = (_: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);
    return args.map((a) => JSON.stringify(a, replacer)).join(", ");
  };
  console.log(`[${targetName}.${methodName}] (${formatArgs(args)})`);
};
