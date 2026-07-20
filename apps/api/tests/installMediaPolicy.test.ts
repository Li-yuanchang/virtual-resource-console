import assert from "node:assert/strict";
import test from "node:test";
import { isXenGuestToolsIsoName } from "../src/installMediaPolicy.js";

test("separates XenServer guest-tools media from operating-system installers", () => {
  assert.equal(isXenGuestToolsIsoName("guest-tools.iso"), true);
  assert.equal(isXenGuestToolsIsoName("guest-tools-7.1.54-1.iso"), true);
  assert.equal(isXenGuestToolsIsoName("xs-tools.iso"), true);
  assert.equal(isXenGuestToolsIsoName("CentOS-7-x86_64-DVD-1511.iso"), false);
});
