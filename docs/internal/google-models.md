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
start another generation. This does not provide resumable jobs or private plugin
media storage; those remain separate service work.

Source verification: 2026-09-11.

- [Google model catalogue](https://ai.google.dev/gemini-api/docs/models)
- [Gemini 3.8 Flash](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash)
- [Google image generation](https://ai.google.dev/gemini-api/docs/image-generation)
- [Nano Banana 2](https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-image)

Validation exercises the actual installed SDK with captured HTTP requests and
real PostgreSQL encrypted-key resolution. Live account access and generated
image quality require a configured Google key and are not implied by these tests.
