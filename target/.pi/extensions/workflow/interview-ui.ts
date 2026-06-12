import { Box, Text, truncateToWidth, matchesKey, Key } from "@earendil-works/pi-tui";

export type InterviewQuestion = {
  id: string;
  title: string;
  prompt: string;
  helpText: string;
  required: boolean;
  choices: Array<{ id: string; label: string }>;
  allowFreeText: boolean;
  allowSkip: boolean;
};

export type InterviewAnswer = {
  questionId: string;
  selectedChoiceIds: string[];
  freeText: string;
  skipped: boolean;
};

export type InterviewWizardResult = {
  completed: boolean;
  summaryMarkdown: string;
  answers: InterviewAnswer[];
};

type WizardDone = (value: InterviewWizardResult | null) => void;

type WizardContext = {
  hasUI: boolean;
  ui: {
    custom: <T>(factory: (tui: any, theme: any, keybindings: any, done: (value: T) => void) => any, options?: Record<string, unknown>) => Promise<T>;
    setWidget?: (key: string, value: unknown, options?: Record<string, unknown>) => void;
    notify?: (message: string, level?: string) => void;
  };
};

export async function launchInterviewWizard(ctx: WizardContext, workflowTitle: string, questions: InterviewQuestion[]): Promise<InterviewWizardResult | null> {
  if (!ctx.hasUI || typeof ctx.ui.custom !== "function") return null;

  const answers = questions.map((question) => ({
    questionId: question.id,
    selectedChoiceIds: [] as string[],
    freeText: "",
    skipped: false,
  }));
  let currentIndex = 0;

  if (typeof ctx.ui.setWidget === "function") {
    ctx.ui.setWidget("interview-progress", (_tui: unknown, theme: any) => renderProgressWidget(theme, currentIndex, answers, questions));
  }

  try {
    return await ctx.ui.custom<InterviewWizardResult | null>((tui, theme, _keybindings, done) => {
      return new InterviewWizard(tui, theme, workflowTitle, questions, answers, (nextIndex) => {
        // Only update the external progress widget. Do NOT call tui.requestRender here;
        // InterviewWizard.requestRender() calls it after updating all internal state.
        currentIndex = nextIndex;
      }, done);
    });
  } finally {
    try { ctx.ui.setWidget?.("interview-progress", undefined); } catch { /* non-fatal */ }
  }
}

function renderProgressWidget(theme: any, currentIndex: number, answers: InterviewAnswer[], questions: InterviewQuestion[]): Box {
  const lines = ["Interview Progress"];
  questions.forEach((question, index) => {
    const answer = answers[index];
    const done = answer.skipped || answer.selectedChoiceIds.length > 0 || answer.freeText.trim().length > 0;
    const marker = index === currentIndex ? ">" : done ? "✓" : "○";
    lines.push(`${marker} ${index + 1}. ${question.title}`);
  });
  const box = new Box(1, 0, theme ? (s: string) => theme.bg("customMessageBg", s) : undefined);
  box.addChild(new Text(lines.map((line, index) => index === 0 && theme ? theme.fg("accent", line) : line).join("\n"), 0, 0));
  return box;
}

class InterviewWizard {
  private index = 0;
  private choiceCursor = 0;
  private focus: "choices" | "text" = "choices";
  private error = "";
  private preview = false;
  private finalPreview = false;

  constructor(
    private readonly tui: any,
    private readonly theme: any,
    private readonly workflowTitle: string,
    private readonly questions: InterviewQuestion[],
    private readonly answers: InterviewAnswer[],
    private readonly onStateChange: (index: number) => void,
    private readonly done: WizardDone,
  ) {}

  invalidate(): void {}

  handleInput(data: string): void {
    if (matchesKey(data, Key.ctrl("c")) || matchesKey(data, Key.escape) && !this.preview) {
      this.done(null);
      return;
    }

    if (this.preview) {
      if (matchesKey(data, Key.enter) && this.finalPreview) {
        this.done({ completed: true, summaryMarkdown: buildAnswerSummary(this.answers, this.questions), answers: cloneAnswers(this.answers) });
        return;
      }
      if (matchesKey(data, Key.escape) || data.toLowerCase() === "v") {
        this.preview = false;
        this.finalPreview = false;
        this.requestRender();
      }
      return;
    }

    if (matchesKey(data, Key.tab)) {
      this.focus = this.focus === "choices" ? "text" : "choices";
      this.requestRender();
      return;
    }

    if (this.focus === "choices") {
      if (data.toLowerCase() === "v") {
        this.preview = true;
        this.requestRender();
        return;
      }
      if (data.toLowerCase() === "p") {
        this.movePrevious();
        return;
      }
      if (data.toLowerCase() === "n" || matchesKey(data, Key.enter)) {
        this.moveNext();
        return;
      }
      if (data.toLowerCase() === "s") {
        this.skipCurrent();
        return;
      }
      if (matchesKey(data, Key.space)) {
        this.toggleChoice();
        return;
      }
    }

    // Arrow key navigation works regardless of focus state
    if (matchesKey(data, Key.up)) {
      this.choiceCursor = Math.max(0, this.choiceCursor - 1);
      this.requestRender();
      return;
    }
    if (matchesKey(data, Key.down)) {
      const choices = this.currentQuestion().choices;
      this.choiceCursor = Math.min(Math.max(0, choices.length - 1), this.choiceCursor + 1);
      this.requestRender();
      return;
    }

    if (matchesKey(data, Key.enter)) {
      this.moveNext();
      return;
    }

    // Text editing only allowed when focus is on the text input field
    if (this.focus === "text") {
      if (matchesKey(data, Key.backspace) || data === "") {
        const answer = this.currentAnswer();
        answer.freeText = Array.from(answer.freeText).slice(0, -1).join("");
        answer.skipped = false;
        this.error = "";
        this.requestRender();
        return;
      }
      if (isPrintable(data)) {
        const answer = this.currentAnswer();
        answer.freeText += data;
        answer.skipped = false;
        this.error = "";
        this.requestRender();
      }
    }
  }

