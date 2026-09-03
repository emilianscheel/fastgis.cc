import { expect, test } from "bun:test";

import { parseTrajectoryCsv } from "./trajectory";

test("parses timestamp, latitude, and longitude trajectory rows", () => {
  expect(
    parseTrajectoryCsv(
      "timestamp,latitude,longitude\n2026-09-02T10:15:47,49.05831,9.27869\n2026-09-02T10:15:48,49.05824,9.27868",
    ),
  ).toEqual([
    {
      timestamp: "2026-09-02T10:15:47",
      latitude: "49.05831",
      longitude: "9.27869",
      coordinate: [9.27869, 49.05831],
    },
    {
      timestamp: "2026-09-02T10:15:48",
      latitude: "49.05824",
      longitude: "9.27868",
      coordinate: [9.27868, 49.05824],
    },
  ]);
});

test("rejects CSV files without coordinate headers", () => {
  expect(parseTrajectoryCsv("timestamp,location\n2026-09-02T10:15:47,unknown")).toBeNull();
});
