import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { chromium } from "playwright-core";

const base = process.env.PROOFFLOW_TEST_URL ?? "http://localhost:3001";
const output = join(dirname(dirname(fileURLToPath(import.meta.url))), "data");

async function launchBrowser() {
  const executablePath = process.env.PROOFFLOW_BROWSER_PATH;
  if (executablePath) return chromium.launch({ executablePath, headless: true });

  const errors = [];
  for (const options of [{ channel: "msedge" }, { channel: "chrome" }, {}]) {
    try {
      return await chromium.launch({ ...options, headless: true });
    } catch (error) {
      errors.push(`${options.channel ?? "chromium"}: ${error.message}`);
    }
  }
  throw new Error(`No supported browser found. Install Edge, Chrome, or Playwright Chromium, or set PROOFFLOW_BROWSER_PATH.\n${errors.join("\n")}`);
}

test("editor saves manual, paste and AI events and restores them after reload", async () => {
  const browser = await launchBrowser();
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

    await page.getByRole("tab", { name: "记录" }).click();
    await page.getByText("检索到 3 条").waitFor();
    assert.deepEqual(await page.locator(".record-stats strong").allTextContents(), ["3", "1"]);
    await page.getByRole("combobox", { name: "筛选记录类型" }).selectOption("PASTE");
    assert.equal(await page.locator(".record-entry").count(), 1);
    await page.locator(".record-entry summary").click();
    assert.equal(await page.getByText("插入字符").count(), 1);
    assert.equal(await page.getByText("字符变化").count(), 1);
    await page.getByRole("searchbox", { name: "检索记录" }).fill("no matching event");
    assert.equal(await page.getByText("检索到 0 条").count(), 1);
    await page.getByRole("searchbox", { name: "检索记录" }).fill("");
    await page.getByRole("button", { name: "验证记录" }).click();
    await page.getByText("内部链一致，已检查 3 条。未签名、未校验外部锚点。").waitFor();

    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "导出本地 JSON 草稿" }).click();
    const download = await downloadPromise;
    const json = JSON.parse(readFileSync(await download.path(), "utf8"));
    assert.equal(json.editorSchemaVersion, 1);
    assert.equal(json.serverVersion, 3);
    assert.equal(json.events.length, 3);
    assert.equal(json.events[1].insertedText, "pasted ");
    assert.equal(json.events[2].aiResponseId, json.aiResponses[0].id);

    mkdirSync(output, { recursive: true });
    await page.screenshot({ path: join(output, "proofflow-desktop.png"), fullPage: true });
    await page.reload();
    await page.getByText("正文服务端版本 3").waitFor();
    await page.getByText("正文已保存 · 未验证").waitFor();
    assert.equal(await page.locator(".timeline-item").count(), 3);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("tab", { name: "记录" }).click();
    await page.getByText("检索到 3 条").waitFor();
    await page.screenshot({ path: join(output, "proofflow-mobile.png"), fullPage: true });
    const width = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, viewport: innerWidth }));
    assert.ok(width.scroll <= width.viewport, `Mobile layout overflows: ${JSON.stringify(width)}`);

    await editor.evaluate((input) => {
      input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      input.value += "中文";
      input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    });
    await page.getByText("正文服务端版本 4").waitFor();
    assert.match(await editor.inputValue(), /中文$/);
  } finally { await browser.close(); }
});

