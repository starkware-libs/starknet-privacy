import type { Token } from "../types";
import { BrandIcon } from "./BrandIcon";

interface Props {
  token: Token;
  size?: number;
}

export function TokenIcon({ token, size = 28 }: Props) {
  return <BrandIcon token={token} size={size} />;
}