  render(width: number): string[] {
    return this.preview ? this.renderPreview(width) : this.renderQuestion(width);
  }

  private renderQuestion(width: number): string[] {
    const question = this.currentQuestion();
    const answer = this.currentAnswer();
    const lines = [
      this.color("accent", `Interview Wizard: ${this.workflowTitle}`),
      this.color("dim", `Question ${this.index + 1}/${this.questions.length}`),
      "",
      this.color("accent", question.title),
      question.prompt,
      this.color("dim", question.helpText),
      "",
      "선택지 (↑↓ 이동, Space 선택):",
    ];

    question.choices.forEach((choice, index) => {
      const cursor = index === this.choiceCursor ? ">" : " ";
      const checked = answer.selectedChoiceIds.includes(choice.id) ? "[x]" : "[ ]";
      lines.push(`${cursor} ${checked} ${choice.label}`);
    });

    lines.push("", `${this.focus === "text" ? ">" : " "} 자유입력 (Tab으로 선택지/입력 전환):`, answer.freeText.length > 0 ? `${answer.freeText}█` : this.color("dim", "내용을 입력하세요…"));
    if (this.error) lines.push("", this.color("error", this.error));
    lines.push("", this.color("dim", "choices focus: Enter/n 다음 • p 이전 • v 미리보기 • s 건너뛰기 • Space 선택"));
    lines.push(this.color("dim", "text focus: 일반 문자/공백 입력 • Backspace 삭제 • Enter 다음 • Tab 전환 • Esc 취소"));
    return lines.map((line) => truncateToWidth(line, width));
  }

  private renderPreview(width: number): string[] {
    const lines = [this.color("accent", "Interview Answer Preview"), "", ...buildAnswerSummary(this.answers, this.questions).split("\n")];
    lines.push("", this.color("dim", this.finalPreview ? "Enter 완료 • Esc 돌아가기" : "Esc/v 돌아가기"));
    return lines.map((line) => truncateToWidth(line, width));
  }

  private movePrevious(): void {
    this.index = Math.max(0, this.index - 1);
    this.choiceCursor = 0;
    this.error = "";
    this.requestRender(); // requestRender() calls onStateChange internally
  }

  private moveNext(): void {
    if (!this.isCurrentValid()) {
      this.error = "필수 질문입니다. 선택지를 고르거나 자유입력을 작성해주세요.";
      this.requestRender();
      return;
    }
    if (this.index === this.questions.length - 1) {
      this.preview = true;
      this.finalPreview = true;
      this.requestRender();
      return;
    }
    this.index += 1;
    this.choiceCursor = 0;
    this.error = "";
    this.requestRender(); // requestRender() calls onStateChange internally
  }

  private skipCurrent(): void {
    const question = this.currentQuestion();
    if (!question.allowSkip) {
      this.error = "이 질문은 필수라서 건너뛸 수 없습니다.";
      this.requestRender();
      return;
    }
    const answer = this.currentAnswer();
    answer.skipped = true;
    answer.selectedChoiceIds = [];
    answer.freeText = "";
    this.focus = "choices";
    this.moveNext();
  }

  private toggleChoice(): void {
    const question = this.currentQuestion();
    const choice = question.choices[this.choiceCursor];
    if (!choice) return;
    const answer = this.currentAnswer();
    answer.skipped = false;
    if (answer.selectedChoiceIds.includes(choice.id)) {
      answer.selectedChoiceIds = answer.selectedChoiceIds.filter((id) => id !== choice.id);
    } else {
      answer.selectedChoiceIds.push(choice.id);
    }
    this.error = "";
    this.requestRender();
  }

  private isCurrentValid(): boolean {
    const question = this.currentQuestion();
    const answer = this.currentAnswer();
    if (!question.required) return true;
    return answer.selectedChoiceIds.length > 0 || answer.freeText.trim().length > 0;
  }

  private currentQuestion(): InterviewQuestion {
    return this.questions[this.index];
  }

  private currentAnswer(): InterviewAnswer {
    return this.answers[this.index];
  }

  private color(kind: "accent" | "dim" | "error", text: string): string {
    return this.theme?.fg(kind, text) ?? text;
  }

  private requestRender(): void {
    this.onStateChange(this.index);
    this.tui.requestRender?.();
  }
}

function buildAnswerSummary(answers: InterviewAnswer[], questions: InterviewQuestion[]): string {
  return questions.map((question, index) => {
    const answer = answers[index];
    const labels = question.choices.filter((choice) => answer.selectedChoiceIds.includes(choice.id)).map((choice) => choice.label);
    const values = [];
    if (answer.skipped) values.push("건너뜀/모름");
    if (labels.length > 0) values.push(`선택: ${labels.join(", ")}`);
    if (answer.freeText.trim().length > 0) values.push(`입력: ${answer.freeText.trim()}`);
    return `- ${question.title}: ${values.length > 0 ? values.join(" / ") : "미입력"}`;
  }).join("\n");
}

function cloneAnswers(answers: InterviewAnswer[]): InterviewAnswer[] {
  return answers.map((answer) => ({ ...answer, selectedChoiceIds: [...answer.selectedChoiceIds] }));
}

function isPrintable(data: string): boolean {
  if (!data || data.includes("\x1b") || data === "\r" || data === "\n") return false;
  return Array.from(data).every((char) => {
    const code = char.codePointAt(0) ?? 0;
    return code >= 32 && code !== 127;
  });
}
