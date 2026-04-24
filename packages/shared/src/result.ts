// SPDX-License-Identifier: MPL-2.0

/**
 * Discriminated-union Result type. Used at the Query API boundary where errors are
 * expected (validation, RLS denials, unknown operations) and throwing is reserved
 * for genuinely exceptional conditions (lost DB connection, logic bug).
 *
 * Per CLAUDE.md §4: "errors are values where it matters".
 */

export type Ok<T> = { readonly ok: true; readonly value: T };
export type Err<E> = { readonly ok: false; readonly error: E };
export type Result<T, E> = Ok<T> | Err<E>;

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

export function err<E>(error: E): Err<E> {
  return { ok: false, error };
}

export function isOk<T, E>(result: Result<T, E>): result is Ok<T> {
  return result.ok;
}

export function isErr<T, E>(result: Result<T, E>): result is Err<E> {
  return !result.ok;
}
