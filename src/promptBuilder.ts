/**
 * FIM-style prompt assembly. Pure module, easy to unit-test.
 *
 * `buildPrompt` accepts pre-computed prefix/suffix windows so the caller
 * never has to allocate the full document text twice (once to compute
 * windows, once for the prompt).
 */

export type CompletionMode = 'single-line' | 'multi-line';

export interface BuildPromptInput {
  /** Pre-trimmed prefix window (cursor's preceding context). */
  prefix: string;
  /** Pre-trimmed suffix window (cursor's following context). */
  suffix: string;
  languageId: string;
  /** Display path. Relative if possible; absolute is fine as a fallback. */
  filename: string;
  /** If omitted, inferred from cursor context via detectMode(). */
  mode?: CompletionMode;
}

export interface BuiltPrompt {
  systemPrompt: string;
  userPrompt: string;
  mode: CompletionMode;
  /** Suggested cap; caller may still override via config. */
  suggestedMaxOutputTokens: number;
}

const BASE_RULES =
  'You are a code completion engine. Your output is inserted DIRECTLY into a code editor at the cursor position.\n' +
  'CRITICAL RULES:\n' +
  '1. Output ONLY the literal characters that replace <FILL_HERE>. Nothing else.\n' +
  '2. NEVER wrap your output in backticks. NEVER use markdown code fences (```). NEVER use single backticks around code.\n' +
  '3. NO explanations. NO reasoning. NO "Looking at...", "I need to...", "Let me...", "Based on...", or any meta-commentary.\n' +
  '4. NO comments explaining what you wrote, NO prefixes like "Here is" or "The completion is".\n' +
  '5. The first character you emit must be code that fits at the cursor.\n' +
  '6. Match surrounding indentation and style exactly.\n';

const SINGLE_LINE_RULES =
  BASE_RULES +
  '7. SINGLE-LINE MODE: Complete only the current line. DO NOT emit a newline character. ' +
  'Stop at the end of the current statement or expression. Output at most ~80 characters.\n' +
  'If unsure, emit a short conservative completion. Never emit prose. Never emit backticks.';

const MULTI_LINE_RULES =
  BASE_RULES +
  '7. MULTI-LINE MODE: You may emit multiple lines, but stop at the first natural logical boundary ' +
  '(end of block, end of function body, end of statement group). Be conservative — short focused completions only.\n' +
  'If unsure, emit a short conservative completion. Never emit prose. Never emit backticks.';

const FILL_TOKEN = '<FILL_HERE>';

export function buildPrompt(input: BuildPromptInput): BuiltPrompt {
  const { prefix, suffix, languageId, filename } = input;
  const mode = input.mode ?? detectMode(prefix, suffix);

  const userPrompt =
    `File: ${filename}\n` +
    `Language: ${languageId}\n` +
    `\n` +
    `${prefix}${FILL_TOKEN}${suffix}`;

  return {
    systemPrompt: mode === 'single-line' ? SINGLE_LINE_RULES : MULTI_LINE_RULES,
    userPrompt,
    mode,
    suggestedMaxOutputTokens: mode === 'single-line' ? 48 : 256
  };
}

/**
 * Caller helper: compute prefix/suffix windows from a document and cursor
 * offset, snapped to line boundaries. Allocates two strings (the windows)
 * instead of intermediate full-document slices.
 */
export function computeWindows(
  text: string,
  offset: number,
  maxPrefixChars: number,
  maxSuffixChars: number
): { prefix: string; suffix: string } {
  const safeOffset = Math.max(0, Math.min(offset, text.length));
  // Slice with bounds first — avoids allocating the full prefix/suffix when
  // the document is much larger than our windows.
  const prefStart = Math.max(0, safeOffset - maxPrefixChars * 2);
  const sufEnd = Math.min(text.length, safeOffset + maxSuffixChars * 2);
  const rawPrefix = text.slice(prefStart, safeOffset);
  const rawSuffix = text.slice(safeOffset, sufEnd);
  return {
    prefix: trimToLineBoundary(rawPrefix, maxPrefixChars, 'tail'),
    suffix: trimToLineBoundary(rawSuffix, maxSuffixChars, 'head')
  };
}

/**
 * Decide single-line vs multi-line based on cursor context.
 *
 * Single-line: there is non-whitespace code before the cursor on the current
 * line, AND the line continues with code (not just a closing brace) after.
 * Multi-line: cursor is on an empty/whitespace line, or the prefix ends with
 * a structural opener (`{`, `(`, `[`, `:`, `=>`, `,`) — user is starting a
 * new block or continuing a multi-line construct.
 */
export function detectMode(prefix: string, suffix: string): CompletionMode {
  // Last line of prefix (cursor's current line, before cursor).
  const lastNl = prefix.lastIndexOf('\n');
  const currentLineBefore = lastNl === -1 ? prefix : prefix.slice(lastNl + 1);
  const trimmedBefore = currentLineBefore.trimEnd();

  // First chars of suffix on the same line (after cursor).
  const sufFirstNl = suffix.indexOf('\n');
  const currentLineAfter = sufFirstNl === -1 ? suffix : suffix.slice(0, sufFirstNl);
  const trimmedAfter = currentLineAfter.trim();

  // Empty current line → multi-line (user is on a fresh line in a block).
  if (trimmedBefore === '') return 'multi-line';

  // Prefix ends with a structural opener → expecting body that may span lines.
  if (/[{(\[,:]\s*$/.test(currentLineBefore)) return 'multi-line';
  if (/=>\s*$/.test(currentLineBefore)) return 'multi-line';

  // Cursor mid-line with code on both sides → single-line completion of this line.
  if (trimmedAfter !== '' && !trimmedAfter.startsWith('}') && !trimmedAfter.startsWith(')')) {
    return 'single-line';
  }

  // Cursor at end of a line with code → single-line continuation.
  return 'single-line';
}

/**
 * Trim `s` to roughly `maxChars` characters, snapping the cut point to a line
 * boundary so we never split a half-line. `tail`/`head` selects which end of
 * the string to keep.
 */
export function trimToLineBoundary(s: string, maxChars: number, side: 'tail' | 'head'): string {
  if (maxChars <= 0) return '';
  if (s.length <= maxChars) return s;
  if (side === 'tail') {
    const start = s.length - maxChars;
    const nl = s.indexOf('\n', start);
    return nl === -1 ? s.slice(start) : s.slice(nl + 1);
  } else {
    const slice = s.slice(0, maxChars);
    const nl = slice.lastIndexOf('\n');
    return nl === -1 ? slice : slice.slice(0, nl + 1);
  }
}
