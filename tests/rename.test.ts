/** The product was renamed from AgentWeave to Agentlore; older setups must keep working. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { workspaceFrom } from "../src/core/workspaceArg.ts";

test("AGENTLORE_WORKSPACE is used; AGENTWEAVE_WORKSPACE still works as the older name", () => {
  assert.equal(workspaceFrom([], { AGENTLORE_WORKSPACE: "/ws/new" }).dir, "/ws/new");
  assert.equal(workspaceFrom([], { AGENTWEAVE_WORKSPACE: "/ws/old" }).dir, "/ws/old");
  assert.equal(workspaceFrom([], { AGENTLORE_WORKSPACE: "/ws/new", AGENTWEAVE_WORKSPACE: "/ws/old" }).dir, "/ws/new", "the new name wins");
  assert.equal(workspaceFrom([], { AGENTLORE_WORKSPACE: "", AGENTWEAVE_WORKSPACE: "/ws/old" }).dir, "/ws/old", "an empty new name falls back");
  assert.equal(workspaceFrom(["--workspace", "/ws/flag"], { AGENTLORE_WORKSPACE: "/ws/new" }).dir, "/ws/flag", "the flag wins over both");
  assert.equal(workspaceFrom([], {}).dir, null, "there is still no implicit default");
});
