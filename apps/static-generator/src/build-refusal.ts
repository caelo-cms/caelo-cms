// SPDX-License-Identifier: MPL-2.0

/**
 * #1484 — a build the generator refuses because of the site's content (a page
 * with no content in its language, no homepage, a redirect with an unsafe
 * target), where the message names what to change. Nothing failed: the gate
 * worked. The CLI reports it as a refusal, so the deploy keeps failing while
 * the chat's automatic bug capture leaves it alone. Every other throw from the
 * build stays a defect; a failure the site's content cannot fix never uses this.
 */
export class BuildRefusal extends Error {
  override readonly name = "BuildRefusal";
}
