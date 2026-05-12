// User-supplied whale mark (`whale.png`) — see `demo/src/wallet/components/whale.png`.
// Rendered as an <img> so what ships matches the source asset exactly. The
// PNG has a white background, so callers pair it with a white tile in CSS
// rather than the brand gradient — the whale already carries its own
// cyan→blue→indigo gradient.

import whaleUrl from "./whale.png";

type Props = {
  size?: number | string;
  /** When true, render at the natural size of the asset (no fixed pixel
   *  dimensions) so the parent CSS's width/height drive it. */
  fill?: boolean;
};

export function WhaleLogo({ size = "100%", fill }: Props) {
  return (
    <img
      src={whaleUrl}
      alt="Veil"
      width={fill ? undefined : size}
      height={fill ? undefined : size}
      style={{
        display: "block",
        width: fill ? "100%" : size,
        height: fill ? "100%" : size,
        objectFit: "contain",
      }}
    />
  );
}
