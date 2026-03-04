import type { HealthStatus, ServiceHealthState, SubsystemHealth } from "../hooks/useServiceHealth.ts";

const STATUS_COLORS: Record<HealthStatus, string> = {
  healthy: "#3fb950",
  unhealthy: "#f85149",
  unknown: "#d29922",
  checking: "#484f58",
};

function Indicator({ label, health }: { label: string; health: SubsystemHealth }) {
  return (
    <span className="health-indicator">
      <span className="health-dot" style={{ background: STATUS_COLORS[health.status] }} title={health.detail ?? health.status} />
      <span className="health-label">{label}</span>
    </span>
  );
}

export function ServiceHealthBar({ health }: { health: ServiceHealthState }) {
  return (
    <span className="service-health-bar">
      | Status:
      <Indicator label="Discovery" health={health.discovery} />
      <Indicator label="RPC" health={health.rpc} />
      {health.proving && <Indicator label="Proving" health={health.proving} />}
      {health.gateway && <Indicator label="Gateway" health={health.gateway} />}
      {health.feederGateway && <Indicator label="Feeder GW" health={health.feederGateway} />}
    </span>
  );
}
