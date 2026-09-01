import { expect, test, beforeEach } from "bun:test";
import * as idx from "../services/aoiReverseIndex";

beforeEach(() => idx._reset());

test("addViewer / getViewers basic", () => {
  idx.addViewer("target", "viewerA");
  idx.addViewer("target", "viewerB");
  expect([...idx.getViewers("target")].sort()).toEqual(["viewerA", "viewerB"]);
});

test("getViewers returns empty set for unknown target", () => {
  expect(idx.getViewers("nobody").size).toBe(0);
});

test("addViewer is idempotent", () => {
  idx.addViewer("t", "v");
  idx.addViewer("t", "v");
  expect(idx.getViewers("t").size).toBe(1);
});

test("removeViewer drops the entry and prunes empty sets", () => {
  idx.addViewer("t", "v");
  idx.removeViewer("t", "v");
  expect(idx.getViewers("t").size).toBe(0);
  expect(idx._size()).toBe(0);
});

test("id normalisation: number and string ids are the same key", () => {
  idx.addViewer(42, "viewer");
  expect(idx.getViewers("42").has("viewer")).toBe(true);
  idx.removeViewer("42", "viewer");
  expect(idx.getViewers(42).size).toBe(0);
});

test("replaceVisibleSet reindexes only the diff", () => {
  // viewer initially sees a, b, c
  idx.replaceVisibleSet("viewer", [], ["a", "b", "c"]);
  expect(idx.getViewers("a").has("viewer")).toBe(true);
  expect(idx.getViewers("b").has("viewer")).toBe(true);
  expect(idx.getViewers("c").has("viewer")).toBe(true);

  // now sees b, c, d - a removed, d added, b/c unchanged
  idx.replaceVisibleSet("viewer", ["a", "b", "c"], ["b", "c", "d"]);
  expect(idx.getViewers("a").size).toBe(0);
  expect(idx.getViewers("b").has("viewer")).toBe(true);
  expect(idx.getViewers("c").has("viewer")).toBe(true);
  expect(idx.getViewers("d").has("viewer")).toBe(true);
});

test("clearViewer removes the viewer from every target", () => {
  idx.addViewer("t1", "v");
  idx.addViewer("t2", "v");
  idx.addViewer("t2", "other");
  idx.clearViewer("v");
  expect(idx.getViewers("t1").size).toBe(0);
  expect([...idx.getViewers("t2")]).toEqual(["other"]);
});

test("clearViewed removes the target entirely", () => {
  idx.addViewer("t", "v1");
  idx.addViewer("t", "v2");
  idx.clearViewed("t");
  expect(idx.getViewers("t").size).toBe(0);
  expect(idx._size()).toBe(0);
});

test("invariant: index mirrors a set of forward playersInAOI sets", () => {
  // Simulate 5 players, each with a forward set, and mirror every mutation.
  const forward = new Map<string, Set<string>>();
  const ids = ["p1", "p2", "p3", "p4", "p5"];
  for (const id of ids) forward.set(id, new Set());

  const see = (viewer: string, viewed: string) => {
    forward.get(viewer)!.add(viewed);
    idx.addViewer(viewed, viewer);
  };
  const unsee = (viewer: string, viewed: string) => {
    forward.get(viewer)!.delete(viewed);
    idx.removeViewer(viewed, viewer);
  };

  see("p1", "p2");
  see("p1", "p3");
  see("p2", "p1");
  see("p3", "p1");
  see("p4", "p1");
  unsee("p1", "p3");
  see("p5", "p1");
  unsee("p4", "p1");

  // For every viewed id, the reverse index must equal the set of viewers whose
  // forward set contains it.
  for (const viewed of ids) {
    const expected = new Set<string>();
    for (const [viewer, set] of forward) {
      if (set.has(viewed)) expected.add(viewer);
    }
    expect([...idx.getViewers(viewed)].sort()).toEqual([...expected].sort());
  }
});
