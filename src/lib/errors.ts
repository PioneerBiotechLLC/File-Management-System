/** A problem the person can fix; its message is safe to show in the UI and the CLI. */
export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserError";
  }
}
