import type { MarkdownToken, MarkdownTokens, StenoPlugin } from "@steno/steno";
import { marked } from "marked";

/** Whether a directive was invoked as `::name{...}` (void) or `:::name{...} ... :::` (block). */
export type DirectiveKind = "void" | "block";

/** An attribute value parsed out of a `{key="val" key2=true key3=123}` block. */
export type AttributeValue = string | number | boolean;

/** Parsed `{...}` attribute set for one directive invocation. */
export type Attributes = Record<string, AttributeValue>;

/** A block directive's body, both as written and pre-rendered to HTML. */
export interface DirectiveBody {
  /** The raw Markdown source between the opening and closing `:::` lines. */
  raw: string;
  /**
   * `raw`, re-lexed and re-rendered as nested Markdown (including any
   * directives it itself contains) before this renderer runs.
   */
  html: string;
}

/**
 * A theme- or site-supplied render function for one directive name. Called
 * with `body` set only for a block invocation (`:::name{...} ... :::`) -
 * a void invocation (`::name{...}`) calls it with no second argument.
 */
export type DirectiveRenderer = (
  attrs: Attributes,
  body?: DirectiveBody,
) => string | Promise<string>;

/** Options accepted by this plugin. */
export interface DirectivesOptions {
  /**
   * Render functions keyed by directive name. A `::name{...}`/`:::name{...}
   * ... :::` invocation whose name has no entry here is left untouched as
   * literal Markdown text rather than erroring, so a stray `:::` in prose
   * never breaks a build - and so a theme can register only the directives
   * it actually uses.
   */
  directives?: Record<string, DirectiveRenderer>;
}

// ---------------------------------------------------------------------------
// Attribute parsing
// ---------------------------------------------------------------------------

const ATTRIBUTE_PATTERN =
  /([a-zA-Z_][\w-]*)\s*=\s*("(?:[^"\\]|\\.)*"|true|false|-?\d+(?:\.\d+)?)/g;

function parseAttributeValue(raw: string): AttributeValue {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw.startsWith('"')) {
    return raw.slice(1, -1).replace(/\\(.)/g, "$1");
  }
  const num = Number(raw);
  return Number.isNaN(num) ? raw : num;
}

/**
 * Parses the contents of a directive's `{...}` attribute block, e.g.
 * `name="star" inline=true count=3`, into a plain object.
 *
 * Supports `key="quoted string"`, `key=true`/`key=false`, `key=123`
 * (number literal), comma- or whitespace-separated (or both).
 */
export function parseAttributes(source: string): Attributes {
  const attrs: Attributes = {};
  for (const match of source.matchAll(ATTRIBUTE_PATTERN)) {
    attrs[match[1]] = parseAttributeValue(match[2]);
  }
  return attrs;
}

// ---------------------------------------------------------------------------
// Small HTML helpers - exported for a theme's own directive renderers to use.
// ---------------------------------------------------------------------------

/** Escapes a value for safe inclusion in HTML text or a quoted attribute. */
export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Reads an attribute as a string, or `undefined` if it wasn't set. */
export function attrString(attrs: Attributes, key: string): string | undefined {
  const value = attrs[key];
  return value === undefined ? undefined : String(value);
}

/** Reads an attribute as a boolean flag (`true` only when the attribute is exactly `true`). */
export function attrBool(attrs: Attributes, key: string): boolean {
  return attrs[key] === true;
}

/** Builds a ` class="..."` fragment (including the leading space), or `""` when `classes` is empty. */
export function classAttr(classes: string[]): string {
  return classes.length > 0 ? ` class="${escapeHtml(classes.join(" "))}"` : "";
}

// ---------------------------------------------------------------------------
// Directive → HTML dispatch
// ---------------------------------------------------------------------------

async function renderMarkdownBody(
  body: string,
  directives: Record<string, DirectiveRenderer>,
): Promise<string> {
  const tokens = await transformDirectives(
    marked.lexer(body) as unknown as MarkdownTokens,
    directives,
  );
  return marked.parser(
    tokens as unknown as Parameters<typeof marked.parser>[0],
  );
}

/**
 * Renders one directive invocation to HTML by dispatching to the matching
 * entry in `directives`, or returns `undefined` when the name has no
 * registered renderer (the caller should then leave the original Markdown
 * source untouched).
 */
export async function renderDirective(
  name: string,
  attrsSource: string,
  body: string | undefined,
  directives: Record<string, DirectiveRenderer>,
): Promise<string | undefined> {
  const renderer = directives[name];
  if (!renderer) return undefined;

  const attrs = parseAttributes(attrsSource);
  if (body === undefined) return await renderer(attrs);

  const html = await renderMarkdownBody(body, directives);
  return await renderer(attrs, { raw: body, html });
}

