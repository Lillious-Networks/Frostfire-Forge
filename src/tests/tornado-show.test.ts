import { beforeEach, expect, test } from "bun:test";
import * as t from "../systems/tornadoes";

// The 10 Hz TORNADOES list goes to each player alone, holding only the tornadoes near them: a viewer's own sight
// radius plus SHOW_MARGIN. showNearby is what the engine's bridge `show` runs; here the engine is a few stand-ins.

type Sent = { id: string; list: Array<{ id: string; x: number; y: number }> };

let viewers: any[];
let sent: Sent[];

const viewer = (id: string, x: number, y: number, aoiRadius = 1000) => ({ id, location: { position: { x, y } }, aoi: { aoiRadius } });
const tornado = (id: string, x: number, y: number) => ({ id, x, y });

const io = {
  // every viewer is a candidate; showNearby does the exact distance test itself
  near: () => viewers,
  get: (id: string) => viewers.find((v) => v.id === id),
  reach: (v: any) => v.aoi.aoiRadius,
  send: (v: any, list: any[]) => { sent.push({ id: v.id, list }); },
};

beforeEach(() => {
  t.resetTornadoes();
  viewers = [];
  sent = [];
});

test("each viewer gets only the tornadoes within their sight radius plus the margin", () => {
  viewers = [viewer("near", 1000, 1000), viewer("far", 9000, 9000), viewer("edge", 1000 + 1000 + t.SHOW_MARGIN, 1000)];
  t.showNearby("overworld", [tornado("t1", 1000, 1000), tornado("t2", 9000, 9500)], io);

  const by = (id: string) => sent.find((s) => s.id === id)?.list.map((x) => x.id);
  expect(by("near")).toEqual(["t1"]);
  expect(by("far")).toEqual(["t2"]);
  expect(by("edge")).toEqual(["t1"]);
  expect(sent.length).toBe(3);
});

test("a viewer's own radius counts: a short-sighted viewer does not get a tornado a default-sighted one does", () => {
  viewers = [viewer("short", 0, 0, 200), viewer("normal", 0, 0, 1000)];
  t.showNearby("overworld", [tornado("t1", 1200, 0)], io);
  expect(sent.map((s) => s.id)).toEqual(["normal"]);
});

test("a viewer who sees several gets them in one list", () => {
  viewers = [viewer("a", 0, 0)];
  t.showNearby("overworld", [tornado("t1", 100, 0), tornado("t2", 200, 0)], io);
  expect(sent).toEqual([{ id: "a", list: [tornado("t1", 100, 0), tornado("t2", 200, 0)] }]);
});

test("a viewer whose list becomes empty is told once, then left alone", () => {
  viewers = [viewer("a", 0, 0)];
  t.showNearby("overworld", [tornado("t1", 100, 0)], io);
  sent = [];

  viewers[0].location.position = { x: 20000, y: 0 };
  t.showNearby("overworld", [tornado("t1", 100, 0)], io);
  expect(sent).toEqual([{ id: "a", list: [] }]);

  sent = [];
  t.showNearby("overworld", [tornado("t1", 100, 0)], io);
  expect(sent).toEqual([]);
});

test("a viewer who never saw one is never sent an empty list", () => {
  viewers = [viewer("a", 20000, 0)];
  t.showNearby("overworld", [tornado("t1", 100, 0)], io);
  t.showNearby("overworld", [], io);
  expect(sent).toEqual([]);
});

test("when the storm passes, everyone who was shown one gets the final empty list", () => {
  viewers = [viewer("a", 0, 0), viewer("b", 100, 0), viewer("c", 20000, 0)];
  t.showNearby("overworld", [tornado("t1", 0, 0)], io);
  sent = [];

  t.showNearby("overworld", [], io);
  expect(sent.map((s) => s.id).sort()).toEqual(["a", "b"]);
  expect(sent.every((s) => s.list.length === 0)).toBe(true);
});

test("a viewer who left (no longer found) is skipped, and maps are tracked apart", () => {
  viewers = [viewer("a", 0, 0)];
  t.showNearby("overworld", [tornado("t1", 0, 0)], io);
  t.showNearby("other", [], io);
  expect(sent.length).toBe(1);   // nothing owed on "other"

  sent = [];
  viewers = [];
  t.showNearby("overworld", [], io);
  expect(sent).toEqual([]);
});
