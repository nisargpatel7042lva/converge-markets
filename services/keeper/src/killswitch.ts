import { existsSync } from "node:fs";

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

  setHttp(on: boolean): void {
    this.http = on;
  }

  get sources(): { env: boolean; file: boolean; http: boolean } {
    return { env: this.env, file: this.exists(this.file), http: this.http };
  }

  get killed(): boolean {
    const s = this.sources;
    return s.env || s.file || s.http;
  }
}
