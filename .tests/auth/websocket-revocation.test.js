import test from "node:test";
import assert from "node:assert/strict";

import { websocketService } from "../../backend/services/websocketService.js";

const makeClient = (closed, id, userId) => ({
  id,
  user: { id: userId },
  subscriptions: new Set(["status", "weekly-flow"]),
  ws: {
    readyState: 1,
    close(code, reason) {
      this.readyState = 2;
      closed.push({ id, code, reason });
    },
  },
});

test("disconnectUser immediately revokes every websocket for a user", () => {
  const closed = [];
  const first = makeClient(closed, "first", 41);
  const second = makeClient(closed, "second", 41);
  const other = makeClient(closed, "other", 42);
  websocketService.clients.add(first);
  websocketService.clients.add(second);
  websocketService.clients.add(other);

  try {
    assert.equal(websocketService.disconnectUser(41), 2);
    assert.deepEqual(closed, [
      { id: "first", code: 4403, reason: "Account inactive" },
      { id: "second", code: 4403, reason: "Account inactive" },
    ]);
    assert.equal(websocketService.clients.has(first), false);
    assert.equal(websocketService.clients.has(second), false);
    assert.equal(websocketService.clients.has(other), true);
    assert.equal(first.user, null);
    assert.equal(first.subscriptions.size, 0);
  } finally {
    websocketService.clients.clear();
    websocketService.revokedUsers.clear();
  }
});

test("disconnectUser remembers the revocation for connections still authenticating", () => {
  const before = Date.now();
  try {
    websocketService.disconnectUser(43);
    assert.ok(websocketService.revokedUsers.get(43) >= before);
    websocketService.disconnectUser("not-a-user");
    assert.equal(websocketService.revokedUsers.has(Number.NaN), false);
  } finally {
    websocketService.revokedUsers.clear();
  }
});
