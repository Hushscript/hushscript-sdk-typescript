export { Hushscript } from "./client.ts";
export type { Clock } from "./clock.ts";
export type { HushscriptOptions } from "./config.ts";
export {
  AbortError,
  ApiError,
  AuthenticationError,
  ConfigurationError,
  ConflictError,
  DailyLimitError,
  FileLimitError,
  HushscriptError,
  InsufficientBalanceError,
  JobFailedError,
  NetworkError,
  NotFoundError,
  OutcomeUnknownError,
  PaymentMethodRequiredError,
  PermissionDeniedError,
  PreflightError,
  RateLimitError,
  ResumeMismatchError,
  UnsupportedMediaError,
  UploadError,
  ValidationError,
  WaitTimeoutError,
} from "./errors.ts";
export { ERROR_CATALOG } from "./generated/catalog.ts";
export type { ErrorCatalogEntry } from "./generated/catalog.ts";
export { HINTS } from "./generated/hints.ts";
export { OPERATION_SCOPES } from "./generated/scopes.ts";
export type { components, operations, paths } from "./generated/schema";
export type { Page } from "./paginate.ts";
export type { Account, Balance } from "./resources/account.ts";
export type { Job, JobState } from "./resources/jobs.ts";
export type {
  DeletedTranscript,
  PageOptions,
  PageRequest,
  TranscriptSummary,
} from "./resources/transcripts.ts";
export type {
  JobWaitOptions,
  Progress,
  ResumeOptions,
  ResumeToken,
  TranscribeOptions,
} from "./transcribe/index.ts";
export { paginate } from "./paginate.ts";
export { Transcript } from "./transcript.ts";
export type { CaptionOptions, LanguageOptions, TextOptions, Utterance } from "./transcript.ts";
export type { FileInput } from "./transcribe/source.ts";
