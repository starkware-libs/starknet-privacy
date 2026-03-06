import { useCallback, useEffect, useRef, useState } from "react";
import { ProvingService } from "starknet-sdk";
// @ts-expect-error — deep import into dist, not part of the declared exports
import { IndexerDiscoveryProvider } from "starknet-sdk/dist/internal/indexer-discovery.js";
import type { RpcProvider } from "starknet";
import type { AppConfig } from "../config.ts";

export type HealthStatus = "checking" | "healthy" | "unhealthy" | "unknown";

export type SubsystemHealth = {
  status: HealthStatus;
  detail: string | null;
};

export type ServiceHealthState = {
  discovery: SubsystemHealth;
  rpc: SubsystemHealth;
  proving: SubsystemHealth | null;
  gateway: SubsystemHealth | null;
  feederGateway: SubsystemHealth | null;
};

const POLL_INTERVAL_MS = 30_000;
const RPC_STALENESS_THRESHOLD_SECS = 120;
const FETCH_TIMEOUT_MS = 8_000;

function pending(): SubsystemHealth {
  return { status: "checking", detail: null };
}

async function checkDiscovery(indexerUrl: string): Promise<SubsystemHealth> {
  try {
    const indexer = new IndexerDiscoveryProvider(indexerUrl, "0x0");
    const health = await indexer.getHealth();
    if (health.status === "OK") {
      const detail = health.lag_secs != null ? `lag: ${health.lag_secs}s` : null;
      return { status: "healthy", detail };
    }
    return { status: "unhealthy", detail: `status: ${health.status}` };
  } catch (error) {
    return { status: "unhealthy", detail: error instanceof Error ? error.message : "unreachable" };
  }
}

async function checkRpc(provider: RpcProvider): Promise<SubsystemHealth> {
  try {
    const block = await provider.getBlock("latest");
    const blockTimestamp = block.timestamp;
    const nowSecs = Math.floor(Date.now() / 1000);
    const lagSecs = nowSecs - blockTimestamp;
    if (lagSecs <= RPC_STALENESS_THRESHOLD_SECS) {
      return { status: "healthy", detail: `lag: ${lagSecs}s` };
    }
    return { status: "unhealthy", detail: `stale: ${lagSecs}s behind` };
  } catch (error) {
    return { status: "unhealthy", detail: error instanceof Error ? error.message : "unreachable" };
  }
}

async function checkAliveEndpoint(url: string): Promise<SubsystemHealth> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (response.ok) return { status: "healthy", detail: null };
    return { status: "unhealthy", detail: `HTTP ${response.status}` };
  } catch {
    return { status: "unknown", detail: "unreachable (CORS?)" };
  }
}

async function checkProving(provingServiceUrl: string): Promise<SubsystemHealth> {
  try {
    const service = new ProvingService({ baseUrl: provingServiceUrl });
    const healthy = await service.isHealthy();
    return healthy
      ? { status: "healthy", detail: null }
      : { status: "unhealthy", detail: "spec version check failed" };
  } catch (error) {
    return { status: "unhealthy", detail: error instanceof Error ? error.message : "unreachable" };
  }
}

function initialState(config: AppConfig): ServiceHealthState {
  return {
    discovery: pending(),
    rpc: pending(),
    proving: config.provingServiceUrl ? pending() : null,
    gateway: config.gatewayUrl ? pending() : null,
    feederGateway: config.feederGatewayUrl ? pending() : null,
  };
}

export function useServiceHealth(provider: RpcProvider, config: AppConfig): ServiceHealthState {
  const [state, setState] = useState<ServiceHealthState>(() => initialState(config));
  const mountedRef = useRef(true);

  const runChecks = useCallback(() => {
    const update = (key: keyof ServiceHealthState) => (value: SubsystemHealth) => {
      if (mountedRef.current) setState((prev) => ({ ...prev, [key]: value }));
    };

    void checkDiscovery(config.indexerUrl).then(update("discovery"));
    void checkRpc(provider).then(update("rpc"));

    if (config.provingServiceUrl) {
      void checkProving(config.provingServiceUrl).then(update("proving"));
    }
    if (config.gatewayUrl) {
      void checkAliveEndpoint(`${config.gatewayUrl}/gateway/is_alive`).then(update("gateway"));
    }
    if (config.feederGatewayUrl) {
      void checkAliveEndpoint(`${config.feederGatewayUrl}/feeder_gateway/is_alive`).then(
        update("feederGateway")
      );
    }
  }, [provider, config]);

  useEffect(() => {
    mountedRef.current = true;
    runChecks();
    const intervalId = setInterval(runChecks, POLL_INTERVAL_MS);
    return () => {
      mountedRef.current = false;
      clearInterval(intervalId);
    };
  }, [runChecks]);

  return state;
}
