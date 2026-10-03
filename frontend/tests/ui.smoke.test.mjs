import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";

const base = process.env.PROOFFLOW_TEST_URL ?? "http://localhost:3001";
const edge = process.env.PROOFFLOW_BROWSER_PATH ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

test("editor saves manual, paste and AI events and restores them after reload", async () => {
  const browser = await chromium.launch({ executablePath: edge, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
    await page.goto(base);
    const editor = page.getByRole("textbox", { name: "文档正文" });
    await page.getByText("正文已保存 · 未验证").waitFor();
    await editor.fill("Hello ");
    await page.getByText("正文服务端版本 1").waitFor();
    await editor.evaluate((input) => {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
      const clipboardData = new DataTransfer();
      clipboardData.setData("text/plain", "pasted ");
      input.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }));
    });
    await page.getByText("正文服务端版本 2").waitFor();
    assert.equal(await editor.inputValue(), "Hello pasted ");
    assert.equal(await page.locator(".timeline-item").count(), 2);
    const pasteRow = page.locator(".timeline-item").filter({ hasText: "粘贴" });
    await pasteRow.hover();
    assert.equal(await page.locator(".source-span.is-linked").count(), 1);
    await page.getByRole("button", { name: "插入到文档" }).click();
    await page.getByText("正文服务端版本 3").waitFor();
    assert.match(await editor.inputValue(), /AI can offer personalized practice/);

    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "导出本地 JSON 草稿" }).click();
    const download = await downloadPromise;
    const json = JSON.parse(readFileSync(await download.path(), "utf8"));
    assert.equal(json.editorSchemaVersion, 1);
    assert.equal(json.serverVersion, 3);
    assert.equal(json.events.length, 3);
    assert.equal(json.events[1].insertedText, "pasted ");
    assert.equal(json.events[2].aiResponseId, json.aiResponses[0].id);

    const output = join(process.cwd(), "data");
    mkdirSync(output, { recursive: true });
    await page.screenshot({ path: join(output, "proofflow-desktop.png"), fullPage: true });
    await page.reload();
    await page.getByText("正文服务端版本 3").waitFor();
    await page.getByText("正文已保存 · 未验证").waitFor();
    assert.equal(await page.locator(".timeline-item").count(), 3);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: join(output, "proofflow-mobile.png"), fullPage: true });
    const width = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, viewport: innerWidth }));
    assert.ok(width.scroll <= width.viewport, `Mobile layout overflows: ${JSON.stringify(width)}`);
  } finally { await browser.close(); }
});
