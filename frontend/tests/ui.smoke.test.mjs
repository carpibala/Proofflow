import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, mkdirSync, existsSync } from "node:fs";
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

async function openAuthenticated(page) {
  const result = await page.request.post(`${base}/api/auth/register`, { data: {
    username: `ui_${randomUUID().replaceAll("-", "").slice(0,20)}`, password: "UI-password-123!",
  } });
  assert.equal(result.status(), 201);
  await page.goto(base);
  await page.getByRole("textbox", { name: "文档正文" }).waitFor();
  await page.getByText("正文服务端版本 0").waitFor();
}

test("editor saves manual and paste events and restores them after reload", async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
    await openAuthenticated(page);
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
    assert.equal(await page.getByRole("button", { name: "插入到文档" }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "加粗选中的文字" }).count(), 0);

    await page.getByRole("tab", { name: "记录" }).click();
    await page.getByText("检索到 2 条").waitFor();
    assert.equal(await page.getByRole("option", { name: "AI 插入" }).count(), 0);
    assert.deepEqual(await page.locator(".record-stats strong").allTextContents(), ["2", "1"]);
    await page.getByRole("combobox", { name: "筛选记录类型" }).selectOption("PASTE");
    assert.equal(await page.locator(".record-entry").count(), 1);
    await page.locator(".record-entry summary").click();
    assert.equal(await page.getByText("插入字符").count(), 1);
    assert.equal(await page.getByText("字符变化").count(), 1);
    await page.getByRole("searchbox", { name: "检索记录" }).fill("no matching event");
    assert.equal(await page.getByText("检索到 0 条").count(), 1);
    await page.getByRole("searchbox", { name: "检索记录" }).fill("");
    await page.getByRole("button", { name: "验证记录" }).click();
    await page.getByText("内部链一致，已检查 2 条。未签名、未校验外部锚点。").waitFor();

    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: /导出本地 JSON 草稿/ }).click();
    const download = await downloadPromise;
    const json = JSON.parse(readFileSync(await download.path(), "utf8"));
    assert.equal(json.editorSchemaVersion, 1);
    assert.equal(json.serverVersion, 2);
    assert.equal(json.events.length, 2);
    assert.equal(json.events[1].insertedText, "pasted ");
    assert.equal("aiResponses" in json, false);

    mkdirSync(output, { recursive: true });
    await page.screenshot({ path: join(output, "proofflow-desktop.png"), fullPage: true });
    await page.reload();
    await page.getByText("正文服务端版本 2").waitFor();
    await page.getByText("正文已保存 · 未验证").waitFor();
    assert.equal(await page.locator(".timeline-item").count(), 2);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("tab", { name: "记录" }).click();
    await page.getByText("检索到 2 条").waitFor();
    await page.screenshot({ path: join(output, "proofflow-mobile.png"), fullPage: true });
    const width = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, viewport: innerWidth }));
    assert.ok(width.scroll <= width.viewport, `Mobile layout overflows: ${JSON.stringify(width)}`);

    await editor.evaluate((input) => {
      input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      input.value += "中文";
      input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    });
    await page.getByText("正文服务端版本 3").waitFor();
    assert.match(await editor.inputValue(), /中文$/);
  } finally { await browser.close(); }
});