// ---------------------------------------------------------------------------
// Token-stream scanning
// ---------------------------------------------------------------------------

const VOID_LINE_PATTERN = /^::([a-zA-Z][\w-]*)\{([^}]*)\}\s*$/;
const BLOCK_OPEN_LINE_PATTERN = /^:::([a-zA-Z][\w-]*)\{([^}]*)\}\s*$/;
const BLOCK_CLOSE_LINE_PATTERN = /^:::\s*$/;

function stripTrailingNewlines(source: string): string {
  return source.replace(/\n+$/, "");
}

function rawOf(token: MarkdownToken): string {
  return typeof token.raw === "string" ? token.raw : "";
}

function endsWithCloseLine(source: string): boolean {
  const lines = stripTrailingNewlines(source).split("\n");
  return BLOCK_CLOSE_LINE_PATTERN.test(lines[lines.length - 1].trim());
}

function htmlToken(html: string): MarkdownToken {
  return {
    type: "html",
    raw: html,
    text: html,
    pre: false,
    block: true,
  } as unknown as
    & MarkdownToken
    & { pre: boolean; block: boolean };
}

/**
 * Scans a `marked.lexer()` token list for `::name{...}` (void) and
 * `:::name{...} ... :::` (block) directives, replacing each one whose name
 * has an entry in `directives` with an `html` token holding its rendered
 * markup. A directive with no matching entry is left as the original,
 * untouched token(s) - never throws for that case, so a stray `:::` in
 * prose never breaks a build. A block directive's body is re-parsed as
 * nested Markdown (including any directives it itself contains) before its
 * renderer runs.
 */
export async function transformDirectives(
  tokens: MarkdownTokens,
  directives: Record<string, DirectiveRenderer>,
): Promise<MarkdownTokens> {
  const out: MarkdownToken[] = [];
  let i = 0;

  while (i < tokens.length) {
    const token = tokens[i];
    const raw = rawOf(token);
    const trimmed = stripTrailingNewlines(raw);
    const lines = trimmed.split("\n");

    // Void directive: a single-line token that is exactly `::name{...}`.
    if (lines.length === 1) {
      const voidMatch = VOID_LINE_PATTERN.exec(lines[0].trim());
      if (voidMatch) {
        const html = await renderDirective(
          voidMatch[1],
          voidMatch[2],
          undefined,
          directives,
        );
        out.push(html !== undefined ? htmlToken(html) : token);
        i++;
        continue;
      }
    }

    // Block directive: first line is `:::name{...}`, look for a closing
    // `:::` line in this token or accumulated across following tokens.
    const openMatch = BLOCK_OPEN_LINE_PATTERN.exec(lines[0].trim());
    if (openMatch) {
      let consumed = raw;
      let j = i;
      while (!endsWithCloseLine(consumed) && j + 1 < tokens.length) {
        j++;
        consumed += rawOf(tokens[j]);
      }

      if (endsWithCloseLine(consumed)) {
        const allLines = stripTrailingNewlines(consumed).split("\n");
        const body = allLines.slice(1, -1).join("\n");
        const html = await renderDirective(
          openMatch[1],
          openMatch[2],
          body,
          directives,
        );
        if (html !== undefined) {
          out.push(htmlToken(html));
        } else {
          for (let k = i; k <= j; k++) out.push(tokens[k]);
        }
        i = j + 1;
        continue;
      }
      // No closing `:::` found anywhere in the rest of the document -
      // fall through and keep this token as literal, unmatched text.
    }

    out.push(token);
    i++;
  }

  const result = out as unknown as MarkdownTokens;
  result.links = tokens.links;
  return result;
}

// ---------------------------------------------------------------------------
// Plugin factory
// ---------------------------------------------------------------------------

/**
 * Creates the directives plugin: a `::name{...}` (void) / `:::name{...}
 * ... :::` (block) directive syntax for Steno's Markdown pipeline. This
 * plugin only supplies the parsing/dispatch engine - it ships with zero
 * built-in directives. A theme or site registers its own:
 *
 * ```ts
 * import directives from "jsr:@steno/plugin-directives";
 *
 * const plugin = directives({
 *   directives: {
 *     youtube: (attrs) =>
 *       `<iframe src="https://www.youtube-nocookie.com/embed/${attrs.id}"></iframe>`,
 *     alert: (attrs, body) =>
 *       `<div class="alert alert-${attrs.type}">${body?.html ?? ""}</div>`,
 *   },
 * });
 * ```
 */
export default function directivesPlugin(
  options: DirectivesOptions = {},
): StenoPlugin {
  const directives = options.directives ?? {};

  return {
    name: "directives",

    async transformAst(tokens) {
      return await transformDirectives(tokens, directives);
    },
  };
}
