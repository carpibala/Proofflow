export type TextNode = {
  type: "text";
  text: string;
  marks?: { type: "bold" }[];
  sourceOperationId?: string;
};

export type EditorDocument = {
  type: "doc";
  content: { type: "paragraph"; content: TextNode[] }[];
};

type Unit = { char: string; bold: boolean; sourceOperationId?: string };

export const emptyDocument = (): EditorDocument => ({
  type: "doc",
  content: [{ type: "paragraph", content: [] }],
});

export function plainText(document: EditorDocument): string {
  return document.content.map((paragraph) => paragraph.content.map((node) => node.text).join("")).join("\n");
}

function toUnits(document: EditorDocument): Unit[] {
  const units: Unit[] = [];
  document.content.forEach((paragraph, index) => {
    if (index > 0) units.push({ char: "\n", bold: false });
    paragraph.content.forEach((node) => {
      for (let offset = 0; offset < node.text.length; offset++) {
        units.push({
          char: node.text[offset],
          bold: node.marks?.some((mark) => mark.type === "bold") ?? false,
          sourceOperationId: node.sourceOperationId,
        });
      }
    });
  });
  return units;
}

function fromUnits(units: Unit[]): EditorDocument {
  const paragraphs: EditorDocument["content"] = [{ type: "paragraph", content: [] }];
  for (const unit of units) {
    if (unit.char === "\n") {
      paragraphs.push({ type: "paragraph", content: [] });
      continue;
    }
    const content = paragraphs[paragraphs.length - 1].content;
    const last = content[content.length - 1];
    const lastBold = last?.marks?.some((mark) => mark.type === "bold") ?? false;
    if (last && lastBold === unit.bold && last.sourceOperationId === unit.sourceOperationId) {
      last.text += unit.char;
    } else {
      content.push({
        type: "text",
        text: unit.char,
        ...(unit.bold ? { marks: [{ type: "bold" as const }] } : {}),
        ...(unit.sourceOperationId ? { sourceOperationId: unit.sourceOperationId } : {}),
      });
    }
  }
  return { type: "doc", content: paragraphs };
}

export function positionFromOffset(document: EditorDocument, offset: number): { path: number[]; offset: number } {
  const before = plainText(document).slice(0, offset);
  const path = before.split("\n").length - 1;
  return { path: [path], offset: before.length - before.lastIndexOf("\n") - 1 };
}

export function replaceRange(
  document: EditorDocument,
  start: number,
  end: number,
  insertedText: string,
  options: { bold?: boolean; sourceOperationId?: string } = {},
): EditorDocument {
  const units = toUnits(document);
  const insert: Unit[] = [];
  for (let offset = 0; offset < insertedText.length; offset++) {
    insert.push({
      char: insertedText[offset],
      bold: options.bold ?? false,
      sourceOperationId: options.sourceOperationId,
    });
  }
  units.splice(start, end - start, ...insert);
  return fromUnits(units);
}

export function reconcileText(document: EditorDocument, nextText: string): EditorDocument {
  const currentText = plainText(document);
  let start = 0;
  while (start < currentText.length && start < nextText.length && currentText[start] === nextText[start]) start++;
  let end = 0;
  while (
    end < currentText.length - start &&
    end < nextText.length - start &&
    currentText[currentText.length - end - 1] === nextText[nextText.length - end - 1]
  ) end++;
  return replaceRange(document, start, currentText.length - end, nextText.slice(start, nextText.length - end));
}

export function toggleBold(document: EditorDocument, start: number, end: number): EditorDocument {
  const units = toUnits(document);
  const selected = units.slice(start, end).filter((unit) => unit.char !== "\n");
  if (!selected.length) return document;
  const bold = !selected.every((unit) => unit.bold);
  for (let offset = start; offset < end; offset++) {
    if (units[offset]?.char !== "\n") units[offset].bold = bold;
  }
  return fromUnits(units);
}