test("Chinese and English UI switching persists without changing document content", async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await openAuthenticated(page);
    await page.getByText("正文服务端版本 0").waitFor();
    assert.equal(await page.locator(".assistant-panel, .editor-toolbar").count(), 0);
    assert.equal(await page.getByRole("button", { name: "查看证据报告" }).isDisabled(), false);
    await page.getByRole("group", { name: "界面语言" }).getByRole("button", { name: "EN" }).click();
    assert.equal(await page.evaluate(() => document.documentElement.lang), "en");
    assert.equal(await page.getByRole("textbox", { name: "Document title" }).getAttribute("placeholder"), "Untitled document");
    const editor = page.getByRole("textbox", { name: "Document body" });
    await editor.fill("Hello.");
    await page.getByText("Server version 1").waitFor();
    assert.equal(await page.locator(".timeline-item").first().locator(".change-caption").textContent(), "Changed text");
    await page.getByRole("tab", { name: "Records" }).click();
    await page.getByText("1 records found").waitFor();
    assert.equal(await page.getByText("Changes").count(), 1);
    await page.getByRole("combobox", { name: "Filter record type" }).selectOption("MANUAL_EDIT");
    await page.getByRole("button", { name: "Verify records" }).click();
    await page.getByText(/Internal chain valid/).waitFor();

    await page.reload();
    await page.getByRole("group", { name: "Interface language" }).waitFor();
    await page.getByText("Server version 1").waitFor();
    assert.equal(await page.getByRole("textbox", { name: "Document body" }).inputValue(), "Hello.");
    assert.equal(await page.evaluate(() => document.documentElement.lang), "en");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("tab", { name: "Records" }).click();
    await page.getByText("1 records found").waitFor();
    mkdirSync(output, { recursive: true });
    await page.screenshot({ path: join(output, "proofflow-english-mobile.png"), fullPage: true });
    const width = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, viewport: innerWidth }));
    assert.ok(width.scroll <= width.viewport, `English mobile layout overflows: ${JSON.stringify(width)}`);

    for (const viewportWidth of [768, 1024]) {
      await page.setViewportSize({ width: viewportWidth, height: 800 });
      const dimensions = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, viewport: innerWidth }));
      assert.ok(dimensions.scroll <= dimensions.viewport, `Layout overflows at ${viewportWidth}px: ${JSON.stringify(dimensions)}`);
      if (viewportWidth === 1024) await page.screenshot({ path: join(output, "proofflow-english-tablet.png"), fullPage: true });
    }

    await page.getByRole("group", { name: "Interface language" }).getByRole("button", { name: "中文" }).click();
    await page.getByRole("textbox", { name: "文档正文" }).waitFor();
    assert.equal(await page.getByRole("textbox", { name: "文档标题" }).getAttribute("placeholder"), "无标题文档");
    assert.equal(await page.getByRole("textbox", { name: "文档正文" }).inputValue(), "Hello.");
    assert.equal(await page.evaluate(() => document.documentElement.lang), "zh-CN");
  } finally { await browser.close(); }
});

test("manual typing records punctuation and saves unfinished text after a pause", async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await openAuthenticated(page);
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
    const documentId = await page.evaluate(() => JSON.parse(localStorage.getItem(Object.keys(localStorage).find(key => key.startsWith("proofflow-local-draft-v2:")))).documentId);
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
    await openAuthenticated(page);
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
    await openAuthenticated(page);
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
    await openAuthenticated(page);
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
    await openAuthenticated(page);
    await page.evaluate(({ documentId, operationId }) => {
      const document = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "local work" }] }] };
      localStorage.setItem(Object.keys(localStorage).find(key => key.startsWith("proofflow-local-draft-v2:")), JSON.stringify({
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
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem(Object.keys(localStorage).find(key => key.startsWith("proofflow-local-draft-v2:")))).documentId), documentId);
  } finally { await browser.close(); }
});

test("report counts saved additions, deletions and pastes, then warns on a broken link", async (context) => {
  const browser = await launchBrowser();
  let connection;
  let tamperedId;
  let originalHash;
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await openAuthenticated(page);
    await page.getByText("正文服务端版本 0").waitFor();
    const editor = page.getByRole("textbox", { name: "文档正文" });
    await editor.fill("Hello world.");
    await editor.blur();
    await page.getByText("正文服务端版本 1").waitFor();
    await editor.evaluate((input) => {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
      const clipboardData = new DataTransfer();
      clipboardData.setData("text/plain", " pasted");
      input.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }));
    });
    await page.getByText("正文服务端版本 2").waitFor();
    await editor.fill("Hello . pasted");
    await editor.blur();
    await page.getByText("正文服务端版本 3").waitFor();

    await page.getByRole("button", { name: "查看证据报告" }).click();
    await page.getByRole("heading", { name: "创作证据报告" }).waitFor();
    await page.getByText("内部哈希链一致").waitFor();
    assert.deepEqual(await page.locator(".report-metric strong").allTextContents(), ["2", "1", "1"]);
    assert.equal(await page.locator(".report-activity").count(), 3);
    mkdirSync(output, { recursive: true });
    await page.screenshot({ path: join(output, "report-valid-desktop.png"), fullPage: true });

    const id = new URL(page.url()).pathname.split("/").at(-1);
    const path = join(process.env.PROOFFLOW_DATA_DIR ?? output, "proofflow.sqlite");
    if (!existsSync(path)) return context.skip("The target server does not use this local test database");
    connection = new DatabaseSync(path);
    const row = connection.prepare("SELECT id, previous_hash FROM events WHERE document_id = ? AND version = 2").get(id);
    if (!row) return context.skip("The target server uses another database");
    tamperedId = row.id;
    originalHash = row.previous_hash;
    connection.prepare("UPDATE events SET previous_hash = ? WHERE id = ?").run("f".repeat(64), tamperedId);
    await page.getByRole("button", { name: "重新校验" }).click();
    await page.getByRole("alert").getByText("警告：哈希链校验失败").waitFor();
    await page.getByText(/BROKEN_EVENT_CHAIN/).waitFor();
    assert.equal(await page.locator(".report-banner-error").count(), 1);
    assert.equal(await page.getByRole("button", { name: "冻结最终版本" }).isDisabled(), true);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: join(output, "report-broken-mobile.png"), fullPage: true });
    const dimensions = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, viewport: innerWidth }));
    assert.ok(dimensions.scroll <= dimensions.viewport, `Report overflows on mobile: ${JSON.stringify(dimensions)}`);
    await page.getByRole("group", { name: "界面语言" }).getByRole("button", { name: "EN" }).click();
    await page.getByText("Warning: hash chain verification failed").waitFor();
  } finally {
    if (connection) {
      if (tamperedId && originalHash) connection.prepare("UPDATE events SET previous_hash = ? WHERE id = ?").run(originalHash, tamperedId);
      connection.close();
    }
    await browser.close();
  }
});

