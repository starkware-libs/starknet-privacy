import { spawn, type ChildProcess } from "child_process";
import { createInterface } from "readline";
import { createServer } from "net";
import { createWriteStream, type WriteStream } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface IndexerSpawnConfig {
  binary?: string;
  wsUrl: string;
  rpcUrl?: string;
  apiPort?: number;
  logFile?: string;
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") return reject(new Error("bad addr"));
      const port = addr.port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

export class IndexerClient {
  private child: ChildProcess;
  private lines: string[] = [];
  private waiters: Array<{ pattern: string; resolve: (line: string) => void }> = [];
  private _apiPort: number;
  private logStream?: WriteStream;

  private constructor(child: ChildProcess, apiPort: number, logFile?: string) {
    this.child = child;
    this._apiPort = apiPort;
    if (logFile) {
      this.logStream = createWriteStream(logFile, { flags: "w" });
    }

    const rl = createInterface({ input: child.stderr! });
    rl.on("line", (line) => {
      this.lines.push(line);
      this.logStream?.write(line + "\n");
      for (let i = this.waiters.length - 1; i >= 0; i--) {
        if (line.includes(this.waiters[i].pattern)) {
          this.waiters[i].resolve(line);
          this.waiters.splice(i, 1);
        }
      }
    });
  }

  static async spawn(config: IndexerSpawnConfig): Promise<IndexerClient> {
    const port = config.apiPort ?? (await findFreePort());
    const binary =
      config.binary ??
      process.env.DISCOVERY_SERVICE_BIN ??
      path.join(__dirname, "../../target/release/discovery-service");

    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      WS_URL: config.wsUrl,
      API_HOST: `127.0.0.1:${port}`,
      RUST_LOG: process.env.RUST_LOG ?? "debug,hyper_util=warn,hyper=warn",
    };
    if (config.rpcUrl) env.RPC_URL = config.rpcUrl;

    const child = spawn(binary, [], {
      env,
      stdio: ["ignore", "ignore", "pipe"],
    });

    return new IndexerClient(child, port, config.logFile);
  }

  get apiUrl(): string {
    return `http://127.0.0.1:${this._apiPort}`;
  }

  waitForLog(pattern: string, timeoutMs = 10_000): Promise<string> {
    const existing = this.lines.find((l) => l.includes(pattern));
    if (existing) return Promise.resolve(existing);

    return this.waitForNewLog(pattern, timeoutMs);
  }

  /** Like waitForLog but ignores already-buffered lines. */
  waitForNewLog(pattern: string, timeoutMs = 10_000): Promise<string> {
    return new Promise((resolve, reject) => {
      const entry = { pattern, resolve };
      this.waiters.push(entry);
      const timer = setTimeout(() => {
        const idx = this.waiters.indexOf(entry);
        if (idx >= 0) this.waiters.splice(idx, 1);
        reject(new Error(`Timeout waiting for log: "${pattern}"`));
      }, timeoutMs);
      const origResolve = entry.resolve;
      entry.resolve = (line: string | PromiseLike<string>) => {
        clearTimeout(timer);
        origResolve(line);
      };
    });
  }

  async waitUntilReady(rpcUrl: string): Promise<void> {
    await this.waitForLog("API server listening", 15_000);
    await this.waitForLog("Subscribed to new heads", 15_000);

    // Create a block so the indexer processes at least one
    await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "devnet_createBlock" }),
    });

    await this.waitForLog("New block #", 10_000);
  }

  async healthCheck(): Promise<Record<string, unknown>> {
    const resp = await fetch(`${this.apiUrl}/health`);
    return resp.json() as Promise<Record<string, unknown>>;
  }

  shutdown(): void {
    this.logStream?.end();
    this.child.kill("SIGINT");
  }
}
