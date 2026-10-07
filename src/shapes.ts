import type { components } from "./generated/schema";
import {
  anything,
  arrayOf,
  bool,
  nullable,
  num,
  objectOf,
  optional,
  pathId,
  positiveInt,
  positiveIntAtMost,
  recordOf,
  str,
  timestamp,
  url,
  type Shape,
} from "./shape.ts";

type Schemas = components["schemas"];

/** What the friendly layer reads from each 2xx body: the fields its mappers use, checked before they are touched. */

const UPLOAD_LIMITS = objectOf<Schemas["UploadLimits"]>({
  max_daily_seconds: num,
  max_active_jobs: num,
  active_jobs: num,
  used_today_seconds: num,
});

export const ACCOUNT: Shape = objectOf<Schemas["AccountResponse"]>({
  balance_seconds: num,
  held_seconds: num,
  credits_expire_at: nullable(timestamp),
  card_on_file: bool,
  data_region: str,
  limits: UPLOAD_LIMITS,
});

const OPTIONS_SUMMARY = objectOf<Schemas["OptionsSummary"]>({
  language_code: nullable(str),
  speaker_detection: bool,
  medical_mode: bool,
  multichannel: bool,
  translation_targets: arrayOf(str),
  keyterms: bool,
  prompt: bool,
  auto_generate_insights: nullable(bool),
});

const JOB = objectOf<Schemas["Job"]>({
  id: str,
  state: str,
  mode: str,
  declared_seconds: nullable(num),
  verified_seconds: nullable(num),
  actual_seconds: nullable(num),
  billable_seconds: nullable(num),
  error: nullable(str),
  failure_kind: nullable(str),
  retry_of: nullable(str),
  created_at: timestamp,
  transcript_id: nullable(pathId),
  options: OPTIONS_SUMMARY,
});

export const JOB_LIST: Shape = objectOf<Schemas["JobList"]>({
  jobs: arrayOf(JOB),
  next_cursor: nullable(str),
});
export const JOB_ONE: Shape = JOB;

/** The API clamps any part size to 8-32 MiB; a larger one would break the memory bound (concurrency x part size). */
export const MAX_PART_BYTES: number = 32 * 1024 * 1024;

const PART_URL = objectOf<Schemas["PresignedPartUrl"]>({ n: positiveInt, url });

export const UPLOAD_CREATE: Shape = objectOf<Schemas["UploadCreateResponse"]>({
  job_id: pathId,
  state: str,
  upload: nullable(
    objectOf<NonNullable<Schemas["UploadCreateResponse"]["upload"]>>({
      part_size_bytes: positiveIntAtMost(MAX_PART_BYTES),
      total_parts: positiveInt,
      part_urls: nullable(arrayOf(PART_URL)),
      next_part_number: nullable(positiveInt),
    }),
  ),
});

export const UPLOAD_COMPLETE: Shape = objectOf<Schemas["UploadCompleteResponse"]>({ state: str });

/** `null`, or a `null` part_urls, is the answer for a job that takes proxied parts only. */
export const PART_URLS: Shape = nullable(
  objectOf<{
    part_urls: unknown;
    next_part_number: unknown;
  }>({
    part_urls: nullable(arrayOf(PART_URL)),
    next_part_number: optional(nullable(positiveInt)),
  }),
);

const UTTERANCE = objectOf<Schemas["Utterance"]>({
  speaker: str,
  start_ms: num,
  end_ms: num,
  text: str,
});
const TRANSCRIPT_LANGUAGE = objectOf<Schemas["TranscriptLanguage"]>({
  utterances: arrayOf(UTTERANCE),
});

export const TRANSCRIPT_DETAIL: Shape = objectOf<Schemas["TranscriptDetail"]>({
  id: str,
  title: str,
  language_detected: nullable(str),
  duration_seconds: num,
  speaker_names: recordOf(str),
  tags: arrayOf(str),
  created_at: timestamp,
  updated_at: timestamp,
  auto_delete_at: nullable(timestamp),
  edited: bool,
  body: objectOf<Schemas["TranscriptEnvelope"]>({
    original: TRANSCRIPT_LANGUAGE,
    translations: recordOf(TRANSCRIPT_LANGUAGE),
  }),
});

export const TRANSCRIPT_LIST: Shape = objectOf<Schemas["TranscriptList"]>({
  transcripts: arrayOf(
    objectOf<Schemas["TranscriptListRow"]>({
      id: str,
      title: str,
      language_detected: nullable(str),
      duration_seconds: num,
      created_at: timestamp,
      auto_delete_at: nullable(timestamp),
      tags: arrayOf(str),
    }),
  ),
  next_cursor: nullable(str),
});

export const DELETED_LIST: Shape = objectOf<Schemas["DeletedTranscriptsResponse"]>({
  deleted: arrayOf(
    objectOf<Schemas["DeletedTranscript"]>({
      id: str,
      title: str,
      duration_seconds: num,
      created_at: timestamp,
      deleted_at: timestamp,
      cause: str,
      receipt: nullable(recordOf(anything)),
    }),
  ),
  next_cursor: nullable(str),
});

export const PACKS: Shape = objectOf<Schemas["PacksResponse"]>({
  packs: arrayOf(
    objectOf<Schemas["Pack"]>({
      id: str,
      amount: num,
      currency: str,
      seconds: num,
      referral_bonus_seconds: num,
      available: optional(bool),
    }),
  ),
});

export const CARDS: Shape = objectOf<Schemas["CardsResponse"]>({
  default_id: nullable(str),
  methods: arrayOf(
    objectOf<Schemas["Card"]>({
      id: str,
      type: str,
      brand: str,
      last4: str,
      exp_month: num,
      exp_year: num,
      email: nullable(str),
      is_default: bool,
      fast_checkout_eligible: bool,
    }),
  ),
});

export const SET_DEFAULT_CARD: Shape = objectOf<{ ok: unknown }>({ ok: bool });

export const SETUP_SESSION: Shape = objectOf<Schemas["SetupSessionResponse"]>({
  checkout_url: url,
});

export const TRANSACTIONS: Shape = objectOf<Schemas["TransactionsResponse"]>({
  transactions: arrayOf(
    objectOf<Schemas["Transaction"]>({
      id: num,
      seconds: num,
      amount_cents: num,
      amount_refunded_cents: num,
      currency: str,
      status: str,
      created_at: timestamp,
      payment_method_type: nullable(str),
      payment_method_brand: nullable(str),
      payment_method_last4: nullable(str),
      receipt_number: nullable(str),
      initiated_via: nullable(str),
    }),
  ),
  next_cursor: nullable(str),
});

export const LEDGER: Shape = objectOf<Schemas["CreditLedgerResponse"]>({
  entries: arrayOf(
    objectOf<Schemas["CreditLedgerEntry"]>({
      id: num,
      delta_seconds: num,
      kind: str,
      job_id: nullable(str),
      note: nullable(str),
      created_at: timestamp,
    }),
  ),
  next_cursor: nullable(str),
});

export const HOLDS: Shape = objectOf<Schemas["HoldsResponse"]>({
  holds: arrayOf(
    objectOf<Schemas["ActiveHold"]>({
      id: str,
      kind: str,
      seconds: num,
      created_at: timestamp,
    }),
  ),
  next_cursor: nullable(str),
});

export const AGENT_SIGNUP: Shape = objectOf<Schemas["AgentSignupResponse"]>({
  signup_id: str,
  claim_secret: str,
  checkout_url: str,
  amount: num,
  currency: str,
  expires_at: timestamp,
});