test("manual typing records punctuation and saves unfinished text after a pause", async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.goto(base);
    await page.getByText("正文服务端版本 0").waitFor();
    const editor = page.getByRole("textbox", { name: "文档正文" });
    await editor.pressSequentially("Hello", { delay: 20 });
    await page.waitForTimeout(250);
    assert.equal(await page.locator(".timeline-item").count(), 0);
    assert.equal(await page.getByText("正文服务端版本 0").count(), 1);

    await editor.press(".");
    await page.getByText("正文服务端版本 1").waitFor();
    assert.equal(await page.locator(".timeline-item").count(), 1);

    await editor.pressSequentially(" More", { delay: 20 });
    await page.getByText("正文服务端版本 2").waitFor();
    assert.equal(await page.locator(".timeline-item").count(), 2);
    assert.equal(await editor.inputValue(), "Hello. More");

    await editor.pressSequentially(" text", { delay: 20 });
    await editor.evaluate((input) => {
      const clipboardData = new DataTransfer();
      clipboardData.setData("text/plain", " pasted");
      input.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }));
    });
    await page.getByText("正文服务端版本 4").waitFor();
    const documentId = await page.evaluate(() => JSON.parse(localStorage.getItem("proofflow-local-draft-v1")).documentId);
    const history = await (await page.request.get(`${base}/api/documents/${documentId}/events`)).json();
    assert.deepEqual(history.events.map((event) => event.type), ["MANUAL_EDIT", "MANUAL_EDIT", "MANUAL_EDIT", "PASTE"]);

    await editor.pressSequentially(" unsaved", { delay: 20 });
    await page.reload();
    await page.getByText("正文服务端版本 5").waitFor();
    assert.equal(await page.getByRole("textbox", { name: "文档正文" }).inputValue(), "Hello. More text pasted unsaved");
  } finally { await browser.close(); }
});

test("manual changes in a long document show bounded highlighted context in both views", async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(base);
    await page.getByText("正文服务端版本 0").waitFor();
    const editor = page.getByRole("textbox", { name: "文档正文" });
    const before = `${"Intro sentence. ".repeat(20)}Target old phrase. Follow-up sentence. ${"Tail sentence. ".repeat(20)}`;
    await editor.fill(before);
    await editor.blur();
    await page.getByText("正文服务端版本 1").waitFor();
    await editor.fill(before.replace("old", "new"));
    await editor.blur();
    await page.getByText("正文服务端版本 2").waitFor();

    const timeline = page.locator(".timeline-item").first();
    assert.equal(await timeline.locator("mark.change-added").textContent(), "new");
    assert.equal(await timeline.locator("del.change-removed").textContent(), "old");
    assert.deepEqual(await timeline.locator("del.change-removed").evaluate((element) => {
      const style = getComputedStyle(element);
      return { color: style.color, background: style.backgroundColor, decoration: style.textDecorationLine };
    }), { color: "rgb(180, 35, 24)", background: "rgb(255, 229, 227)", decoration: "none" });
    assert.ok((await timeline.locator(".change-hunk").textContent()).length < 150);
    assert.match(await timeline.locator(".change-hunk").textContent(), /^…/);

    await page.getByRole("tab", { name: "记录" }).click();
    await page.getByText("检索到 2 条").waitFor();
    const record = page.locator(".record-entry").first();
    assert.equal(await record.locator("mark.change-added").textContent(), "new");
    assert.equal(await record.locator("del.change-removed").textContent(), "old");
    assert.equal(await record.locator("del.change-removed").evaluate((element) => getComputedStyle(element).textDecorationLine), "none");
    assert.ok((await record.locator(".change-hunk").textContent()).length < 150);
  } finally { await browser.close(); }
});

