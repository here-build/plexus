import "react";

declare module "react" {
  interface CSSProperties {
    [key: `--${string}`]: string | number | undefined;
    anchorName?: string;
    positionAnchor?: string;
  }
}
