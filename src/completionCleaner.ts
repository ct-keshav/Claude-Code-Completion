/**
 * Strip the common ways the model misbehaves and dedupe text that
 * already exists immediately after the cursor.
 *
 * Pure module.
 */

const FENCE_FULL_RE = /^\s*```[a-zA-Z0-9_+-]*\s*\n?([\s\S]*?)\n?\s*```\s*$/;
const FENCE_OPEN_RE = /^\s*```[a-zA-Z0-9_+-]*[ \t]*\n?/;
const FENCE_CLOSE_RE = /\n?\s*```\s*$/;
const ANY_FENCE_LINE_RE = /^[ \t]*```[a-zA-Z0-9_+-]*[ \t]*$/gm;
const SINGLE_BACKTICK_WRAP_RE = /^`([\s\S]*)`$/;

const NARRATION_PREFIXES = [
  'here is',
  'here\'s',
  'sure',
  'i\'ll',
  'i will',
  'i need',
  'i should',
  'i can',
  'i see',
  'i notice',
  'i\'m',
  'let me',
  'let\'s',
  'looking at',
  'based on',
  'okay',
  'ok,',
  'certainly',
  'of course',
  'the completion',
  'this completes',
  'to complete',
  'analyzing',
  'first,',
  'first ',
  'the user',
  'we need',
  'we should',
  'this code',
  'this function',
  'this should',
  'now '
];

export function looksLikeNarration(head: string): boolean {
  const trimmed = head.trim().toLowerCase();
  if (!trimmed) return false;
  if (trimmed.startsWith('#') && !trimmed.startsWith('#!')) return true; // markdown heading; '#!' shebang is fine
  if (trimmed.startsWith('```') && trimmed.length < 8) return true;
  for (const p of NARRATION_PREFIXES) {
    if (trimmed.startsWith(p)) return true;
  }
  // Heuristic: if the first 30 chars contain a backtick-wrapped identifier
  // followed by English filler, treat as narration. Models love writing
  // "Looking at the `Image` tag, I need to ..." style preambles.
  if (/^[A-Z][a-z]+ (at|the|this|that|for|to|in|on) /.test(head.trim())) {
    return true;
  }
  return false;
}

export interface CleanInput {
  raw: string;
  /** Up to ~200 chars of text immediately after the cursor. Used for dedup. */
  followingText: string;
}

export function cleanCompletion(input: CleanInput): string {
  let text = input.raw;
  if (!text) return '';

  // Fence stripping — only run the regex sweep if the output actually
  // contains a backtick. Most completions don't.
  if (text.indexOf('`') !== -1) {
    const fenceMatch = text.match(FENCE_FULL_RE);
    if (fenceMatch) {
      text = fenceMatch[1];
    } else {
      // Strip a leading or trailing fence (handles partial / unmatched cases
      // from streaming early-exit).
      text = text.replace(FENCE_OPEN_RE, '').replace(FENCE_CLOSE_RE, '');
      // Belt and suspenders: drop any remaining standalone ``` lines that
      // somehow survived (e.g. interleaved with prose).
      text = text.replace(ANY_FENCE_LINE_RE, '');
    }

    // Strip a single-backtick wrap if the model returned `code` as inline code.
    const trimmed = text.trim();
    if (trimmed.length > 1 && trimmed[0] === '`' && trimmed[trimmed.length - 1] === '`') {
      const singleWrap = trimmed.match(SINGLE_BACKTICK_WRAP_RE);
      if (singleWrap && !singleWrap[1].includes('`')) {
        text = singleWrap[1];
      }
    }
  }

  // Strip leading narration line if present.
  const firstNl = text.indexOf('\n');
  const firstLine = firstNl === -1 ? text : text.slice(0, firstNl);
  if (looksLikeNarration(firstLine)) {
    text = firstNl === -1 ? '' : text.slice(firstNl + 1);
  }

  // Strip a leading "<FILL_HERE>" echo if the model parroted it.
  text = text.replace(/^<FILL_HERE>\s*/i, '');

  // Trim trailing whitespace only; leading whitespace may be intentional indent.
  text = text.replace(/[ \t]+$/gm, '').replace(/\n+$/, '\n').replace(/\n$/, '');

  // Suffix-overlap dedup: if the model's output ends with a chunk that
  // already appears immediately after the cursor, drop the overlap so we
  // don't double-insert.
  text = stripSuffixOverlap(text, input.followingText);

  return text;
}

export function stripSuffixOverlap(insertion: string, following: string): string {
  if (!insertion || !following) return insertion;
  const max = Math.min(insertion.length, following.length, 200);
  for (let n = max; n > 0; n--) {
    if (insertion.endsWith(following.slice(0, n))) {
      return insertion.slice(0, insertion.length - n);
    }
  }
  return insertion;
}

/**
 * Heuristic: while streaming, decide whether enough has arrived to early-resolve.
 * We bias toward stopping early — a useful 1-line completion delivered fast
 * beats a 5-line completion delivered slow.
 */
export function looksLikeCompleteUnit(accumulated: string): boolean {
  if (accumulated.length < 4) return false;

  // Two consecutive blank lines = response is winding down.
  if (/\n[ \t]*\n[ \t]*\n/.test(accumulated)) return true;

  // Balanced braces ending with `}` — likely a complete block.
  const opens = countChar(accumulated, '{') + countChar(accumulated, '(') + countChar(accumulated, '[');
  const closes = countChar(accumulated, '}') + countChar(accumulated, ')') + countChar(accumulated, ']');
  if (opens > 0 && closes >= opens && /[\}\)\]];?\s*$/.test(accumulated)) return true;

  // Statement terminator at the end of a line: `;\n` followed by non-indented
  // content (or a blank line) implies the next statement has started — we
  // already have a complete one, stop.
  if (/;\n[^ \t\n]/.test(accumulated)) return true;
  if (/;\n\s*$/.test(accumulated) && accumulated.length > 30) return true;

  // For a single-line completion: if we've already produced a full line
  // (newline) and at least 8 chars on that line, that's usually plenty.
  const firstNl = accumulated.indexOf('\n');
  if (firstNl >= 8 && accumulated.length - firstNl > 1) {
    // We have at least one complete line plus the start of a second.
    // If the second line is empty or all whitespace, stop.
    const rest = accumulated.slice(firstNl + 1);
    if (rest.trim() === '') return true;
  }

  return false;
}

function countChar(s: string, ch: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s[i] === ch) n++;
  return n;
}
