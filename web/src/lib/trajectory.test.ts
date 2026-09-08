import { expect, test } from "bun:test";

import { parseTrajectory } from "./trajectory";

test("parses timestamp, latitude, and longitude trajectory rows", () => {
  expect(
    parseTrajectory(
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
  expect(parseTrajectory("timestamp,location\n2026-09-02T10:15:47,unknown")).toBeNull();
});

test("detects semicolon-delimited TollNow trajectories with speed metadata", () => {
  expect(parseTrajectory("TIME;LAT;LON;DIRECTION;SPEED\n2026-09-02T08:03:53;52.375409;13.168512;999.9;0")).toEqual([
    {
      timestamp: "2026-09-02T08:03:53",
      latitude: "52.375409",
      longitude: "13.168512",
      coordinate: [13.168512, 52.375409],
      direction: 999.9,
      speed: 0,
    },
  ]);
});

test("infers adjacent latitude and longitude columns without a header", () => {
  expect(parseTrajectory("2026-09-02T08:03:53\t52.375409\t13.168512\n2026-09-02T08:04:00\t52.375396\t13.168499")).toEqual([
    {
      timestamp: "2026-09-02T08:03:53",
      latitude: "52.375409",
      longitude: "13.168512",
      coordinate: [13.168512, 52.375409],
    },
    {
      timestamp: "2026-09-02T08:04:00",
      latitude: "52.375396",
      longitude: "13.168499",
      coordinate: [13.168499, 52.375396],
    },
  ]);
});
