"use client";

import { Fragment, type ReactNode } from "react";
import { useTheme } from "next-themes";
import { Toaster as Sonner } from "sonner";

import { cn } from "@/lib/utils";

type ToasterProps = React.ComponentProps<typeof Sonner>;

const DEFAULT_TOAST_CLASSNAMES = {
  toast:
    "group toast !mx-auto !h-auto !min-h-0 !w-max !max-w-none !whitespace-nowrap !rounded-full border border-border/80 bg-background/95 px-4 py-2 text-center text-xs font-medium text-foreground shadow-md backdrop-blur-sm !justify-center",
  title: "leading-none",
  description: "text-xs leading-tight text-muted-foreground",
  content: "w-full items-center text-center",
  actionButton: "rounded-full bg-primary px-3 text-primary-foreground",
  cancelButton: "rounded-full bg-muted px-3 text-muted-foreground"
};

export type SonnerGroupedPillPart = {
  className?: string;
  content: ReactNode;
  key: string;
};

type SonnerGroupedPillsProps = {
  className?: string;
  connectorClassName?: string;
  partClassName?: string;
  parts: SonnerGroupedPillPart[];
};

function SonnerGroupedPillSeparator({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn("mx-2 inline-block h-4 w-px shrink-0 rounded-full bg-border/80", className)}
    />
  );
}

function SonnerGroupedPills({
  className,
  connectorClassName,
  partClassName,
  parts
}: SonnerGroupedPillsProps) {
  if (parts.length === 0) {
    return null;
  }

  return (
    <span className={cn("inline-flex items-center whitespace-nowrap", className)}>
      {parts.map((part, index) => (
        <Fragment key={part.key}>
          {index > 0 ? <SonnerGroupedPillSeparator className={connectorClassName} /> : null}
          <span
            className={cn(
              "inline-flex items-center",
              partClassName,
              part.className
            )}
          >
            {part.content}
          </span>
        </Fragment>
      ))}
    </span>
  );
}

const Toaster = ({ toastOptions, position, ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme();

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      position={position ?? "bottom-center"}
      className="toaster group"
      expand={false}
      offset={96}
      toastOptions={{
        ...toastOptions,
        classNames: {
          ...DEFAULT_TOAST_CLASSNAMES,
          ...toastOptions?.classNames
        }
      }}
      {...props}
    />
  );
};

export { SonnerGroupedPills, Toaster };
