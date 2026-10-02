// SPDX-License-Identifier: MPL-2.0
import { expect, test } from "@playwright/test";

/** Uses an existing authorized local fixture; chat transport is intercepted: no AI calls or book writes. */
test("plugin pages and exact element references stay beside chat and follow new revisions", async ({
  page,
  context,
}) => {
  test.setTimeout(180_000);
  page.setDefaultTimeout(30_000);
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));

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
  await expect(frame.locator(".page")).toHaveCount(1, { timeout: 30_000 });
  await expect(frame.locator(".page-number")).toHaveText("Seite 17");
  await expect(page.getByTestId("plugin-selection-chip")).toContainText("Seite 17");
  await frame.locator(".story").click();
  await expect(page.getByTestId("plugin-selection-chip")).toContainText("Seite 17 · Text");
  await page.getByLabel("Remove preview reference", { exact: true }).click();
  await expect(page.getByTestId("plugin-selection-chip")).toContainText("Seite 17");
  await expect(page.getByLabel("Remove preview reference", { exact: true })).toHaveCount(0);
  await frame.locator(".story").click();
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
    const toolCallId = crypto.randomUUID();
    await route.fulfill({
      contentType: "text/event-stream",
      body: [
        {
          kind: "tool-start",
          toolCallId,
          name: "pictbook__save_draft",
          arguments: currentArgs,
        },
        {
          kind: "tool-result",
          toolCallId,
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
  await expect(frame.locator(".page")).toHaveCount(1, { timeout: 30_000 });
  await page.screenshot({
    path: process.env.CAELO_PREVIEW_SCREENSHOT ?? "/tmp/caelo-plugin-live-preview.png",
  });

  // Automatic context survives clearing an element and follows scrolling, without clicking.
  await page.getByLabel("Preview page", { exact: true }).selectOption("all");
  await expect(frame.locator(".page")).toHaveCount(24, { timeout: 30_000 });
  await frame
    .locator(".page")
    .nth(16)
    .evaluate((node) => node.scrollIntoView({ block: "start" }));
  await expect(page.getByTestId("plugin-selection-chip")).toContainText("Seite 17");
  await page.getByTestId("chat-composer").fill("Diese Seite bitte prüfen.");
  await page.getByTestId("chat-send").click();
  await expect
    .poll(() => (sent?.previewSelection as { reference?: { part?: string } })?.reference?.part)
    .toBe("page");
  expect((sent?.previewSelection as { reference: { bookId: string } }).reference.bookId).toBe(
    currentArgs.bookId,
  );
  await page.getByLabel("Preview page", { exact: true }).selectOption("assets");
  await expect(
    frame.getByRole("heading", { name: "Bilder & Referenzen", exact: true }),
  ).toBeVisible();
  const character = frame.locator('article[data-caelo-preview-target^="character-"]').first();
  await expect(character).toBeVisible();
  await character.getByRole("heading").click();
  await page.getByTestId("chat-composer").fill("Diese Figur als eigene Referenz ausarbeiten.");
  await page.getByTestId("chat-send").click();
  await expect
    .poll(() => (sent?.previewSelection as { reference?: { part?: string } })?.reference?.part)
    .toBe("character.references");
  expect(
    (sent?.previewSelection as { reference: { characterId: string } }).reference.characterId,
  ).toMatch(/^[a-f0-9-]{36}$/);
  await page.getByLabel("Preview page", { exact: true }).selectOption("design");
  await expect(
    frame.getByRole("heading", { name: "Briefing & Gestaltung", exact: true }),
  ).toBeVisible();
  await frame.locator('[data-caelo-preview-target="briefing"]').click();
  await expect(page.getByTestId("plugin-selection-chip")).toContainText("Briefing");
  const picker = page.getByLabel("Preview document", { exact: true });
  const other = await picker
    .locator("option")
    .evaluateAll(
      (nodes, currentId) =>
        nodes.map((n) => (n as HTMLOptionElement).value).find((id) => id !== currentId),
      currentArgs.bookId,
    );
  expect(other).toBeTruthy();
  await picker.selectOption(other!);
  await expect(page.locator('iframe[title="Plugin live preview"]')).toHaveAttribute(
    "src",
    new RegExp(other!),
  );
  await expect(page.getByTestId("plugin-selection-chip")).toBeVisible();
  await page.getByTestId("chat-composer").fill("Welches Buch ist das?");
  await page.getByTestId("chat-send").click();
  await expect
    .poll(() => (sent?.previewSelection as { reference?: { bookId?: string } })?.reference?.bookId)
    .toBe(other);
  // The intercepted tool result restores the original book; a new preview never modifies either book.
  await expect(page.locator('iframe[title="Plugin live preview"]')).toHaveAttribute(
    "src",
    new RegExp(currentArgs.bookId),
  );

  const anonymous = await context.browser()!.newContext();
  const response = await anonymous.request.get(
    new URL(current + "&format=metadata", page.url()).href,
    { maxRedirects: 0 },
  );
  expect([302, 303, 401, 403]).toContain(response.status());
  await anonymous.close();
  expect(browserErrors).toEqual([]);
});
