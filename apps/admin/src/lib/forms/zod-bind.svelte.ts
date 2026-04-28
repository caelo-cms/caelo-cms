// SPDX-License-Identifier: MPL-2.0

/**
 * P6.6a — client-side validation helper. Pass the same Zod schema the
 * server uses (e.g. `pageCreateSchema` from @caelo/shared) and the
 * helper returns a reactive `{ errors, valid }` proxy you read in the
 * template. Fire `update(field, value)` on every input event; the
 * helper runs `safeParse` and exposes per-path error messages.
 *
 * The schema is the single source of truth — server enforces it
 * authoritatively; the client mirrors it for fast feedback. Fields
 * whose validation requires a DB round-trip (slug uniqueness, login
 * credentials) still surface server-side after submit.
 *
 * Fields are addressed by string path (not narrowed `keyof T`) because
 * Zod's inferred type only exposes required fields; optional / default
 * fields disappear from the keyof, but the form still binds them.
 */
interface ZodIssue {
  readonly path: readonly PropertyKey[];
  readonly message: string;
}
interface ZodParseResult {
  readonly success: boolean;
  readonly error?: { readonly issues: readonly ZodIssue[] };
}
interface ZodLikeSchema {
  safeParse(value: unknown): ZodParseResult;
}

export interface FormBinding {
  readonly errors: Record<string, string | undefined>;
  readonly valid: boolean;
  readonly values: Record<string, unknown>;
  update(field: string, value: unknown): void;
  reset(): void;
}

export function bindZodForm(
  schema: ZodLikeSchema,
  initial: Record<string, unknown> = {},
): FormBinding {
  let values = $state<Record<string, unknown>>({ ...initial });
  let errors = $state<Record<string, string | undefined>>({});
  // `valid` is derived from a fresh safeParse on every read so callers
  // can disable submit buttons via `disabled={!form.valid}` without
  // duplicating validation state.
  const valid = $derived.by(() => schema.safeParse(values).success);

  return {
    get errors() {
      return errors;
    },
    get valid() {
      return valid;
    },
    get values() {
      return values;
    },
    update(field, value) {
      values = { ...values, [field]: value };
      const parsed = schema.safeParse(values);
      if (parsed.success) {
        // Clear the field's error on a successful parse — but leave
        // OTHER field errors in place so untouched fields still show
        // their last-known message.
        if (errors[field]) errors = { ...errors, [field]: undefined };
      } else {
        const issue = parsed.error?.issues.find((i) => i.path[0] === field);
        errors = { ...errors, [field]: issue?.message };
      }
    },
    reset() {
      values = { ...initial };
      errors = {};
    },
  };
}
