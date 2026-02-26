"use client";

import { Crop, Image as ImageIcon, Layers3, MapPin, Minus, Plus, Ruler, ZoomIn, ZoomOut } from "lucide-react";

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
  engineKind: "raster" | "vector";
  typeHintLabel?: string;
};

type MapToolbarProps = {
  canInteract: boolean;
  isMounted: boolean;
  mapStyleId: string;
  mapStyles: MapStyleOption[];
  isBoxZoomActive: boolean;
  isZoomInToolActive: boolean;
  isZoomOutToolActive: boolean;
  isMarkerActive: boolean;
  isMeasurementActive: boolean;
  onMapStyleChange: (value: string) => void;
  onToggleBoxZoom: () => void;
  onToggleZoomInTool: () => void;
  onToggleZoomOutTool: () => void;
  onToggleMarker: () => void;
  onToggleMeasurement: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
};

export function MapToolbar({
  canInteract,
  isMounted,
  mapStyleId,
  mapStyles,
  isBoxZoomActive,
  isZoomInToolActive,
  isZoomOutToolActive,
  isMarkerActive,
  isMeasurementActive,
  onMapStyleChange,
  onToggleBoxZoom,
  onToggleZoomInTool,
  onToggleZoomOutTool,
  onToggleMarker,
  onToggleMeasurement,
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
                <MenubarTrigger className="h-full rounded-none px-3 text-foreground">Style</MenubarTrigger>
                <MenubarContent align="end" className="rounded-none">
                  <MenubarRadioGroup value={mapStyleId} onValueChange={onMapStyleChange}>
                    {mapStyles.map((style) => (
                      <MenubarRadioItem key={style.id} value={style.id} className="rounded-none">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="truncate">{style.label}</span>
                          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                            {style.engineKind === "vector" ? (
                              <Layers3 className="h-3.5 w-3.5" aria-hidden="true" />
                            ) : (
                              <ImageIcon className="h-3.5 w-3.5" aria-hidden="true" />
                            )}
                            <span>{style.typeHintLabel ?? (style.engineKind === "vector" ? "Vector" : "Raster")}</span>
                          </span>
                        </div>
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
              isMarkerActive ? "bg-muted" : "bg-background"
            }`}
            onClick={onToggleMarker}
            disabled={!canInteract}
            aria-label="Place marker tool"
            aria-pressed={isMarkerActive}
            title="Place marker tool"
          >
            <MapPin className="h-4 w-4" aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={`h-9 w-9 rounded-none border-border/80 p-0 text-foreground hover:bg-muted/60 ${
              isMeasurementActive ? "bg-muted" : "bg-background"
            }`}
            onClick={onToggleMeasurement}
            disabled={!canInteract}
            aria-label="Measure distance tool"
            aria-pressed={isMeasurementActive}
            title="Measure distance tool"
          >
            <Ruler className="h-4 w-4" aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={`h-9 w-9 rounded-none border-border/80 p-0 text-foreground hover:bg-muted/60 ${
              isZoomInToolActive ? "bg-muted" : "bg-background"
            }`}
            onClick={onToggleZoomInTool}
            disabled={!canInteract}
            aria-label="Zoom-in click tool"
            aria-pressed={isZoomInToolActive}
            title="Zoom-in click tool"
          >
            <ZoomIn className="h-4 w-4" aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={`h-9 w-9 rounded-none border-border/80 p-0 text-foreground hover:bg-muted/60 ${
              isZoomOutToolActive ? "bg-muted" : "bg-background"
            }`}
            onClick={onToggleZoomOutTool}
            disabled={!canInteract}
            aria-label="Zoom-out click tool"
            aria-pressed={isZoomOutToolActive}
            title="Zoom-out click tool"
          >
            <ZoomOut className="h-4 w-4" aria-hidden="true" />
          </Button>
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
