import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Three independent ways to stop the keeper from quoting: the KILL environment flag at start, a
 * file whose existence means "killed", and the authenticated HTTP endpoint. Any one of them is
 * enough; clearing one does not clear the others.
 */
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
  setHttp(on: boolean): void {
    this.http = on;
    try {
      if (on) {
        mkdirSync(dirname(this.file), { recursive: true });
        writeFileSync(this.file, `killed over HTTP at ${new Date().toISOString()}\n`);
      } else rmSync(this.file, { force: true });
    } catch {
      // the in-memory flag still holds; a read-only file system is reported by the server caller
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
