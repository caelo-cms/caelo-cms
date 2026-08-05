// SPDX-License-Identifier: MPL-2.0
export function bindZodForm(schema, initial = {}) {
    let values = $state({ ...initial });
    let errors = $state({});
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
                if (errors[field])
                    errors = { ...errors, [field]: undefined };
            }
            else {
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
