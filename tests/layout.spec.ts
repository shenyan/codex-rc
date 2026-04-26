import { test, expect } from "@playwright/test";

const TOKEN = process.env.CODEX_RC_TOKEN ?? "testtoken";

test.describe("responsive layout", () => {
  test("first hit consumes token + sets cookie", async ({ page }) => {
    await page.goto(`/?t=${TOKEN}`);
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByText("codex-rc", { exact: true })).toBeVisible();
  });

  test("phone: list shows, detail hidden until clicked", async ({ page, viewport }, info) => {
    test.skip(info.project.name !== "iphone", "phone-only");
    await page.goto(`/?t=${TOKEN}`);
    await page.waitForSelector('[data-testid="thread-list"]');

    // Create a fresh thread; many may already exist on the server.
    const before = await page.getByTestId("thread-row").count();
    await page.getByTestId("new-chat-btn").click();
    await expect.poll(async () => page.getByTestId("thread-row").count()).toBe(before + 1);

    // Click row → goes to /c/:id, list is hidden on mobile
    await page.getByTestId("thread-row").first().click();
    await expect(page).toHaveURL(/\/c\//);
    await expect(page.getByTestId("composer")).toBeVisible();
    await expect(page.getByTestId("back-btn")).toBeVisible();

    // List should be hidden on phone
    const listVisible = await page.getByTestId("thread-list").isVisible();
    expect(listVisible).toBe(false);

    // Back button returns to list
    await page.getByTestId("back-btn").click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByTestId("thread-list")).toBeVisible();

    await page.screenshot({ path: "tests/__screenshots__/phone-list.png" });
  });

  test("phone chat detail screenshot", async ({ page }, info) => {
    test.skip(info.project.name !== "iphone", "phone-only");
    await page.goto(`/?t=${TOKEN}`);
    await page.getByTestId("new-chat-btn").click();
    await page.getByTestId("thread-row").first().click();
    await expect(page.getByTestId("composer")).toBeVisible();
    await page.screenshot({ path: "tests/__screenshots__/phone-chat.png" });
  });

  test("ipad: split view shows both panes simultaneously", async ({ page }, info) => {
    test.skip(info.project.name !== "ipad", "ipad-only");
    await page.goto(`/?t=${TOKEN}`);
    await page.getByTestId("new-chat-btn").click();
    await page.getByTestId("thread-row").first().click();

    // List + composer both visible
    await expect(page.getByTestId("thread-list")).toBeVisible();
    await expect(page.getByTestId("composer")).toBeVisible();

    // Back button hidden on tablet (no need)
    const backVisible = await page.getByTestId("back-btn").isVisible();
    expect(backVisible).toBe(false);

    await page.screenshot({ path: "tests/__screenshots__/ipad-split.png" });
  });

  test("desktop: split view, empty pane on home", async ({ page }, info) => {
    test.skip(info.project.name !== "desktop", "desktop-only");
    await page.goto(`/?t=${TOKEN}`);
    await expect(page.getByText("Pick or create a chat")).toBeVisible();
    await page.screenshot({ path: "tests/__screenshots__/desktop-home.png" });

    await page.getByTestId("new-chat-btn").click();
    await page.getByTestId("thread-row").first().click();
    await expect(page.getByTestId("thread-list")).toBeVisible();
    await expect(page.getByTestId("composer")).toBeVisible();
    await page.screenshot({ path: "tests/__screenshots__/desktop-chat.png" });
  });
});

test.describe("send message round-trip", () => {
  test("send 'Reply with exactly: pong' and receive streamed agent reply", async ({ page }, info) => {
    test.skip(info.project.name !== "desktop", "one platform is enough for round-trip");
    test.setTimeout(120_000);

    await page.goto(`/?t=${TOKEN}`);
    await page.getByTestId("new-chat-btn").click();
    await page.getByTestId("thread-row").first().click();

    const composer = page.getByTestId("composer");
    await composer.fill("Reply with exactly: pong");
    await page.getByTestId("send-btn").click();

    // User message rendered
    await expect(page.getByTestId("msg-user")).toContainText("pong");

    // Agent message arrives
    await expect(page.getByTestId("msg-agent").first()).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("msg-agent").first()).not.toBeEmpty();

    await page.screenshot({ path: "tests/__screenshots__/desktop-round-trip.png" });
  });
});
