# Quote auto-fill with Gemini (Q1)

The property quote form can fill itself from the insurer's quote file. Two readers exist, chosen by
`OCR_PROVIDER`:

| `OCR_PROVIDER`   | Reader (`reader` in the API) | Reads                                                  | Leaves the server                                  |
| ---------------- | ---------------------------- | ------------------------------------------------------ | -------------------------------------------------- |
| `none` (default) | `BUILT_IN`                   | Text PDFs (pdfjs-dist + line matching)                 | Nothing                                            |
| `gemini`         | `GEMINI`                     | Text PDFs, scanned PDFs, PNG/JPEG pictures (not mails) | The PDF's text, or the file itself, sent to Google |

There is no fallback between readers: if Gemini is chosen and fails, the staff see why and can retry
or type the figures; the built-in reader is not used silently, and no other provider is called.

## How it works

```
Upload (POST /proposals/{id}/insurers/{insurerId}/quote-attachments, proposals.edit)
  type checked from the file's bytes (PDF, PNG, JPEG, .eml, .msg), 10 MB max, kept on the case
        │
"Fill the form from this PDF / picture" (POST /proposals/{id}/quote-attachments/{attachmentId}/read,
  proposals.edit; the attachment must belong to the case)
        │
QuoteReader (src/modules/quotes/quote-reader.ts), chosen by OCR_PROVIDER
        │
Gemini reader (src/modules/quotes/gemini-quote-reader.ts)
  1. Mail, empty file, > 10 MB, unreadable PDF, > 30 pages → manual entry, nothing sent.
  2. PDF with text on every page → its text is sent, page by page (no file).
     Scanned PDF (a page without text) or picture → the file is sent (no text).
  3. Gemini answers to a JSON schema (structured output): each value as printed, its page,
     a short verbatim excerpt, and FOUND / NOT_FOUND / AMBIGUOUS.
  4. The server validates the answer (Zod), normalizes every value with the shared helpers,
     checks the excerpt against the PDF's own text, and maps it to QuoteExtraction.
  5. Arithmetic checks (sections vs net, net + GST vs total, GST rate vs amount) are added.
        │
QuoteExtraction (src/shared/quote-ocr.ts): candidates only, nothing saved
        │
Quote form (Fiducial_frontend quote-form.tsx / quote-autofill.tsx)
  values fill the ordinary fields; each is listed with its excerpt and review state;
  the quote cannot be saved until "I have checked the values…" is ticked
        │
Save through the existing route (POST /proposals/{id}/insurers/{insurerId}/quotes), unchanged
```

Gemini's own answer format never leaves `gemini-quote-reader.ts`; the rest of the app only sees
`QuoteExtraction`, the same contract the built-in reader returns (plus `reader`).

## Setup

1. Get a Gemini API key for a Google account whose data terms have been approved for confidential
   insurance documents (see "Privacy" below).
2. In `Fiducial_backend/.env` (never in the frontend, never committed):

   ```
   OCR_PROVIDER=gemini
   GEMINI_API_KEY=<the key>
   # optional
   GEMINI_MODEL=gemini-3.8-flash
   GEMINI_TIMEOUT_MS=60000
   ```

