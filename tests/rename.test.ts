/** The product was renamed AgentWeave -> Agentlore -> Agentsol; older setups must keep working. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { workspaceFrom } from "../src/core/workspaceArg.ts";

test("AGENTSOL_WORKSPACE is used; AGENTLORE_WORKSPACE and AGENTWEAVE_WORKSPACE still work as older names", () => {
  assert.equal(workspaceFrom([], { AGENTSOL_WORKSPACE: "/ws/new" }).dir, "/ws/new");
  assert.equal(workspaceFrom([], { AGENTLORE_WORKSPACE: "/ws/lore" }).dir, "/ws/lore");
  assert.equal(workspaceFrom([], { AGENTWEAVE_WORKSPACE: "/ws/old" }).dir, "/ws/old");
  assert.equal(workspaceFrom([], { AGENTSOL_WORKSPACE: "/ws/new", AGENTLORE_WORKSPACE: "/ws/lore", AGENTWEAVE_WORKSPACE: "/ws/old" }).dir, "/ws/new", "the newest name wins");
  assert.equal(workspaceFrom([], { AGENTLORE_WORKSPACE: "/ws/lore", AGENTWEAVE_WORKSPACE: "/ws/old" }).dir, "/ws/lore");
  assert.equal(workspaceFrom([], { AGENTSOL_WORKSPACE: "", AGENTWEAVE_WORKSPACE: "/ws/old" }).dir, "/ws/old", "an empty newer name falls back");
  assert.equal(workspaceFrom(["--workspace", "/ws/flag"], { AGENTSOL_WORKSPACE: "/ws/new" }).dir, "/ws/flag", "the flag wins over all");
  assert.equal(workspaceFrom([], {}).dir, null, "there is still no implicit default");
});
