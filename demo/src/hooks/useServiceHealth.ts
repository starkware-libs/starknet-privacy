import { useCallback, useEffect, useRef, useState } from "react";
import { ProvingService, OhttpClient } from "@starkware-libs/starknet-privacy-sdk";
import type { RpcProvider } from "starknet";
import type { AppConfig } from "../config.ts";
import { createDiscoveryProvider } from "../starknet.ts";

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
const RPC_BLOCK_DIVERGENCE_THRESHOLD = 0;
const FETCH_TIMEOUT_MS = 8_000;

function pending(): SubsystemHealth {
  return { status: "checking", detail: null };
}

async function checkDiscovery(config: AppConfig): Promise<SubsystemHealth> {
  try {
    const indexer = createDiscoveryProvider(config, "0x0");
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

async function checkRpc(provider: RpcProvider, feederGatewayUrl?: string): Promise<SubsystemHealth> {
  try {
    const block = await provider.getBlock("latest");
    const rpcBlockNumber = block.block_number;
    const nowSecs = Math.floor(Date.now() / 1000);
    const lagSecs = nowSecs - block.timestamp;
    if (lagSecs > RPC_STALENESS_THRESHOLD_SECS) {
      return { status: "unhealthy", detail: `stale: ${lagSecs}s behind` };
    }

    if (feederGatewayUrl) {
      try {
        const response = await fetch(
          `${feederGatewayUrl}/feeder_gateway/get_block?blockNumber=latest`,
          { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
        );
        if (response.ok) {
          const feederBlock = await response.json();
          const feederBlockNumber = feederBlock.block_number as number;
          const divergence = Math.abs(rpcBlockNumber - feederBlockNumber);
          if (divergence > RPC_BLOCK_DIVERGENCE_THRESHOLD) {
            return { status: "unhealthy", detail: `block ${rpcBlockNumber} vs feeder ${feederBlockNumber} (${divergence} behind)` };
          }
        }
      } catch {
        // Feeder gateway unavailable — skip divergence check
      }
    }

    return { status: "healthy", detail: `block ${rpcBlockNumber}, lag: ${lagSecs}s` };
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

async function checkProving(provingServiceUrl: string, ohttpEnabled: boolean): Promise<SubsystemHealth> {
  try {
    const ohttpClient = ohttpEnabled ? new OhttpClient(provingServiceUrl) : undefined;
    const service = new ProvingService({ baseUrl: provingServiceUrl, ohttpClient });
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

export function useServiceHealth(
  provider: RpcProvider,
  config: AppConfig,
): ServiceHealthState {
  const [state, setState] = useState<ServiceHealthState>(() => initialState(config));
  const mountedRef = useRef(true);

  const runChecks = useCallback(() => {
    const update = (key: keyof ServiceHealthState) => (value: SubsystemHealth) => {
      if (mountedRef.current) setState((prev) => ({ ...prev, [key]: value }));
    };

    checkDiscovery(config).then(update("discovery"));
    checkRpc(provider, config.feederGatewayUrl).then(update("rpc"));

    if (config.provingServiceUrl) {
      checkProving(config.provingServiceUrl, config.ohttpEnabled !== false).then(update("proving"));
    }
    if (config.gatewayUrl) {
      checkAliveEndpoint(`${config.gatewayUrl}/gateway/is_alive`).then(update("gateway"));
    }
    if (config.feederGatewayUrl) {
      checkAliveEndpoint(`${config.feederGatewayUrl}/feeder_gateway/is_alive`).then(
        update("feederGateway"),
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
