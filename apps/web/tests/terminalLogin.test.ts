import assert from "node:assert/strict";
import test from "node:test";
import { TerminalLoginPrompt } from "../src/domain/terminalLogin.js";

test("collects a username and a non-echoed password for one terminal session", () => {
  const prompt = new TerminalLoginPrompt();
  assert.equal(prompt.start(), "login: ");

  const username = prompt.consume("root\r");
  assert.equal(username.output, "root\r\npassword: ");
  assert.equal(username.credentials, undefined);

  const password = prompt.consume("secret\r");
  assert.equal(password.output, "\r\n");
  assert.deepEqual(password.credentials, { username: "root", password: "secret" });
  assert.equal(prompt.acceptsInput, false);
});

test("supports backspace without exposing password characters", () => {
  const prompt = new TerminalLoginPrompt();
  prompt.start();
  assert.equal(prompt.consume("roox\u007ft\r").output, "roox\r\u001b[2Klogin: root\r\npassword: ");
  assert.equal(prompt.consume("bad\u007fok").output, "");
  assert.deepEqual(prompt.consume("\r").credentials, { username: "root", password: "baok" });
});

test("redraws the full login line when deleting wide characters", () => {
  const prompt = new TerminalLoginPrompt();
  prompt.start();
  prompt.consume("的方");
  assert.equal(prompt.consume("\u007f\u007f").output, "\r\u001b[2Klogin: 的\r\u001b[2Klogin: ");
});

test("does not stop username input before the terminal width is reached", () => {
  const prompt = new TerminalLoginPrompt();
  prompt.start();
  const username = "1".repeat(160);
  assert.equal(prompt.consume(username).output, username);
});

test("restarts the login prompt after cancellation or failed authentication", () => {
  const prompt = new TerminalLoginPrompt();
  prompt.start();
  assert.equal(prompt.consume("root\u0003").output, "root\r\n^C\r\nlogin: ");
  assert.equal(prompt.start("Login incorrect"), "Login incorrect\r\nlogin: ");
});
