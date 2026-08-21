import { describe, expect, test } from "bun:test";

import { startOrAttachServer } from "../src/lib/sdk-server.ts";

describe("startOrAttachServer attach handle", () => {
  test("exposes asyncDispose that no-ops via close", async () => {
    const handle = await startOrAttachServer({
      opencodeBin: "true",
      attachUrl: "http://127.0.0.1:9",
    });

    expect(handle.url).toBe("http://127.0.0.1:9");
    expect(typeof handle[Symbol.asyncDispose]).toBe("function");
    expect(typeof handle.close).toBe("function");

    await handle[Symbol.asyncDispose]();
    await handle.close();
  });
});
