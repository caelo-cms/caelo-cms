// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from "bun:test";
import { thrownErrorAsFailure, thrownErrorMessage } from "./thrown-error-message.js";
describe("thrownErrorMessage", () => {
    it("names the server's message and the next step", () => {
        expect(thrownErrorMessage({ message: "CSRF token mismatch" })).toBe("This could not be sent (CSRF token mismatch). Reload the page and try again.");
    });
    it("an error without a message still reads as a sentence", () => {
        for (const e of [undefined, null, {}, { message: 42 }, { message: "" }]) {
            expect(thrownErrorMessage(e)).toBe("This could not be sent (the request failed). Reload the page and try again.");
        }
    });
});
describe("thrownErrorAsFailure", () => {
    it("keeps the status and names the dialog that stays open", () => {
        expect(thrownErrorAsFailure({
            status: 403,
            error: { message: "CSRF token mismatch" },
            location: "/settings/updates?/install",
        }, "install")).toEqual({
            type: "failure",
            status: 403,
            location: "/settings/updates?/install",
            data: {
                error: "This could not be sent (CSRF token mismatch). Reload the page and try again.",
                thrownError: true,
                action: "install",
            },
        });
    });
    it("a policy dialog's failure is flagged for the policy card", () => {
        const r = thrownErrorAsFailure({ status: 500, error: undefined, location: "/settings/updates?/pause" }, "pause", { policy: true });
        expect(r.data.policy).toBe(true);
        expect(r.data.action).toBe("pause");
    });
});