test("report freezes the latest edit, downloads evidence, and returns to a read-only editor", async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, acceptDownloads: true });
    await openAuthenticated(page);
    await page.getByText("正文服务端版本 0").waitFor();
    await page.getByRole("textbox", { name: "文档标题" }).fill("最终测试文档");
    await page.getByRole("textbox", { name: "文档正文" }).fill("Final edit without a pause");
    await page.getByRole("button", { name: "查看证据报告" }).click();
    await page.getByRole("heading", { name: "创作证据报告" }).waitFor();
    await page.getByText("内部哈希链一致").waitFor();
    assert.deepEqual(await page.locator(".report-metric strong").allTextContents(), ["1", "0", "0"]);
    await page.getByRole("button", { name: "冻结最终版本" }).click();
    await page.getByRole("dialog", { name: "确认冻结文档？" }).getByRole("button", { name: "确认冻结" }).click();
    await page.getByRole("button", { name: "下载证据包" }).waitFor();
    await page.getByText(/已冻结 ·/).waitFor();
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "下载证据包" }).click();
    const downloaded = await downloadPromise;
    const bundle = JSON.parse(readFileSync(await downloaded.path(), "utf8"));
    assert.equal(bundle.kind, "proof-flow-evidence");
    assert.equal(bundle.manifest.title, "最终测试文档");
    assert.equal(bundle.manifest.finalVersion, 1);
    assert.equal(bundle.events.length, 1);
    assert.equal(bundle.contentJson.content[0].content[0].text, "Final edit without a pause");
    mkdirSync(output, { recursive: true });
    await page.screenshot({ path: join(output, "report-frozen-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    const dimensions = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, viewport: innerWidth }));
    assert.ok(dimensions.scroll <= dimensions.viewport, `Frozen report overflows on mobile: ${JSON.stringify(dimensions)}`);
    await page.screenshot({ path: join(output, "report-frozen-mobile.png"), fullPage: true });
    await page.getByRole("link", { name: "返回编辑器" }).click();
    await page.getByText("最终版本已冻结").waitFor();
    assert.equal(await page.getByRole("textbox", { name: "文档正文" }).isDisabled(), true);
    assert.equal(await page.getByRole("textbox", { name: "文档标题" }).isDisabled(), true);
  } finally { await browser.close(); }
});

test("register and login forms restore backend content in a fresh browser context", async () => {
  const browser = await launchBrowser();
  try {
    const username = `form_${randomUUID().replaceAll('-', '').slice(0,20)}`;
    const password = 'Form-password-123!';
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(base);
    await page.getByRole('button', { name: '注册', exact: true }).click();
    await page.getByLabel('用户名', { exact:true }).fill(username);
    await page.getByLabel('密码', { exact:true }).fill(password);
    await page.getByLabel('确认密码', { exact:true }).fill(password);
    await page.getByRole('button', { name:'注册并登录', exact:true }).click();
    await page.getByText('正文服务端版本 0').waitFor();
    await page.getByRole('textbox', { name:'文档正文' }).fill('Backend account restore.');
    await page.getByText('正文服务端版本 1').waitFor();
    await page.getByRole('button', { name:'退出登录', exact:true }).click();
    await page.getByRole('heading', { name:'欢迎回来' }).waitFor();
    const fresh = await browser.newContext();
    const second = await fresh.newPage();
    await second.goto(base);
    await second.getByLabel('用户名', { exact:true }).fill(username);
    await second.getByLabel('密码', { exact:true }).fill(password);
    await second.getByRole('button', { name:'登录', exact:true }).last().click();
    await second.getByText('正文服务端版本 1').waitFor();
    assert.equal(await second.getByRole('textbox', { name:'文档正文' }).inputValue(), 'Backend account restore.');
    await fresh.close(); await context.close();
  } finally { await browser.close(); }
});
