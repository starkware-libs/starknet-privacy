import { execFile } from "child_process";
import { mkdtemp, readFile, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";
import { repoRoot } from "./utils.js";

const execFileAsync = promisify(execFile);

const AUDIT_FETCH = join(repoRoot(), "target/debug/audit-fetch");
const AUDIT_ANALYZE = join(repoRoot(), "target/debug/audit-analyze");

/** A `slots` entry in the snapshot JSON (felts are `0x` hex). */
export interface SlotEntry {
  value: string;
  created_block: number;
  modified_block: number;
  kind: string | null;
}

/** The snapshot document exchanged between `audit-fetch` and `audit-analyze`. */
export interface Snapshot {
  meta: Record<string, string>;
  slots: Record<string, SlotEntry>;
  users: Array<{ addr: string; kind: string }>;
  balances: Record<string, string>;
}

async function tempPath(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "solvency-audit-"));
  return join(dir, name);
}

/** Runs the `audit-fetch` CLI against a node and returns the parsed snapshot. */
export async function runAuditFetch(opts: {
  rpcUrl: string;
  contract: string;
  from: number;
  to: number;
}): Promise<Snapshot> {
  const out = await tempPath("snapshot.json");
  await execFileAsync(AUDIT_FETCH, [
    "--rpc-url",
    opts.rpcUrl,
    "--contract",
    opts.contract,
    "--from",
    String(opts.from),
    "--to",
    String(opts.to),
    "--out",
    out,
  ]);
  return JSON.parse(await readFile(out, "utf8")) as Snapshot;
}

/**
 * Runs the `audit-analyze` CLI on a snapshot and returns the classified snapshot
 * plus the summary the CLI prints to stderr.
 */
export async function runAuditAnalyze(opts: {
  snapshot: Snapshot;
  auditorKey: string;
}): Promise<{ snapshot: Snapshot; summary: string }> {
  const input = await tempPath("input.json");
  const out = await tempPath("classified.json");
  await writeFile(input, JSON.stringify(opts.snapshot));
  const { stderr } = await execFileAsync(AUDIT_ANALYZE, [
    "--input",
    input,
    "--auditor-key",
    opts.auditorKey,
    "--out",
    out,
  ]);
  return {
    snapshot: JSON.parse(await readFile(out, "utf8")) as Snapshot,
    summary: stderr,
  };
}
