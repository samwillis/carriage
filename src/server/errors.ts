export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public retryable = false,
  ) {
    super(message);
    this.name = "AppError";
  }
}
export function fail(
  status: number,
  code: string,
  message: string,
  retryable = false,
): never {
  throw new AppError(status, code, message, retryable);
}
