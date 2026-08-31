import type { MarkdownToken, MarkdownTokens, StenoPlugin } from "@steno/steno";
import { marked } from "marked";

/** The 11 shortcode names this plugin knows how to render. */
export const ALL_SHORTCODES = [
  "alert",
  "audio",
  "crt",
  "emoji",
  "icon",
  "image",
  "mastodon",
  "overflow_auto",
  "video",
  "vimeo",
  "youtube",
] as const;

/** A shortcode name recognized by this plugin. */
export type ShortcodeName = (typeof ALL_SHORTCODES)[number];

/** Whether a shortcode is invoked as `::name{...}` (void) or `:::name{...} ... :::` (block). */
export type ShortcodeKind = "void" | "block";

const VOID_KIND: Record<string, ShortcodeKind> = {
  audio: "void",
  emoji: "void",
  icon: "void",
  image: "void",
  mastodon: "void",
  video: "void",
  vimeo: "void",
  youtube: "void",
  alert: "block",
  crt: "block",
  overflow_auto: "block",
};

/** An attribute value parsed out of a `{key="val" key2=true key3=123}` block. */
export type AttributeValue = string | number | boolean;

/** Parsed `{...}` attribute set for one directive invocation. */
export type Attributes = Record<string, AttributeValue>;

/** Options accepted by this plugin. */
export interface PluginShortcodesOptions {
  /**
   * Restrict recognized directive names to this subset. Defaults to all 11
   * shortcodes in {@link ALL_SHORTCODES}. A directive name outside this
   * list — or one this plugin has never heard of — is left untouched as
   * literal Markdown text rather than erroring, so a stray `:::` in prose
   * never breaks a build.
   */
  enable?: string[];
  /**
   * When `false`, removes `emoji` from the enabled set regardless of
   * `enable` — set this if a site prefers wiring `marked-emoji` in
   * directly instead of using this plugin's hand-rolled emoji shortcode.
   * @default true
   */
  emoji?: boolean;
  /**
   * Resolves an icon name (e.g. `"star"`) to raw SVG markup, mirroring
   * Ametrine's site-override-then-theme-fallback `icons/phosphor/<name>.svg`
   * lookup. This plugin has no filesystem access of its own — a theme or
   * site wires this to a real lookup. When omitted (or when it resolves to
   * `undefined`), the `icon` shortcode — and any other shortcode that
   * embeds an icon, such as `audio` — falls back to an empty
   * `<i class="icon {name}"></i>` with no inlined SVG data.
   */
  iconResolver?: (
    name: string,
  ) => string | undefined | Promise<string | undefined>;
  /**
   * Resolves a custom emoji shortcode (e.g. `"blobcat"`) to an image URL,
   * standing in for Ametrine's live Fediverse `custom_emojis` API lookup
   * (infeasible for a synchronous Markdown transform). When omitted — or
   * when it resolves to `undefined` — `::emoji{name="..."}` falls back to
   * rendering the literal `:name:` text instead of an `<img>`.
   */
  emojiResolver?: (
    name: string,
  ) => string | undefined | Promise<string | undefined>;
  /** Default Fediverse host for `mastodon`/`emoji` when not given as an attribute. */
  fediverseHost?: string;
  /** Default Fediverse user for `mastodon` when not given as an attribute. */
  fediverseUser?: string;
}

/** Fully-resolved, closure-free options passed down to the pure render functions. */
export interface ResolvedShortcodeOptions {
  enabled: Set<string>;
  iconResolver?: (
    name: string,
  ) => string | undefined | Promise<string | undefined>;
  emojiResolver?: (
    name: string,
  ) => string | undefined | Promise<string | undefined>;
  fediverseHost?: string;
  fediverseUser?: string;
}

