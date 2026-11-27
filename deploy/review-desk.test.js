const test = require("node:test");
const assert = require("node:assert/strict");
const { decisionPatch, cookieValue, sameText } = require("./review-desk");

test("approval keeps the photo for training and does not invent confirmations", () => {
  assert.deepEqual(decisionPatch("approved"), { reject: false, train: true });
  assert.deepEqual(decisionPatch("rejected"), { reject: true, train: false });
  assert.equal(decisionPatch("later"), null);
});

test("the review cookie matches only the operator key", () => {
  const secret = "1234567890abcdef";
  const cookie = cookieValue(secret);
  assert.equal(cookie.length, 64);
  assert.equal(sameText(cookie, cookie), true);
  assert.equal(sameText("nope", cookie), false);
  assert.equal(cookieValue("short"), "");
});
