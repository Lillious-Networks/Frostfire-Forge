import { expect, test } from "bun:test";
import { blockParts, inMove, registerBlockPart, type BlockPart } from "../cluster/blockparts";

const part = (name: string, order: number): BlockPart => ({ name, order, collect: () => null, restore: () => {}, accept: () => {} });

test("parts come back lowest order first, and one is removed by the function registration answers", () => {
  const offB = registerBlockPart(part("test-b", 5));
  const offA = registerBlockPart(part("test-a", 1));
  try {
    const names = blockParts().map((p) => p.name).filter((name) => name.startsWith("test-"));
    expect(names).toEqual(["test-a", "test-b"]);
  } finally {
    offA();
    offB();
  }
  expect(blockParts().some((p) => p.name.startsWith("test-"))).toBe(false);
});

test("a second part of one name is refused", () => {
  const off = registerBlockPart(part("test-dup", 1));
  try {
    expect(() => registerBlockPart(part("test-dup", 2))).toThrow("test-dup");
  } finally {
    off();
  }
});

test("inMove knows a point of the moving block, on the bare map", () => {
  const move = { map: "main", bx: 1, by: 0 };
  expect(inMove(move, "main.json", 4096 + 10, 10)).toBe(true);
  expect(inMove(move, "main", 10, 10)).toBe(false);
  expect(inMove(move, "cave", 4096 + 10, 10)).toBe(false);
});

test("inMove uses the block lookup it is given", () => {
  const move = { map: "main", bx: 2, by: 2 };
  expect(inMove(move, "main", 0, 0, () => ({ bx: 2, by: 2 }))).toBe(true);
});

test("parts of one order come back by name", () => {
  const offZ = registerBlockPart(part("test-z", 1));
  const offY = registerBlockPart(part("test-y", 1));
  try {
    const names = blockParts().map((p) => p.name).filter((name) => name.startsWith("test-"));
    expect(names).toEqual(["test-y", "test-z"]);
  } finally {
    offZ();
    offY();
  }
});

test("an undo whose part was replaced removes nothing", () => {
  const first = registerBlockPart(part("test-owned", 1));
  first();
  const second = part("test-owned", 2);
  const off = registerBlockPart(second);
  try {
    first();
    expect(blockParts()).toContain(second);
  } finally {
    off();
  }
});

test("inMove refuses another block row and a position that is not a number", () => {
  expect(inMove({ map: "main", bx: 1, by: 1 }, "main", 4096 + 10, 10)).toBe(false);
  expect(inMove({ map: "main", bx: 0, by: 0 }, "main", NaN, 10)).toBe(false);
});
