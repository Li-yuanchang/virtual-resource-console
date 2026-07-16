import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeConsoleClipboardText,
  normalizeConsoleTextInput,
} from "../src/domain/consoleTextInput.ts";

test("preserves supported ASCII clipboard text", () => {
  const result = normalizeConsoleClipboardText("root@127.30\t--help");
  assert.equal(result.text, "root@127.30\t--help");
  assert.equal(result.unsupportedCharacterCount, 0);
});

test("normalizes full-width punctuation and letters", () => {
  const result = normalizeConsoleClipboardText("ｒｏｏｔ＠１２７。３０");
  assert.equal(result.text, "root@127.30");
  assert.equal(result.replacedCharacterCount, 11);
  assert.equal(result.unsupportedCharacterCount, 0);
});

test("normalizes CRLF and reports trailing line breaks", () => {
  const result = normalizeConsoleClipboardText("echo one\r\necho two\r\n");
  assert.equal(result.text, "echo one\necho two\n");
  assert.equal(result.lineCount, 3);
  assert.equal(result.trailingLineBreakCount, 1);
});

test("reports Unicode instead of silently sending partial content", () => {
  const result = normalizeConsoleClipboardText("密码abc🔐");
  assert.equal(result.text, "abc");
  assert.equal(result.unsupportedCharacterCount, 3);
  assert.equal(result.sourceCharacterCount, 6);
});

test("rejects unsafe control characters but allows clipboard tab and newline", () => {
  const clipboardResult = normalizeConsoleClipboardText("a\u001bb\bc\td\ne");
  assert.equal(clipboardResult.text, "abc\td\ne");
  assert.equal(clipboardResult.unsupportedCharacterCount, 2);

  const directResult = normalizeConsoleTextInput("a\tb\nc");
  assert.equal(directResult.text, "abc");
  assert.equal(directResult.unsupportedCharacterCount, 2);
});
