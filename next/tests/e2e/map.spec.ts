import path from "node:path";

import { expect, test } from "@playwright/test";

test("renders map canvas and supports CSV trajectory upload", async ({ page }) => {
  await page.goto("/");

  const canvas = page.getByLabel("map-canvas");
  await expect(canvas).toBeVisible();

  const fileChooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Choose CSV" }).click();
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles(path.join(process.cwd(), "tests/fixtures/sample-trajectory.csv"));

  await expect(page.getByText("Valid rows")).toBeVisible();
  await expect(page.getByText("4")).toBeVisible();

  await page.getByRole("button", { name: "Clear Trajectory" }).click();
  await expect(page.getByText("Valid rows")).toHaveCount(0);
});

test("handles pointer pan interactions", async ({ page }) => {
  await page.goto("/");

  const canvas = page.getByLabel("map-canvas");
  await expect(canvas).toBeVisible();
  const box = await canvas.boundingBox();
  if (!box) {
    throw new Error("Map canvas has no bounding box");
  }

  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.55, { steps: 10 });
  await page.mouse.up();
});

