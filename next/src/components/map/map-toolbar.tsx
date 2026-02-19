"use client";

import { Crop, Minus, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Menubar,
  MenubarContent,
  MenubarMenu,
  MenubarRadioGroup,
  MenubarRadioItem,
  MenubarTrigger
} from "@/components/ui/menubar";

export type MapStyleOption = {
  id: string;
  label: string;
};

type MapToolbarProps = {
  canInteract: boolean;
  isMounted: boolean;
  mapStyleId: string;
  mapStyles: MapStyleOption[];
  isBoxZoomActive: boolean;
  onMapStyleChange: (value: string) => void;
  onToggleBoxZoom: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
};

export function MapToolbar({
  canInteract,
  isMounted,
  mapStyleId,
  mapStyles,
  isBoxZoomActive,
  onMapStyleChange,
  onToggleBoxZoom,
  onZoomIn,
  onZoomOut
}: MapToolbarProps) {
  return (
    <div className="pointer-events-none fixed inset-x-0 top-0 z-20">
      <div className="pointer-events-auto flex w-full items-center justify-between border-b border-border/80 bg-background/85 px-4 py-2 text-foreground backdrop-blur-md">
        <div />
        <div className="flex items-center gap-2">
          {isMounted ? (
            <Menubar className="h-9 rounded-none border-border/80 bg-background p-0">
              <MenubarMenu>
                <MenubarTrigger className="h-9 rounded-none px-3 text-foreground">Style</MenubarTrigger>
                <MenubarContent align="end" className="rounded-none">
                  <MenubarRadioGroup value={mapStyleId} onValueChange={onMapStyleChange}>
                    {mapStyles.map((style) => (
                      <MenubarRadioItem key={style.id} value={style.id} className="rounded-none">
                        {style.label}
                      </MenubarRadioItem>
                    ))}
                  </MenubarRadioGroup>
                </MenubarContent>
              </MenubarMenu>
            </Menubar>
          ) : (
            <div className="flex h-9 items-center border border-border/80 bg-background px-3 text-sm font-medium text-foreground">
              Style
            </div>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={`h-9 w-9 rounded-none border-border/80 p-0 text-foreground hover:bg-muted/60 ${
              isBoxZoomActive ? "bg-muted" : "bg-background"
            }`}
            onClick={onToggleBoxZoom}
            disabled={!canInteract}
            aria-label="Box zoom tool"
            aria-pressed={isBoxZoomActive}
            title="Box zoom tool"
          >
            <Crop className="h-4 w-4" aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-9 w-9 rounded-none border-border/80 bg-background p-0 text-foreground hover:bg-muted/60"
            onClick={onZoomIn}
            disabled={!canInteract}
            aria-label="Zoom in"
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-9 w-9 rounded-none border-border/80 bg-background p-0 text-foreground hover:bg-muted/60"
            onClick={onZoomOut}
            disabled={!canInteract}
            aria-label="Zoom out"
          >
            <Minus className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>
      </div>
    </div>
  );
}
