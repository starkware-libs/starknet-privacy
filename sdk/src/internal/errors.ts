/** Error thrown when a block reorg is detected (HTTP 409 status). */
export class ReorgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReorgError";
  }
}
