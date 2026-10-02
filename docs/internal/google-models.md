# Google models

The chat picker and resolver share the pinned default `gemini-3.8-flash`.
Existing saved IDs remain visible and are not migrated silently. Gemini 3.1 Pro
is explicitly labelled Preview. Image models are configured separately under
**Security → AI → Google → Image model** because Gemini image models do not
support the chat's function-calling workflow. Leave the image field empty to
disable generation; a different supported image model ID may also be entered.

The curated image options are Nano Banana 2, Nano Banana 2 Lite, Nano Banana Pro
and Nano Banana. Images use the same encrypted Google key as chat. Environment
credentials support `GOOGLE_API_KEY` and `GOOGLE_GENERATIVE_AI_API_KEY`, with the
former taking precedence; credential status uses the same lookup.

The image adapter uses the installed AI SDK's multimodal `generateText` path,
requests IMAGE and TEXT modalities and translates the size selector to a square,
landscape or portrait aspect ratio. Provider output dimensions are read from the
actual image, not inferred from the requested ratio. Automatic SDK retries are
disabled for paid image calls so uncertain provider failures do not silently
start another generation. The adapter accepts host-resolved PNG, JPEG and WebP
reference bytes (no reference URLs): up to 14 for the three curated Gemini 3
image models and up to 3 for Gemini 2.5. Native 1K, 2K and 4K resolution controls
are accepted only for those known Gemini 3 image models. References are limited
to 10 MB each and 20 MB in total; invalid inputs fail before a paid call. The
installed SDK sends these as file parts and excludes internal thought images
from the final generated image. These are adapter inputs, not yet plugin APIs.
This does not provide resumable jobs or private plugin media storage; those
remain separate service work.

Source verification: 2026-09-11.

- [Google model catalogue](https://ai.google.dev/gemini-api/docs/models)
- [Gemini 3.8 Flash](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash)
- [Google image generation](https://ai.google.dev/gemini-api/docs/image-generation)
- [Nano Banana 2](https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-image)

Validation exercises the actual installed SDK with captured HTTP requests and
real PostgreSQL encrypted-key resolution. Live account access and generated
image quality require a configured Google key and are not implied by these tests.

Google's GenerateContent function `Schema.enum` accepts string values. The
installed SDK converts numeric JSON Schema constants/enums into that field
unchanged, which makes the entire chat request fail (for example, redirect
status codes 301/302/307/308/410). The Gemini model middleware adapts only the
wire tool schemas: numeric/boolean choices remain typed arguments, with their
allowed values described instead of an unsupported enum. String enums are
preserved. Caelo's canonical schemas, coercion and strict dispatch validation
are unchanged; an invalid redirect status still fails validation. Nullable type
arrays are represented as schema branches so object properties stay attached
to the object type. The structured-set tool declares its object item shape
without restoring a top-level discriminator union.

The opt-in `e2e-livedit/google-pictbook.browser.ts` exercises the live Google
provider through browser login, a fresh chat and the Pictbook entry. It uses no
credential seed or provider mock; enable it only on a configured local instance
with `CAELO_LIVE_GOOGLE_PICTBOOK=1`.

Tool-result history rows recover the required function name from the preceding
call ID, including calls in canonical SDK response messages. SDK messages remain
unchanged; orphan results fail locally instead of sending an empty function name.

Live Chromium acceptance passed on 2026-09-14 against the configured Google
provider: login, new chat, Pictbook entry, guide loading and a completed response
asking for the book concept. This verifies chat/tool round trips, not image
creation or PDF export.