test("a long-document paste shows bounded context and the full pasted selection", async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(base);
    await page.getByText("正文服务端版本 0").waitFor();
    const editor = page.getByRole("textbox", { name: "文档正文" });
    const before = `${"Intro sentence. ".repeat(20)}Target old phrase. ${"Tail sentence. ".repeat(20)}`;
    await editor.fill(before);
    await editor.blur();
    await page.getByText("正文服务端版本 1").waitFor();
    await editor.evaluate((input) => {
      const start = input.value.indexOf("old");
      input.focus();
      input.setSelectionRange(start, start + 3);
      const clipboardData = new DataTransfer();
      clipboardData.setData("text/plain", "new pasted phrase");
      input.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }));
    });
    await page.getByText("正文服务端版本 2").waitFor();

    const timeline = page.locator(".timeline-item").first();
    assert.equal(await timeline.locator(".change-caption").textContent(), "粘贴部分");
    assert.equal(await timeline.locator("mark.change-added").textContent(), "new pasted phrase");
    assert.equal(await timeline.locator("del.change-removed").textContent(), "old");
    assert.deepEqual(await timeline.locator("del.change-removed").evaluate((element) => {
      const style = getComputedStyle(element);
      return { color: style.color, background: style.backgroundColor, decoration: style.textDecorationLine };
    }), { color: "rgb(180, 35, 24)", background: "rgb(255, 229, 227)", decoration: "none" });
    assert.ok((await timeline.locator(".change-hunk").textContent()).length < 160);

    await page.getByRole("tab", { name: "记录" }).click();
    await page.getByText("检索到 2 条").waitFor();
    const record = page.locator(".record-entry").first();
    assert.equal(await record.locator(".change-caption").textContent(), "粘贴部分");
    assert.equal(await record.locator("mark.change-added").textContent(), "new pasted phrase");
    assert.equal(await record.locator("del.change-removed").textContent(), "old");
    assert.equal(await record.locator("del.change-removed").evaluate((element) => getComputedStyle(element).textDecorationLine), "none");
    assert.ok((await record.locator(".change-hunk").textContent()).length < 160);
  } finally { await browser.close(); }
});

test("each inserted punctuation mark records immediately, including Chinese punctuation", async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.goto(base);
    await page.getByText("正文服务端版本 0").waitFor();
    const editor = page.getByRole("textbox", { name: "文档正文" });
    await editor.pressSequentially("你好", { delay: 20 });
    assert.equal(await page.locator(".timeline-item").count(), 0);

    await editor.pressSequentially("，");
    await page.getByText("正文服务端版本 1").waitFor({ timeout: 1500 });
    await editor.pressSequentially("世界,");
    await page.getByText("正文服务端版本 2").waitFor({ timeout: 1500 });
    await editor.pressSequentially("!");
    await page.getByText("正文服务端版本 3").waitFor({ timeout: 1500 });
    assert.equal(await page.locator(".timeline-item").count(), 3);
    const times = await page.locator(".timeline-item time").allTextContents();
    assert.ok(times.every((time) => /\.\d{3}$/.test(time)), `Timeline should show milliseconds: ${times}`);

    await editor.press("Backspace");
    await page.waitForTimeout(250);
    assert.equal(await page.locator(".timeline-item").count(), 3);
    await editor.evaluate((input) => {
      input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      input.value += "。";
      input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    });
    await page.getByText("正文服务端版本 4").waitFor({ timeout: 1500 });
  } finally { await browser.close(); }
});

test("a document missing from this server shows a useful error without deleting the local draft", async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    const documentId = randomUUID();
    const operationId = randomUUID();
    await page.goto(base);
    await page.evaluate(({ documentId, operationId }) => {
      const document = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "local work" }] }] };
      localStorage.setItem("proofflow-local-draft-v1", JSON.stringify({
        title: "Local draft", document, documentId, serverVersion: 0, savedEventCount: 0,
        events: [{ operationId, type: "MANUAL_EDIT", timestamp: new Date().toISOString(), snippet: "local work", contentAfter: document }],
      }));
    }, { documentId, operationId });
    await page.reload();
    await page.getByRole("tab", { name: "记录" }).click();
    await page.getByRole("alert").getByText(/当前服务未找到这份文档/).waitFor();
    await page.getByText("有 1 条待保存操作，保存完成后可验证。").waitFor();
    await page.reload();
    await page.waitForFunction(() => document.querySelector('textarea[aria-label="文档正文"]')?.value === "local work");
    assert.equal(await page.getByRole("textbox", { name: "文档正文" }).inputValue(), "local work");
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("proofflow-local-draft-v1")).documentId), documentId);
  } finally { await browser.close(); }
});
