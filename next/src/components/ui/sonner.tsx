"use client";

import { useTheme } from "next-themes";
import { Toaster as Sonner } from "sonner";

type ToasterProps = React.ComponentProps<typeof Sonner>;

const DEFAULT_TOAST_CLASSNAMES = {
  toast:
    "group toast !h-auto !min-h-0 !w-fit !rounded-full border border-border/80 bg-background/95 px-4 py-2 text-xs font-medium text-foreground shadow-md backdrop-blur-sm",
  title: "leading-none",
  description: "text-xs leading-tight text-muted-foreground",
  actionButton: "rounded-full bg-primary px-3 text-primary-foreground",
  cancelButton: "rounded-full bg-muted px-3 text-muted-foreground"
};

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

export { Toaster };
