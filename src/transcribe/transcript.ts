import type { components } from "../generated/schema";

/** Until the Transcript class arrives, a transcript is the raw `GET /v1/transcripts/{id}` body. */
export type Transcript = components["schemas"]["TranscriptDetail"];

/** The one place a transcript response becomes the value `transcribe()` returns. */
export function toTranscript(body: Transcript): Transcript {
  return body;
}
