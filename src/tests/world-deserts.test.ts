import { expect, test } from "bun:test";
import { desertsOf, snowfieldsOf } from "../modules/worldmaps";

const square = (x: number, y: number, size: number) => [[x, y], [x + size, y], [x + size, y + size], [x, y + size]];

test("only the desert zones of a manifest are kept, with their bounds and rings", () => {
  const zones = [
    { id: 1, name: "Wind Fields", kind: "grassland", bbox: { x: 0, y: 0, w: 10, h: 10 }, outline: [square(0, 0, 10)] },
    { id: 4, name: "Red Barrens", kind: "desert", levels: [22, 31], hub: "Sunbury", bbox: { x: 20, y: 20, w: 30, h: 30 }, outline: [square(20, 20, 30), square(30, 30, 5)] },
  ];
  expect(desertsOf(zones)).toEqual([
    { name: "Red Barrens", bbox: { x: 20, y: 20, w: 30, h: 30 }, outline: [square(20, 20, 30), square(30, 30, 5)] },
  ]);
});

test("a manifest without zones, and rings or bounds that are not numbers, give no desert", () => {
  expect(desertsOf(undefined)).toEqual([]);
  expect(desertsOf("deserts")).toEqual([]);
  const broken = [
    { name: "No outline", kind: "desert", bbox: { x: 0, y: 0, w: 1, h: 1 } },
    { name: "Too few points", kind: "desert", bbox: { x: 0, y: 0, w: 1, h: 1 }, outline: [[[0, 0], [1, 1]]] },
    { name: "No bounds", kind: "desert", outline: [square(0, 0, 4)] },
    { name: "Bad points", kind: "desert", bbox: { x: 0, y: 0, w: 4, h: 4 }, outline: [[[0, 0], ["a", 1], [4, 0], [4, 4], null]] },
  ];
  // The ring with a bad point keeps its good ones.
  expect(desertsOf(broken)).toEqual([{ name: "Bad points", bbox: { x: 0, y: 0, w: 4, h: 4 }, outline: [[[0, 0], [4, 0], [4, 4]]] }]);
});

test("the snow zones are kept the same way, apart from the deserts", () => {
  const zones = [
    { name: "Red Barrens", kind: "desert", bbox: { x: 20, y: 20, w: 30, h: 30 }, outline: [square(20, 20, 30)] },
    { name: "Snowy Wastes", kind: "snow", bbox: { x: 0, y: 0, w: 10, h: 10 }, outline: [square(0, 0, 10)] },
  ];
  expect(snowfieldsOf(zones)).toEqual([{ name: "Snowy Wastes", bbox: { x: 0, y: 0, w: 10, h: 10 }, outline: [square(0, 0, 10)] }]);
  expect(desertsOf(zones).map((z) => z.name)).toEqual(["Red Barrens"]);
  expect(snowfieldsOf(undefined)).toEqual([]);
});
