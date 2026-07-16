export interface ConsoleTextNormalizationResult {
  text: string;
  sourceCharacterCount: number;
  replacedCharacterCount: number;
  unsupportedCharacterCount: number;
  lineCount: number;
  trailingLineBreakCount: number;
}

const CONSOLE_TEXT_NORMALIZATION_MAP: Record<string, string> = {
  "。": ".",
  "．": ".",
  "｡": ".",
  "，": ",",
  "、": "\\",
  "；": ";",
  "：": ":",
  "？": "?",
  "！": "!",
  "（": "(",
  "）": ")",
  "【": "[",
  "】": "]",
  "［": "[",
  "］": "]",
  "｛": "{",
  "｝": "}",
  "＠": "@",
  "＿": "_",
  "－": "-",
  "＝": "=",
  "＋": "+",
  "／": "/",
  "＼": "\\",
  "｜": "|",
  "＂": "\"",
  "＇": "'",
  "｀": "`",
  "～": "~",
  "＜": "<",
  "＞": ">",
  "＃": "#",
  "＄": "$",
  "％": "%",
  "＾": "^",
  "＆": "&",
  "＊": "*",
};

/**
 * Normalizes direct IME text into the ASCII subset supported by compatibility keyboard input.
 * Unsupported characters are reported instead of being silently omitted by callers.
 */
export function normalizeConsoleTextInput(text: string): ConsoleTextNormalizationResult {
  return normalizeConsoleText(text, false);
}

/**
 * Normalizes clipboard text while preserving line breaks and tabs used by terminal paste.
 * Other control characters and non-ASCII characters are reported as unsupported.
 */
export function normalizeConsoleClipboardText(text: string): ConsoleTextNormalizationResult {
  return normalizeConsoleText(text.replace(/\r\n?/g, "\n"), true);
}

function normalizeConsoleText(text: string, allowLayoutCharacters: boolean): ConsoleTextNormalizationResult {
  let normalizedText = "";
  let replacedCharacterCount = 0;
  let unsupportedCharacterCount = 0;
  const characters = [...text];

  for (const char of characters) {
    if (allowLayoutCharacters && (char === "\n" || char === "\t")) {
      normalizedText += char;
      continue;
    }

    const mappedChar = CONSOLE_TEXT_NORMALIZATION_MAP[char];
    if (mappedChar) {
      normalizedText += mappedChar;
      replacedCharacterCount += 1;
      continue;
    }

    const codePoint = char.codePointAt(0);
    if (codePoint != null && codePoint >= 0xff01 && codePoint <= 0xff5e) {
      normalizedText += String.fromCharCode(codePoint - 0xfee0);
      replacedCharacterCount += 1;
      continue;
    }

    if (codePoint != null && codePoint >= 0x20 && codePoint <= 0x7e) {
      normalizedText += char;
      continue;
    }

    unsupportedCharacterCount += 1;
  }

  const trailingLineBreakCount = normalizedText.length - normalizedText.replace(/\n+$/g, "").length;
  return {
    text: normalizedText,
    sourceCharacterCount: characters.length,
    replacedCharacterCount,
    unsupportedCharacterCount,
    lineCount: normalizedText ? normalizedText.split("\n").length : 0,
    trailingLineBreakCount,
  };
}
