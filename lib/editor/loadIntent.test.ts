import { expect, it } from "vitest";
import { LoadIntent } from "./loadIntent";

it("rejects delayed class/account results after a newer request or edit", async () => {
  const intent = new LoadIntent();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  let look = "Hunter";
  const hunter = intent.begin();
  const load = pending.then(() => { if (hunter.current()) look = "old Hunter"; });
  const titan = intent.begin();
  look = "Titan";
  release();
  await load;
  expect(look).toBe("Titan");
  expect(hunter.signal.aborted).toBe(true);
  expect(titan.current()).toBe(true);
  intent.invalidate(); // saved look, manual edit, undo, or unmount
  expect(titan.current()).toBe(false);
  expect(titan.signal.aborted).toBe(true);
});

it("survives StrictMode cleanup and restart without reviving the earlier load", () => {
  const intent = new LoadIntent();
  const first = intent.begin();
  intent.invalidate();
  const second = intent.begin();
  expect(first.current()).toBe(false);
  expect(second.current()).toBe(true);
});
