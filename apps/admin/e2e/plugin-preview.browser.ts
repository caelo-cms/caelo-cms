// SPDX-License-Identifier: MPL-2.0
import { expect, test } from "@playwright/test";

/** Uses an existing authorized local fixture; chat transport is intercepted: no AI calls or book writes. */
test("plugin pages and exact element references stay beside chat and follow new revisions", async ({
  page,
  context,
}) => {
  const chatId = process.env.CAELO_PREVIEW_CHAT_ID;
  const previous = process.env.CAELO_PREVIEW_PREVIOUS;
  const current = process.env.CAELO_PREVIEW_CURRENT;
  test.skip(!chatId || !previous || !current, "Provide a private local preview fixture");
  if (!chatId || !previous || !current) return;
  const previousArgs = JSON.parse(
    new URL(previous, "http://localhost").searchParams.get("args") ?? "{}",
  );
  const currentArgs = JSON.parse(
    new URL(current, "http://localhost").searchParams.get("args") ?? "{}",
  );
  await page.goto("/login");
  await page.getByLabel("Email").fill("dev-owner@example.com");
  await page.getByLabel("Password").fill("dev owner password");
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL(/\/edit/);
  await page.goto(`/edit?chat=${chatId}&pluginPreview=${encodeURIComponent(previous)}`);
  const frame = page.frameLocator('iframe[title="Plugin live preview"]');
  await expect(page.getByTestId("plugin-live-preview")).toBeVisible();
  await page.getByLabel("Preview page", { exact: true }).selectOption({ label: "Seite 17" });
  await expect(frame.locator(".page")).toHaveCount(1);
  await expect(frame.locator(".page-number")).toHaveText("Seite 17");
  await frame.locator(".story").click();
  await expect(page.getByTestId("plugin-selection-chip")).toContainText("Seite 17 · Text");
  const iframeBox = await page.locator('iframe[title="Plugin live preview"]').boundingBox();
  const composerBox = await page.getByTestId("chat-composer").boundingBox();
  expect(iframeBox && composerBox && iframeBox.x + iframeBox.width <= composerBox.x).toBeTruthy();
  // Parent-window messages are rejected, even with the current channel and a declared target ID.
  const imageTarget = await frame
    .locator(".illustration")
    .getAttribute("data-caelo-preview-target");
  await page.evaluate((id) => {
    const iframe = document.querySelector(
      'iframe[title="Plugin live preview"]',
    ) as HTMLIFrameElement;
    window.postMessage(
      {
        kind: "caelo:plugin-target",
        channel: new URL(iframe.src).searchParams.get("channel"),
        id,
      },
      location.origin,
    );
  }, imageTarget);
  const documentFrame = page.frames().find((f) => f.url().includes("channel="));
  if (!documentFrame) throw new Error("Missing document frame");
  await documentFrame.evaluate(() =>
    parent.postMessage(
      {
        kind: "caelo:plugin-target",
        channel: new URL(location.href).searchParams.get("channel"),
        id: "undeclared-target",
      },
      "*",
    ),
  );
  await page.waitForTimeout(100);
  await expect(page.getByTestId("plugin-selection-chip")).toContainText("Seite 17 · Text");
  let sent: Record<string, unknown> | undefined;
  await page.route(`**/content/chat/${chatId}/stream`, async (route) => {
    sent = route.request().postDataJSON();
    await route.fulfill({
      contentType: "text/event-stream",
      body: [
        {
          kind: "tool-start",
          toolCallId: "preview-browser-test",
          name: "pictbook__save_draft",
          arguments: currentArgs,
        },
        {
          kind: "tool-result",
          toolCallId: "preview-browser-test",
          ok: true,
          content: JSON.stringify({ previewUrl: current }),
        },
        { kind: "done" },
      ]
        .map((event) => `data: ${JSON.stringify(event)}\n\n`)
        .join(""),
    });
  });
  await page.getByTestId("chat-composer").fill("Diesen Text bitte kürzer formulieren.");
  await page.getByTestId("chat-send").click();
  await expect.poll(() => sent).toBeTruthy();
  expect(sent?.previewSelection).toMatchObject({
    pluginSlug: "pictbook",
    label: "Seite 17 · Text",
    reference: { bookId: previousArgs.bookId, revisionId: previousArgs.revisionId, part: "text" },
  });
  expect(
    (sent?.previewSelection as { reference: { pageId: string } } | undefined)?.reference.pageId,
  ).toMatch(/^[a-f0-9-]{36}$/);
  await expect(page.locator('iframe[title="Plugin live preview"]')).toHaveAttribute(
    "src",
    new RegExp(currentArgs.revisionId),
  );
  await expect(
    page.getByLabel("Preview page", { exact: true }).locator("option:checked"),
  ).toHaveText("Seite 17");
  await expect(page.getByTestId("plugin-selection-chip")).toContainText("Seite 17 · Text");
  await page.reload();
  await expect(
    page.getByLabel("Preview page", { exact: true }).locator("option:checked"),
  ).toHaveText("Seite 17");
  await expect(frame.locator(".page")).toHaveCount(1);
  await page.screenshot({
    path: process.env.CAELO_PREVIEW_SCREENSHOT ?? "/tmp/caelo-plugin-live-preview.png",
  });
  const anonymous = await context.browser()!.newContext();
  const response = await anonymous.request.get(
    new URL(current + "&format=metadata", page.url()).href,
    { maxRedirects: 0 },
  );
  expect([302, 303, 401, 403]).toContain(response.status());
  await anonymous.close();
});
