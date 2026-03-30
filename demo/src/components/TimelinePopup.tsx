import { type Span, type Timeline, spanDuration } from "../timeline.ts";

type Props = {
  timeline: Timeline;
  onClose: () => void;
};

function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function TimelinePopup({ timeline, onClose }: Props) {
  const totalMs = timeline.totalMs;
  const originMs = timeline.spans.length > 0 ? timeline.spans[0].startMs : 0;

  // Rebase all spans so offset is relative to timeline start
  function rebasedOffset(span: Span): number {
    return totalMs > 0 ? ((span.startMs - originMs) / totalMs) * 100 : 0;
  }

  function SpanRowRebased({ span, depth }: { span: Span; depth: number }) {
    const duration = spanDuration(span);
    const widthPercent = totalMs > 0 ? Math.max(1, (duration / totalMs) * 100) : 0;
    const offset = rebasedOffset(span);

    return (
      <>
        <tr className="timeline-row">
          <td className="timeline-label" style={{ paddingLeft: `${12 + depth * 16}px` }}>
            {span.label}
          </td>
          <td className="timeline-duration">{formatMs(duration)}</td>
          <td className="timeline-bar-cell">
            <div
              className={`timeline-bar ${depth === 0 ? "timeline-bar-root" : ""}`}
              style={{ width: `${widthPercent}%`, marginLeft: `${offset}%` }}
            />
          </td>
        </tr>
        {span.children.map((child, childIndex) => (
          <SpanRowRebased key={childIndex} span={child} depth={depth + 1} />
        ))}
      </>
    );
  }

  return (
    <div className="search-popup-overlay" onClick={onClose}>
      <div className="search-popup timeline-popup" onClick={(event) => event.stopPropagation()}>
        <div className="search-popup-header">
          <span>Timeline — {formatMs(totalMs)} total</span>
          <button className="pool-action-button" onClick={onClose}>Close</button>
        </div>
        <table className="timeline-table">
          <thead>
            <tr>
              <th className="timeline-label-header">Step</th>
              <th className="timeline-duration-header">Duration</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {timeline.spans.map((span, spanIndex) => (
              <SpanRowRebased key={spanIndex} span={span} depth={0} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
