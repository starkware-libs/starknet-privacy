// ============ Logging Utilities ============
import { AsyncLocalStorage } from "async_hooks";
import { num, BigNumberish } from "starknet";

// --- Tracing Context ---

type TraceContext = {
  id: string; // e.g. "1.2"
  childCounter: number; // Counter for children
};

const traceStorage = new AsyncLocalStorage<TraceContext>();
let rootTraceCounter = 0;

function getTraceId(): string {
  const current = traceStorage.getStore();
  if (current) {
    current.childCounter++;
    return `${current.id}.${current.childCounter}`;
  }
  rootTraceCounter++;
  return `${rootTraceCounter}`;
}

// --- Types ---

export type LogPhase = "ENTER" | "EXIT" | "ERROR";

/** Callback type for logging method calls */
export type LogCallback = (
  targetName: string,
  methodName: string,
  args: unknown[],
  result: unknown, // result or error
  phase: LogPhase,
  traceId: string
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
          const traceId = getTraceId();
          const context: TraceContext = { id: traceId, childCounter: 0 };

          return traceStorage.run(context, () => {
            try {
              // Log Enter
              callback(name, prop, args, undefined, "ENTER", traceId);

              // Apply on 'this' (which is the proxy if called via proxy) to ensure internal calls
              // also go through the proxy.
              const result = value.apply(this, args);

              // Handle promises - log result when resolved
              if (result instanceof Promise) {
                return result.then(
                  (resolved) => {
                    callback(name, prop, args, resolved, "EXIT", traceId);
                    return resolved;
                  },
                  (error) => {
                    callback(name, prop, args, error, "ERROR", traceId);
                    throw error;
                  }
                );
              }

              callback(name, prop, args, result, "EXIT", traceId);
              return result;
            } catch (error) {
              callback(name, prop, args, error, "ERROR", traceId);
              throw error;
            }
          });
        };
      }
      return value;
    },
  });
}

/** Environment variable to enable debug logging */
export const DEBUG_ENV_VAR = "SDK_DEBUG";

/** Check if debug logging is enabled */
export const isDebugEnabled = (targetName?: string) => {
  const env = process.env[DEBUG_ENV_VAR];
  if (!env) return false;
  if (env === "1" || env === "true") return true;
  if (targetName) {
    const patterns = env.split(",");
    // Check for exact match or prefix match (pattern + ".")
    // e.g. "foo" matches "foo" and "foo.bar"
    return patterns.some((p) => targetName === p || targetName.startsWith(`${p}.`));
  }
  return false;
};

// ANSI color codes
const CYAN = 36;
const GREEN = 32;
const RED = 31;

// Check if we are in a TTY environment or if color is forced
const useColor = () => {
  if (process.env.SDK_DEBUG_COLOR === "0" || process.env.NO_COLOR) return false;
  if (process.env.SDK_DEBUG_COLOR === "1" || process.env.FORCE_COLOR) return true;
  return process.stdout?.isTTY;
};

/** Apply color if environment supports it */
const color = (text: string, code: number) => {
  if (!useColor()) return text;
  return `\u001b[${code}m${text}\u001b[0m`;
};

// ... existing code ...

/** Helper to format bigint/BigNumberish as hex string */
export const hex = (v: BigNumberish | Uint8Array) => {
  if (v instanceof Uint8Array) {
    return (
      "0x" +
      Array.from(v)
        .map((b) => b.toString(16).toUpperCase().padStart(2, "0"))
        .join("")
    );
  }
  return `0x${num.toBigInt(v).toString(16).toUpperCase()}`;
};

const replacer = (_: string, v: unknown) => {
  if (typeof v === "bigint") return `0x${v.toString(16)}`;
  if (typeof v === "function") return "[Function]";
  if (v instanceof Uint8Array) return hex(v);
  if (v instanceof Map)
    return {
      dataType: "Map",
      value: Array.from(v.entries()),
    };
  if (v instanceof Set) return Array.from(v);
  return v;
};

/**
 * Console logging callback for use with withLogging.
 * Logs method calls to console in format: [TraceID] [TargetName.method] -> (args)
 * Only logs when SDK_DEBUG environment variable is set.
 */
export const consoleLogCallback: LogCallback = (
  targetName,
  methodName,
  args,
  result,
  phase,
  traceId
) => {
  // Check if debug is enabled for the specific method path
  if (!isDebugEnabled(`${targetName}.${methodName}`)) return;

  const format = (value: unknown): string => {
    return JSON.stringify(value, replacer);
  };

  const prefix = color(`[${traceId}] [${targetName}.${methodName}]`, CYAN);

  if (phase === "ENTER") {
    const argsStr = args.map(format).join(", ");
    console.log(`${prefix} ${color("→", GREEN)} (${argsStr})`);
  } else if (phase === "EXIT") {
    console.log(`${prefix} ${color("←", GREEN)} ${format(result)}`);
  } else if (phase === "ERROR") {
    const err = result instanceof Error ? result : new Error(String(result));
    console.log(`${prefix} ${color("✖", RED)} ${err.message}`);
  }
};

/**
 * Log arbitrary messages if debug is enabled for the target.
 */
export const debugLog = (target: string, sub: string, ...args: unknown[]) => {
  if (isDebugEnabled(`${target}.${sub}`)) {
    // Attempt to get current trace ID if inside a logged context
    const current = traceStorage.getStore();
    const traceId = current ? current.id : "?";

    console.log(
      color(`[${traceId}] [${target}.${sub}]`, CYAN),
      ...args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg, replacer, 2)))
    );
  }
};

/** No-op logging callback - does nothing */
export const noopLogCallback: LogCallback = () => {};

/** Helper message to show when tests fail */
export const debugHint = `\nTip: Run with ${DEBUG_ENV_VAR}=1 for detailed logging`;