3. Restart the API. With `OCR_PROVIDER=gemini` and no key, the API refuses to start and says
   `GEMINI_API_KEY: Required when OCR_PROVIDER=gemini` (the key's value is never printed).

| Variable            | Default            | Notes                                                                                                                                                     |
| ------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OCR_PROVIDER`      | `none`             | `none` or `gemini`.                                                                                                                                       |
| `GEMINI_API_KEY`    | —                  | Required with `gemini`. Server-side only; sent to Google in the `x-goog-api-key` header by the SDK.                                                       |
| `GEMINI_MODEL`      | `gemini-3.8-flash` | A stable Gemini model (listed as stable, no shutdown date, on Google's models page in October 2026). Check Google's deprecations page before changing it. |
| `GEMINI_TIMEOUT_MS` | `60000`            | Per request, 5,000–180,000.                                                                                                                               |

SDK: `@google/genai` 2.27.0 (`models.generateContent`, `responseMimeType: application/json`,
`responseJsonSchema`), pinned exactly like the other dependencies.

## Fields read

Only fields of the existing quote model are read; nothing new is stored.

| Field                                                                           | Fills the form?                                         | Normalized to                               |
| ------------------------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------- |
| Section premiums (Fire with / without terrorism, the other 13 sections by code) | Yes, for sections the RFQ asked for                     | Rupees with paise at most (`100000.50`)     |
| Valid until                                                                     | Yes                                                     | `YYYY-MM-DD` (day-first dates, as in India) |
| Net premium, GST amount, total premium                                          | Shown for comparison with the form's own totals         | Rupees                                      |
| GST rate                                                                        | Used for the arithmetic check                           | Percent (`18`)                              |
| Insurer name, quotation number                                                  | Shown so staff can check it is the right insurer's file | Text (120 characters max)                   |
| Insured name                                                                    | Returned, not shown                                     | Text                                        |

Not read: the quote option (Existing / Proposed 1 / 2 is the app's own concept), sums insured,
terms, deductibles, capacity, conditions. These are typed by the staff as before.

## Review states and validation

Each value keeps the existing states: `HIGH` ("Read clearly"), `LOW` ("please check"),
`MISSING`, `INVALID`. Gemini's own confidence is not asked for or used.

- `HIGH` only when Gemini said FOUND **and** the server found the excerpt in the PDF's own text (on
  the page given) **and** the value is in the excerpt. A value Gemini worked out rather than read is
  therefore `LOW`.
- Everything read from a picture or a scanned PDF is `LOW`: the server has no text to check it
  against.
- `AMBIGUOUS`, a section read twice, and CGST + SGST added together are `LOW`.
- `INVALID` when the value is not a plain figure: amount words (`1.5 lakh`, `2 Cr`), minus signs or
  brackets, ranges, `Nil`, `approx`. These are never converted; the staff decide.
- Zero is kept as zero (`0`, `0.00`), distinct from missing.
- Amounts are strings throughout; GST parts are added with `decimal.js`, and the arithmetic checks
  use integer paise. A quoted figure is never recalculated or replaced: mismatches are listed as
  discrepancies, along with Gemini's own notes (prefixed "Gemini noted:").
- If no premium at all is found, the result is "manual entry required".
- Nothing is saved or approved by a read: no quote version, insurer status, stage, QCR, RFQ or
  placement slip changes. The quote is recorded only by the existing save, after the staff tick the
  check box.

## Errors

A failed read answers `503` with code `UPSTREAM_UNAVAILABLE`, a message for the staff, and
`details: { reader: 'GEMINI', reason }`. The uploaded file is kept; the staff can click the button
again or type the figures.

| `reason`         | When                                                | Retried                         |
| ---------------- | --------------------------------------------------- | ------------------------------- |
| `RATE_LIMITED`   | Gemini answered 429                                 | Up to 2 more times (≈1 s, ≈4 s) |
| `UNAVAILABLE`    | 5xx (not 504), or the service could not be reached  | Up to 2 more times              |
| `TIMEOUT`        | No answer within `GEMINI_TIMEOUT_MS`, 408 or 504    | No (the file is not sent twice) |
| `NOT_AUTHORISED` | 401 / 403: the key was refused                      | No                              |
| `REFUSED`        | Other 4xx, a blocked prompt, a safety stop          | No                              |
| `MALFORMED`      | Not JSON, not the schema, or cut off (`MAX_TOKENS`) | No                              |

Limits: 10 MB per file (upload limit), 30 pages, 200,000 characters of text (beyond that the PDF is
sent instead), 16,384 output tokens.

## Logging and audit

- Logs (pino): reader, model, mode (`TEXT` / `FILE`), attempt, reason, HTTP status, duration. Never
  the key, the prompt, the document, Gemini's error text (it may echo the request) or any value.
  `apiKey` is also on the logger's redaction list.
- Audit `QUOTE_PDF_READ` for every read, including failed ones: attachment, file name, `reader`,
  `outcome` (`READ` / `FAILED`), `reason`, `source`, `sentExternally`, sections read. Never text or
  values.
- No prompt, answer or extracted value is stored anywhere; the original file stays on the case under
  the existing quote-attachment storage and retention.

## Privacy

With `OCR_PROVIDER=gemini`, insurer quotation content (premiums, insured's name, sometimes
addresses or employee data) is processed by Google outside this server.

- Google's Gemini API terms differ by tier. For unpaid use, Google says it uses submitted content
  and responses to improve its products, that human reviewers may read them, and not to submit
  confidential information. For paid use, Google says prompts and responses are not used to improve
  its products and are logged for a limited time for abuse detection. **The tier and terms that apply
  to the key actually configured have not been verified as part of this work.** Confirm them (and
  any data-processing agreement the client requires) before enabling Gemini for real documents.
- Only the data needed is sent: a text PDF's text without its images, and a scanned file only when
  there is no text. Mails are never sent.
- Only users with `proposals.edit` on the case can trigger a read, and only for that case's files.
- The app has no document classification to restrict this further; any restriction must be set by
  whoever decides `OCR_PROVIDER`.
- The document is treated as untrusted: the instructions tell Gemini never to follow instructions
  inside it, the document text is fenced (and cannot close its fence), the answer is limited to the
  JSON schema and validated, and every value is still reviewed by the staff.

## Tests

Standard suite (no network; Gemini is a fake):

```
cd Fiducial_backend
npx vitest run src/modules/quotes/gemini-quote-reader.test.ts   # request, mapping, failures, logs
npx vitest run test/quotes.test.ts                              # routes, auth, audit, retry, save
npx vitest run src/config/env.test.ts                           # OCR_PROVIDER / GEMINI_* settings
cd ../Fiducial_frontend
npx vitest run src/components/proposals/quotes                  # review UI
```

Optional live test (two real calls with synthetic quotes, never a real insurer's document: the
standard quote, and one with conflicting totals and missing fields; each result is validated against
`QuoteExtractionSchema` and printed as a summary of synthetic values; costs two requests and sends
that synthetic text to Google):

```
cd Fiducial_backend
GEMINI_API_KEY=<key> npm run test:live:gemini
```

It is skipped unless `GEMINI_LIVE_TEST=1` (set by the script) and a key are both present, and it is
not matched by `npm test`.

## Live validation, 22 Oct 2026

Run with `npm run test:live:gemini` (key from `.env`; output checked for the key: not present).

- **First run: both requests refused, `400 INVALID_ARGUMENT`.** A plain request with the same key
  and model succeeded, and the full response schema was accepted once its `maxItems` bounds were
  removed: Gemini refuses the schema with array bounds. Fixed by sending the schema without
  `maxItems` (`RESPONSE_JSON_SCHEMA`); the bounds are still enforced on the answer by
  `GeminiQuoteSchema`. Unit tests now check the schema that is sent. Mocked tests could not catch
  this: only Google validates the schema.
- **After the fix: the synthetic text quote passed.** Authenticated, answered in about 14 s,
  validated against `QuoteExtractionSchema`. Every value matched the quote and was verified against
  the PDF's text (HIGH); the unprinted insured name stayed MISSING; no discrepancies.
- **The conflicting-totals quote was not read:** the key hit `429 RESOURCE_EXHAUSTED`, quota
  `GenerateRequestsPerDayPerProjectPerModel-FreeTier` (20 requests a day), mostly used by the
  diagnosis above. The bounded retries behaved as designed (three attempts, then "busy").
- **The key used is on Google's free (unpaid) tier.** Under Google's terms for unpaid use, content
  may be used to improve Google's products and read by human reviewers, and confidential data
  should not be sent. Do not read real insurer quotes with this key; use a paid-tier key approved
  for confidential data.

## Limitations

- Accuracy on real insurers' quotes is **unverified**: only synthetic fixtures have been used. The
  client's 3–5 sample quotes are still needed.
- Live validation (22 Oct 2026, synthetic quotes only) covered the text-PDF path only. The
  scanned-PDF/picture path (file sent inline) and the conflicting-totals case have not been run live.
- Quotes over 30 pages and mails are not read.
- A PDF that has text on every page is sent as text: a table drawn as an image inside such a PDF is
  not seen.
- The GST rate is not derived from CGST/SGST rates; the GST amount from parts is `LOW`.
- Sums insured, terms, deductibles and conditions are not filled.
