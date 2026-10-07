import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Three independent ways to stop the keeper from quoting: the KILL environment flag at start, a
 * file whose existence means "killed", and the authenticated HTTP endpoint. Any one of them is
 * enough; clearing one does not clear the others.
 */
const HTTP_MARKER = "killed over HTTP at";

export class KillSwitch {
  private http = false;

  constructor(
    private readonly env: boolean,
    private readonly file: string,
    private readonly exists: (p: string) => boolean = existsSync,
  ) {}

  /**
   * The HTTP kill is written to the kill file so that it survives a restart (a process that comes
   * back up must not quietly resume what an operator killed); /unkill removes the file.
   */
  setHttp(on: boolean): boolean {
    this.http = on;
    try {
      if (on) {
        // an operator's own kill file is left alone (and then /unkill will not remove it)
        if (!this.exists(this.file)) {
          mkdirSync(dirname(this.file), { recursive: true });
          writeFileSync(this.file, `${HTTP_MARKER} ${new Date().toISOString()}\n`);
        }
      } else if (
        this.exists(this.file) &&
        readFileSync(this.file, "utf8").startsWith(HTTP_MARKER)
      ) {
        rmSync(this.file, { force: true }); // only the file this endpoint wrote
      }
      return true;
    } catch {
      // the in-memory flag still holds, but the kill will not survive a restart: say so
      return false;
    }
  }

  get sources(): { env: boolean; file: boolean; http: boolean } {
    return { env: this.env, file: this.exists(this.file), http: this.http };
  }

  get killed(): boolean {
    const s = this.sources;
    return s.env || s.file || s.http;
  }
}