/** Resolves {@link PluginShortcodesOptions} into the shape the renderers consume. */
export function resolveOptions(
  options: PluginShortcodesOptions = {},
): ResolvedShortcodeOptions {
  const enabled = new Set(options.enable ?? ALL_SHORTCODES);
  if (options.emoji === false) enabled.delete("emoji");
  return {
    enabled,
    iconResolver: options.iconResolver,
    emojiResolver: options.emojiResolver,
    fediverseHost: options.fediverseHost,
    fediverseUser: options.fediverseUser,
  };
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
// Small HTML helpers
// ---------------------------------------------------------------------------

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function str(attrs: Attributes, key: string): string | undefined {
  const value = attrs[key];
  return value === undefined ? undefined : String(value);
}

function bool(attrs: Attributes, key: string): boolean {
  return attrs[key] === true;
}

function classAttr(classes: string[]): string {
  return classes.length > 0 ? ` class="${escapeHtml(classes.join(" "))}"` : "";
}

// ---------------------------------------------------------------------------
// Icon rendering (shared by `icon` and `audio`)
// ---------------------------------------------------------------------------

async function resolveIconSvg(
  name: string,
  options: ResolvedShortcodeOptions,
): Promise<string | undefined> {
  return await options.iconResolver?.(name);
}

async function renderIconElement(
  name: string,
  options: ResolvedShortcodeOptions,
): Promise<string> {
  const svg = await resolveIconSvg(name, options);
  if (!svg) return `<i class="icon ${escapeHtml(name)}"></i>`;
  const dataUrl = `url('data:image/svg+xml,${encodeURIComponent(svg)}');`;
  return `<i class="icon ${escapeHtml(name)}" style="--icon: ${dataUrl}"></i>`;
}

async function renderIcon(
  attrs: Attributes,
  options: ResolvedShortcodeOptions,
): Promise<string> {
  const name = str(attrs, "name");
  if (!name) {
    throw new Error('plugin-shortcodes: icon requires a "name" attribute.');
  }
  const svg = await resolveIconSvg(name, options);
  if (bool(attrs, "raw")) {
    return svg ?? `<i class="icon ${escapeHtml(name)}"></i>`;
  }
  if (bool(attrs, "inline")) {
    return svg
      ? `url('data:image/svg+xml,${encodeURIComponent(svg)}');`
      : `<i class="icon ${escapeHtml(name)}"></i>`;
  }
  return await renderIconElement(name, options);
}

// ---------------------------------------------------------------------------
// Individual shortcode renderers — one per Ametrine template
// ---------------------------------------------------------------------------

const ALERT_PRESETS: Record<
  string,
  { color: string; icon: string; title: string }
> = {
  note: { color: "note", icon: "info", title: "Note" },
  tip: { color: "tip", icon: "lightbulb", title: "Tip" },
  important: { color: "important", icon: "megaphone", title: "Important" },
  warning: { color: "warning", icon: "warning", title: "Warning" },
  danger: { color: "danger", icon: "warning-octagon", title: "Danger" },
};

async function renderAlert(
  attrs: Attributes,
  bodyHtml: string,
  options: ResolvedShortcodeOptions,
): Promise<string> {
  const type = str(attrs, "type");
  const preset = type ? ALERT_PRESETS[type.toLowerCase()] : undefined;
  const color = str(attrs, "color") ?? preset?.color;
  const icon = str(attrs, "icon") ?? preset?.icon;
  const title = str(attrs, "title") ?? preset?.title ?? "";

  const className = color ? `markdown-alert-${color}` : "markdown-alert";
  const svg = icon ? await resolveIconSvg(icon, options) : undefined;
  const iconStyle = svg
    ? ` --alert-icon: url('data:image/svg+xml,${encodeURIComponent(svg)}');`
    : "";

  return (
    `<blockquote class="${escapeHtml(className)}" style="--alert-title: '${
      escapeHtml(title)
    }';${iconStyle}">\n${bodyHtml}\n</blockquote>`
  );
}

function renderAudio(attrs: Attributes, iconHtml: string): string {
  const url = str(attrs, "url") ?? "";
  const name = str(attrs, "name") ?? "";
  return `<button class="audio" data-audio="${escapeHtml(url)}">${
    escapeHtml(name)
  }${iconHtml}</button>`;
}

function renderCrt(attrs: Attributes, rawBody: string): string {
  const fontSize = str(attrs, "font_size");
  const label = str(attrs, "label");
  const style = fontSize ? ` style="font-size: ${escapeHtml(fontSize)};"` : "";
  const labelAttrs = label
    ? ` role="img" aria-label="${escapeHtml(label)}"`
    : ` aria-hidden="true"`;
  const body = rawBody.replace(/^\n+|\n+$/g, "");
  return `<pre class="crt"${style}${labelAttrs}><code aria-hidden="true"><span>${
    escapeHtml(body)
  }</span></code></pre>`;
}

async function renderEmoji(
  attrs: Attributes,
  options: ResolvedShortcodeOptions,
): Promise<string> {
  const name = str(attrs, "name");
  const path = str(attrs, "path");
  if (!name && !path) {
    throw new Error(
      'plugin-shortcodes: emoji requires a "name" or "path" attribute.',
    );
  }
  const big = bool(attrs, "big") ? " big" : "";

  if (path) {
    const title = path.split("/").pop()?.split(".")[0] ?? path;
    return `<img class="emoji${big}" src="${escapeHtml(path)}" title="${
      escapeHtml(title)
    }" width="24" height="24" />`;
  }

  const url = await options.emojiResolver?.(name!);
  if (!url) return `:${escapeHtml(name)}:`;
  return `<img class="emoji${big}" src="${escapeHtml(url)}" title="${
    escapeHtml(name)
  }" width="24" height="24" />`;
}

const IMAGE_FLAG_CLASSES: [string, string][] = [
  ["full", "full"],
  ["has_alpha", "has-alpha"],
  ["start", "start"],
  ["end", "end"],
  ["pixels", "pixels"],
  ["drop_shadow", "drop-shadow"],
  ["no_hover", "no-hover"],
  ["spoiler", "spoiler"],
];

function renderImage(attrs: Attributes): string {
  const url = str(attrs, "url") ?? "";
  const urlMin = str(attrs, "url_min");
  const alt = str(attrs, "alt");

  const classes = IMAGE_FLAG_CLASSES.filter(([key]) => bool(attrs, key)).map((
    [, cls],
  ) => cls);
  if (bool(attrs, "spoiler") && bool(attrs, "solid")) classes.push("solid");

  const img = `<img${classAttr(classes)}${
    alt ? ` alt="${escapeHtml(alt)}"` : ""
  } src="${escapeHtml(urlMin ?? url)}" decoding="async" loading="lazy" />`;

  return urlMin ? `<a href="${escapeHtml(url)}">${img}</a>` : img;
}

function renderMastodon(
  attrs: Attributes,
  options: ResolvedShortcodeOptions,
): string {
  const host = str(attrs, "host") ?? options.fediverseHost;
  const user = str(attrs, "user") ?? options.fediverseUser;
  const id = str(attrs, "id");
  if (!host || !user || !id) {
    throw new Error(
      'plugin-shortcodes: mastodon requires "host", "user" and "id" (host/user may come from plugin options).',
    );
  }
  return `<iframe class="mastodon-embed" src="https://${escapeHtml(host)}/@${
    escapeHtml(user)
  }/${escapeHtml(id)}/embed"></iframe>`;
}

function renderOverflowAuto(attrs: Attributes, bodyHtml: string): string {
  const cls = bool(attrs, "overshoot")
    ? " overshoot"
    : bool(attrs, "overshoot_row")
    ? " overshoot-row"
    : "";
  return `<div class="overflow-auto${cls}">\n${bodyHtml}\n</div>`;
}

const VIDEO_FLAG_CLASSES: [string, string][] = [
  ["full", "full"],
  ["has_alpha", "has-alpha"],
  ["start", "start"],
  ["end", "end"],
  ["pixels", "pixels"],
  ["drop_shadow", "drop-shadow"],
  ["spoiler", "spoiler"],
];

const VIDEO_BOOLEAN_ATTRS = [
  "autoplay",
  "controls",
  "loop",
  "muted",
  "playsinline",
];

function renderVideo(attrs: Attributes): string {
  const url = str(attrs, "url") ?? "";
  const alt = str(attrs, "alt");

  const classes = VIDEO_FLAG_CLASSES.filter(([key]) => bool(attrs, key)).map((
    [, cls],
  ) => cls);
  if (bool(attrs, "spoiler") && bool(attrs, "solid")) classes.push("solid");

  const boolAttrs = VIDEO_BOOLEAN_ATTRS.filter((key) => bool(attrs, key)).join(
    " ",
  );

  return `<video${classAttr(classes)} src="${escapeHtml(url)}"${
    alt ? ` aria-title="${escapeHtml(alt)}"` : ""
  }${boolAttrs ? ` ${boolAttrs}` : ""}></video>`;
}

function renderVimeo(attrs: Attributes): string {
  const id = str(attrs, "id");
  if (!id) {
    throw new Error('plugin-shortcodes: vimeo requires an "id" attribute.');
  }
  const autoplay = bool(attrs, "autoplay") ? "?autoplay=1" : "";
  return `<iframe class="vimeo-embed" src="https://player.vimeo.com/video/${
    escapeHtml(id)
  }${autoplay}" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen></iframe>`;
}

function renderYoutube(attrs: Attributes): string {
  const id = str(attrs, "id");
  if (!id) {
    throw new Error('plugin-shortcodes: youtube requires an "id" attribute.');
  }
  const autoplay = bool(attrs, "autoplay");
  const start = str(attrs, "start");
  let query = "";
  if (autoplay && start) query = `?autoplay=1&start=${escapeHtml(start)}`;
  else if (autoplay) query = "?autoplay=1";
  else if (start) query = `?start=${escapeHtml(start)}`;

  return `<iframe class="youtube-embed" src="https://www.youtube-nocookie.com/embed/${
    escapeHtml(id)
  }${query}" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>`;
}

// ---------------------------------------------------------------------------
// Directive → HTML dispatch
// ---------------------------------------------------------------------------

function requireKind(
  name: string,
  kind: ShortcodeKind,
  given: ShortcodeKind,
): void {
  if (kind !== given) {
    const wantSyntax = kind === "void"
      ? `::${name}{...}`
      : `:::${name}{...} ... :::`;
    const gotSyntax = given === "void"
      ? `::${name}{...}`
      : `:::${name}{...} ... :::`;
    throw new Error(
      `plugin-shortcodes: "${name}" is a ${kind} directive (${wantSyntax}), got ${given} (${gotSyntax}).`,
    );
  }
}

async function renderMarkdownBody(
  body: string,
  options: ResolvedShortcodeOptions,
): Promise<string> {
  const tokens = await transformDirectives(
    marked.lexer(body) as unknown as MarkdownTokens,
    options,
  );
  return marked.parser(
    tokens as unknown as Parameters<typeof marked.parser>[0],
  );
}

/**
 * Renders one directive invocation to HTML, or returns `undefined` when the
 * name is unknown or disabled (the caller should then leave the original
 * Markdown source untouched).
 *
 * @throws {Error} when a known, enabled directive is malformed — used with
 * the wrong kind (void vs. block) or missing a required attribute.
 */
export async function renderDirective(
  name: string,
  kind: ShortcodeKind,
  attrsSource: string,
  body: string | undefined,
  options: ResolvedShortcodeOptions,
): Promise<string | undefined> {
  if (!options.enabled.has(name) || !(name in VOID_KIND)) return undefined;

  requireKind(name, VOID_KIND[name], kind);
  const attrs = parseAttributes(attrsSource);

  switch (name as ShortcodeName) {
    case "alert":
      return await renderAlert(
        attrs,
        await renderMarkdownBody(body ?? "", options),
        options,
      );
    case "audio":
      return renderAudio(
        attrs,
        await renderIconElement("speaker-high", options),
      );
    case "crt":
      return renderCrt(attrs, body ?? "");
    case "emoji":
      return await renderEmoji(attrs, options);
    case "icon":
      return await renderIcon(attrs, options);
    case "image":
      return renderImage(attrs);
    case "mastodon":
      return renderMastodon(attrs, options);
    case "overflow_auto":
      return renderOverflowAuto(
        attrs,
        await renderMarkdownBody(body ?? "", options),
      );
    case "video":
      return renderVideo(attrs);
    case "vimeo":
      return renderVimeo(attrs);
    case "youtube":
      return renderYoutube(attrs);
  }
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
 * `:::name{...} ... :::` (block) shortcode directives, replacing each
 * recognized, enabled one with an `html` token holding its rendered
 * markup. A directive whose name is unknown or excluded via `enable` is
 * left as the original, untouched token(s) — never throws for that case.
 * A block directive's body is re-parsed as nested Markdown (including any
 * directives it itself contains) before rendering.
 */
export async function transformDirectives(
  tokens: MarkdownTokens,
  options: ResolvedShortcodeOptions,
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
          "void",
          voidMatch[2],
          undefined,
          options,
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
          "block",
          openMatch[2],
          body,
          options,
        );
        if (html !== undefined) {
          out.push(htmlToken(html));
        } else {
          for (let k = i; k <= j; k++) out.push(tokens[k]);
        }
        i = j + 1;
        continue;
      }
      // No closing `:::` found anywhere in the rest of the document —
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
 * Creates the plugin-shortcodes plugin: a Zola-shortcode-style directive
 * syntax (`::name{...}` / `:::name{...} ... :::`) for Steno's Markdown
 * pipeline, covering the 11 shortcodes ported from Ametrine's
 * `templates/shortcodes/`.
 *
 * Registered in a site's config.yml:
 *
 * ```yaml
 * plugins:
 *   - package: jsr:@you/plugin-shortcodes
 *     options:
 *       enable: [alert, audio, crt, emoji, icon, image, mastodon, overflow_auto, video, vimeo, youtube]
 * ```
 */
export default function pluginShortcodes(
  options: PluginShortcodesOptions = {},
): StenoPlugin {
  const resolved = resolveOptions(options);

  return {
    name: "plugin-shortcodes",

    async transformAst(tokens) {
      return await transformDirectives(tokens, resolved);
    },
  };
}
