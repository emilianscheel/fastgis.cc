import type { ComponentProps } from "react";

export function ButtonGroup({ className, ...props }: ComponentProps<"div">) {
  return <div className={["button-group", className].filter(Boolean).join(" ")} {...props} />;
}
