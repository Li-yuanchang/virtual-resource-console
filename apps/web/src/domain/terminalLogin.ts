export interface TerminalSessionCredentials {
  username: string;
  password: string;
}

export type TerminalLoginStage = "idle" | "username" | "password" | "submitting";

export interface TerminalLoginInputResult {
  output: string;
  credentials?: TerminalSessionCredentials;
}

const MAX_USERNAME_LENGTH = 256;
const MAX_PASSWORD_LENGTH = 1024;
const LOGIN_PROMPT = "login: ";

/**
 * Collects one-time SSH credentials inside xterm without echoing the password.
 */
export class TerminalLoginPrompt {
  private stage: TerminalLoginStage = "idle";
  private username = "";
  private password = "";

  get currentStage(): TerminalLoginStage {
    return this.stage;
  }

  get acceptsInput(): boolean {
    return this.stage === "username" || this.stage === "password";
  }

  start(message = ""): string {
    this.clearSecrets();
    this.stage = "username";
    return `${message ? `${message}\r\n` : ""}${LOGIN_PROMPT}`;
  }

  reset(): void {
    this.clearSecrets();
    this.stage = "idle";
  }

  consume(rawData: string): TerminalLoginInputResult {
    if (!this.acceptsInput || !rawData) return { output: "" };
    let output = "";
    const data = rawData.replaceAll("\r\n", "\r");

    for (const character of data) {
      if (!this.acceptsInput) break;
      if (character === "\u0003") {
        output += `\r\n${this.start("^C")}`;
        continue;
      }
      if (character === "\u0015") {
        if (this.stage === "username") {
          this.username = "";
          output += `\r\u001b[2K${LOGIN_PROMPT}`;
        } else {
          this.password = "";
        }
        continue;
      }
      if (character === "\r" || character === "\n") {
        if (this.stage === "username") {
          if (!this.username) {
            output += "\r\nlogin: ";
            continue;
          }
          this.stage = "password";
          output += "\r\npassword: ";
          continue;
        }
        if (!this.password) {
          output += "\r\npassword: ";
          continue;
        }
        const credentials = { username: this.username, password: this.password };
        this.clearSecrets();
        this.stage = "submitting";
        return { output: `${output}\r\n`, credentials };
      }
      if (character === "\u007f" || character === "\b") {
        if (this.stage === "username") {
          if (this.username) this.username = this.username.slice(0, -1);
          // Redraw the whole line so wide Unicode characters are removed by cell width,
          // rather than moving the cursor back by only one terminal column.
          output += `\r\u001b[2K${LOGIN_PROMPT}${this.username}`;
        } else if (this.stage === "password" && this.password) {
          this.password = this.password.slice(0, -1);
        }
        continue;
      }
      if (character < " " || character === "\u007f") continue;
      if (this.stage === "username" && this.username.length < MAX_USERNAME_LENGTH) {
        this.username += character;
        output += character;
      } else if (this.stage === "password" && this.password.length < MAX_PASSWORD_LENGTH) {
        this.password += character;
      }
    }

    return { output };
  }

  private clearSecrets(): void {
    this.username = "";
    this.password = "";
  }
}
