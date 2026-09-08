import { expect, test } from "bun:test";

import { parseLinkIds } from "./link-route";

test("parses link_id header and preserves list order", () => {
  expect(parseLinkIds("link_id\n1531996558\n1347275583\n1531996558")).toEqual([
    "1531996558",
    "1347275583",
    "1531996558",
  ]);
});

test("parses headerless OpenStreetMap way IDs", () => {
  expect(parseLinkIds("1531996558\n1347275583")).toEqual(["1531996558", "1347275583"]);
});

test("rejects mixed non-link values", () => {
  expect(parseLinkIds("link_id\n1531996558\nnot-a-way")).toBeNull();
});
