/**
 * assistant-markdown-box.ts — Pi Extension
 *
 * Renders natural-language assistant fenced Markdown blocks such as
 * ```text, ```plain, and ```plaintext as warm amber TUI background panels
 * while leaving real code fences to Pi's default Markdown renderer.
 *
 * Pi currently exposes custom renderers for custom messages, not a first-class
 * assistant-message renderer hook. This extension therefore patches
 * AssistantMessageComponent.updateContent at load time and keeps the underlying
 * assistant message content unchanged for provider context/session storage.
 */

import type { AssistantMessage, ThinkingContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AssistantMessageComponent } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

const BOXED_FENCE_INFOS = new Set(["text", "txt", "plain", "plaintext"]);
const PATCH_FLAG = "__harnessAssistantMarkdownBoxPatched";

type FenceSegment =
  | { kind: "markdown"; text: string }
  | { kind: "boxed"; label: string; text: string };

type PatchableAssistantMessageComponent = AssistantMessageComponent & {
  __harnessAssistantMarkdownBoxPatched?: boolean;
  contentContainer?: Container;
  hideThinkingBlock?: boolean;
  hiddenThinkingLabel?: string;
  markdownTheme?: unknown;
  lastMessage?: AssistantMessage;
  hasToolCalls?: boolean;
};

export default function (_pi: ExtensionAPI) {
  patchAssistantMessageComponent();
}

export function patchAssistantMessageComponent() {
  const proto = AssistantMessageComponent.prototype as PatchableAssistantMessageComponent;
  if (proto[PATCH_FLAG]) return;

  const originalUpdateContent = proto.updateContent;

  proto.updateContent = function patchedUpdateContent(this: PatchableAssistantMessageComponent, message: AssistantMessage) {
    if (!this.contentContainer) {
      return originalUpdateContent.call(this, message);
    }

    this.lastMessage = message;
    this.contentContainer.clear();

    const hasVisibleContent = message.content.some(
      (content) => (content.type === "text" && content.text.trim()) || (content.type === "thinking" && content.thinking.trim()),
    );
    if (hasVisibleContent) {
      this.contentContainer.addChild(new Spacer(1));
    }

    for (let index = 0; index < message.content.length; index++) {
      const content = message.content[index];
      if (content.type === "text" && content.text.trim()) {
        addAssistantText(this.contentContainer, content.text.trim(), this.markdownTheme);
        continue;
      }

      if (content.type === "thinking" && content.thinking.trim()) {
        addThinkingText(
          this.contentContainer,
          content,
          Boolean(this.hideThinkingBlock),
          this.hiddenThinkingLabel ?? "Thinking...",
          this.markdownTheme,
        );
        if (hasVisibleContentAfter(message, index)) {
          this.contentContainer.addChild(new Spacer(1));
        }
      }
    }

    const hasToolCalls = message.content.some((content) => content.type === "toolCall");
    this.hasToolCalls = hasToolCalls;
    if (hasToolCalls) return;

    if (message.stopReason === "aborted") {
      const abortMessage = message.errorMessage && message.errorMessage !== "Request was aborted"
        ? message.errorMessage
        : "Operation aborted";
      this.contentContainer.addChild(new Spacer(1));
      this.contentContainer.addChild(new Text(abortMessage, 1, 0));
    } else if (message.stopReason === "error") {
      this.contentContainer.addChild(new Spacer(1));
      this.contentContainer.addChild(new Text(`Error: ${message.errorMessage || "Unknown error"}`, 1, 0));
    }
  };

  proto[PATCH_FLAG] = true;
}

function addAssistantText(container: Container, text: string, markdownTheme: unknown) {
  for (const segment of parseFenceSegments(text)) {
    if (!segment.text.trim()) continue;
    if (segment.kind === "boxed") {
      container.addChild(new BackgroundFenceBoxComponent(segment.text));
    } else {
      container.addChild(new Markdown(segment.text.trim(), 1, 0, markdownTheme as never));
    }
  }
}

function addThinkingText(container: Container, content: ThinkingContent, hidden: boolean, hiddenLabel: string, markdownTheme: unknown) {
  if (hidden) {
    container.addChild(new Text(hiddenLabel, 1, 0));
    return;
  }
  container.addChild(new Markdown(content.thinking.trim(), 1, 0, markdownTheme as never, { italic: true }));
}

function hasVisibleContentAfter(message: AssistantMessage, index: number): boolean {
  return message.content
    .slice(index + 1)
    .some((content) => (content.type === "text" && content.text.trim()) || (content.type === "thinking" && content.thinking.trim()));
}

export function parseFenceSegments(markdown: string): FenceSegment[] {
  const lines = markdown.split(/\r?\n/);
  const segments: FenceSegment[] = [];
  let buffer: string[] = [];

  const flushMarkdown = () => {
    if (buffer.length === 0) return;
    segments.push({ kind: "markdown", text: buffer.join("\n") });
    buffer = [];
  };

  for (let index = 0; index < lines.length; index++) {
    const open = lines[index]?.match(/^\s*(```|~~~)\s*([^`]*)\s*$/);
    if (!open) {
      buffer.push(lines[index] ?? "");
      continue;
    }

    const fence = open[1];
    const info = normalizeFenceInfo(open[2]);
    const body: string[] = [];
    let closeIndex = -1;

    for (let cursor = index + 1; cursor < lines.length; cursor++) {
      if ((lines[cursor] ?? "").trim() === fence) {
        closeIndex = cursor;
        break;
      }
      body.push(lines[cursor] ?? "");
    }

    if (closeIndex < 0) {
      buffer.push(lines[index] ?? "");
      continue;
    }

    if (!BOXED_FENCE_INFOS.has(info)) {
      buffer.push(lines[index] ?? "", ...body, lines[closeIndex] ?? "");
      index = closeIndex;
      continue;
    }

    flushMarkdown();
    segments.push({ kind: "boxed", label: info || "text", text: body.join("\n") });
    index = closeIndex;
  }

  flushMarkdown();
  return segments;
}

function normalizeFenceInfo(info: string | undefined): string {
  return String(info ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? "";
}

class BackgroundFenceBoxComponent {
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(private readonly text: string) {}

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    if (this.cachedLines && this.cachedWidth === safeWidth) return this.cachedLines;

    const paddingX = 2;
    const innerWidth = Math.max(1, safeWidth - paddingX * 2);
    const bg = (value: string) => `\x1b[48;2;92;58;12m${value}\x1b[0m`;
    const blank = bg(" ".repeat(safeWidth));

    const bodyLines = this.text.split("\n");
    const rendered: string[] = [blank];
    for (const bodyLine of bodyLines.length > 0 ? bodyLines : [""]) {
      const chunks = wrapTextWithAnsi(bodyLine, innerWidth);
      for (const chunk of chunks.length > 0 ? chunks : [""]) {
        const clipped = truncateToWidth(chunk, innerWidth, "");
        const rightPad = " ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)));
        rendered.push(bg(`${" ".repeat(paddingX)}${clipped}${rightPad}${" ".repeat(paddingX)}`));
      }
    }
    rendered.push(blank);

    this.cachedWidth = safeWidth;
    this.cachedLines = rendered;
    return rendered;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}
