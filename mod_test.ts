import { assertEquals, assertMatch, assertRejects } from "@std/assert";
import { marked } from "marked";
import createPlugin, {
  type Attributes,
  parseAttributes,
  type ResolvedShortcodeOptions,
  resolveOptions,
  transformDirectives,
} from "./mod.ts";

async function renderMarkdown(
  source: string,
  options: ResolvedShortcodeOptions = resolveOptions(),
): Promise<string> {
  const tokens = await transformDirectives(marked.lexer(source), options);
  return marked.parser(tokens);
}

// ---------------------------------------------------------------------------
// parseAttributes
// ---------------------------------------------------------------------------

Deno.test("parseAttributes: parses a quoted string", () => {
  assertEquals(
    parseAttributes('name="star"'),
    { name: "star" } satisfies Attributes,
  );
});

Deno.test("parseAttributes: parses booleans", () => {
  assertEquals(parseAttributes("inline=true muted=false"), {
    inline: true,
    muted: false,
  });
});

Deno.test("parseAttributes: parses numbers", () => {
  assertEquals(parseAttributes("start=42 ratio=1.5 negative=-3"), {
    start: 42,
    ratio: 1.5,
    negative: -3,
  });
});

Deno.test("parseAttributes: handles a mix, comma- and whitespace-separated", () => {
  assertEquals(
    parseAttributes('id="abc123", autoplay=true, start=10 label="hi there"'),
    { id: "abc123", autoplay: true, start: 10, label: "hi there" },
  );
});

Deno.test("parseAttributes: unescapes backslash escapes inside quoted strings", () => {
  assertEquals(parseAttributes('title="say \\"hi\\""'), { title: 'say "hi"' });
});

Deno.test("parseAttributes: empty source yields no attributes", () => {
  assertEquals(parseAttributes(""), {});
});

// ---------------------------------------------------------------------------
// Directive detection: void vs. block, plugin factory plumbing
// ---------------------------------------------------------------------------

Deno.test("plugin-shortcodes: has a stable name", () => {
  const plugin = createPlugin();
  assertEquals(plugin.name, "plugin-shortcodes");
});

Deno.test("transformAst: returns a proper array", async () => {
  const plugin = createPlugin();
  const tokens = marked.lexer('::icon{name="star"}\n');
  const result = await plugin.transformAst?.(tokens);
  assertEquals(Array.isArray(result), true);
});

Deno.test("transformDirectives: void directive becomes a single html token", async () => {
  const tokens = marked.lexer('::youtube{id="abc"}\n');
  const result = await transformDirectives(tokens, resolveOptions());
  assertEquals(result.length, 1);
  assertEquals(result[0].type, "html");
});

Deno.test("transformDirectives: block directive spanning multiple paragraphs collapses to one html token", async () => {
  const source = `:::alert{type="note"}
First paragraph.

Second paragraph.
:::
`;
  const tokens = marked.lexer(source);
  const result = await transformDirectives(tokens, resolveOptions());
  assertEquals(result.length, 1);
  assertEquals(result[0].type, "html");
});

Deno.test("transformDirectives: unclosed block directive is left as literal, untouched tokens", async () => {
  const source = ':::alert{type="note"}\nno closing fence anywhere\n';
  const tokens = marked.lexer(source);
  const result = await transformDirectives(tokens, resolveOptions());
  // Nothing should have thrown, and no html token should have appeared.
  assertEquals(result.some((t) => t.type === "html"), false);
});

Deno.test("transformDirectives: unknown directive name is left as literal text, never throws", async () => {
  const html = await renderMarkdown('::totally-unknown{foo="bar"}\n');
  assertMatch(html, /totally-unknown/);
});

Deno.test("transformDirectives: a stray ::: in prose does not throw", async () => {
  const html = await renderMarkdown("Just some prose with a lone ::: in it.\n");
  assertMatch(html, /:::/);
});

Deno.test("enable: restricts recognized directives, others fall back to literal text", async () => {
  const options = resolveOptions({ enable: ["youtube"] });
  const html = await renderMarkdown('::vimeo{id="123"}\n', options);
  assertMatch(html, /vimeo/); // left as literal, not rendered as an iframe
  const html2 = await renderMarkdown('::youtube{id="123"}\n', options);
  assertMatch(html2, /<iframe class="youtube-embed"/);
});

Deno.test("emoji option: false disables the emoji directive even if listed in enable", async () => {
  const options = resolveOptions({ enable: ["emoji"], emoji: false });
  const html = await renderMarkdown('::emoji{path="/e/foo.png"}\n', options);
  assertMatch(html, /emoji/); // literal text, not an <img>
  assertEquals(html.includes("<img"), false);
});

Deno.test("mismatched kind throws a descriptive error", async () => {
  await assertRejects(
    () => renderMarkdown('::alert{type="note"}\n'),
    Error,
    "block directive",
  );
});

// ---------------------------------------------------------------------------
// Nested Markdown inside a block directive body
// ---------------------------------------------------------------------------

Deno.test("block directive body is rendered as nested Markdown", async () => {
  const html = await renderMarkdown(`:::alert{type="warning"}
This is **bold** text.
:::
`);
  assertMatch(html, /<strong>bold<\/strong>/);
});

Deno.test("crt body is NOT rendered as markdown (kept as literal preformatted text)", async () => {
  const html = await renderMarkdown(`:::crt{}
some **not bold** ascii art
:::
`);
  assertEquals(html.includes("<strong>"), false);
  assertMatch(html, /some \*\*not bold\*\* ascii art/);
});

// ---------------------------------------------------------------------------
// Per-shortcode HTML shape
// ---------------------------------------------------------------------------

Deno.test("alert: renders a blockquote with markdown-alert class and title", async () => {
  const html = await renderMarkdown(`:::alert{type="warning" title="Careful"}
Body text.
:::
`);
  assertMatch(html, /<blockquote class="markdown-alert-warning"/);
  assertMatch(html, /--alert-title: 'Careful'/);
  assertMatch(html, /Body text\./);
});

Deno.test("alert: uses icon resolver to inline an SVG data URI", async () => {
  const options = resolveOptions({
    iconResolver: (name) => name === "warning" ? "<svg>warn</svg>" : undefined,
  });
  const html = await renderMarkdown(
    `:::alert{type="warning"}
Body.
:::
`,
    options,
  );
  assertMatch(html, /--alert-icon: url\('data:image\/svg\+xml,/);
});

Deno.test("audio: renders a button with data-audio and an icon", async () => {
  const html = await renderMarkdown('::audio{url="/song.mp3" name="Song"}\n');
  assertMatch(
    html,
    /<button class="audio" data-audio="\/song\.mp3">Song<i class="icon speaker-high">/,
  );
});

Deno.test("crt: renders a pre>code>span with aria-hidden when no label", async () => {
  const html = await renderMarkdown(`:::crt{}
ASCII
:::
`);
  assertMatch(
    html,
    /<pre class="crt" aria-hidden="true"><code aria-hidden="true"><span>ASCII<\/span><\/code><\/pre>/,
  );
});

Deno.test("crt: uses role=img and aria-label when label given", async () => {
  const html = await renderMarkdown(`:::crt{label="a cat"}
=^.^=
:::
`);
  assertMatch(html, /role="img" aria-label="a cat"/);
});

Deno.test("emoji: path attribute renders an <img> with derived title", async () => {
  const html = await renderMarkdown(
    '::emoji{path="/emojis/blob.png" big=true}\n',
  );
  assertMatch(
    html,
    /<img class="emoji big" src="\/emojis\/blob\.png" title="blob" width="24" height="24" \/>/,
  );
});

Deno.test("emoji: name without a resolver falls back to literal :name:", async () => {
  const html = await renderMarkdown('::emoji{name="blobcat"}\n');
  assertMatch(html, /:blobcat:/);
});

Deno.test("emoji: name with a resolver renders an <img>", async () => {
  const options = resolveOptions({
    emojiResolver: (name) =>
      name === "blobcat" ? "https://example.com/blobcat.png" : undefined,
  });
  const html = await renderMarkdown('::emoji{name="blobcat"}\n', options);
  assertMatch(
    html,
    /<img class="emoji" src="https:\/\/example\.com\/blobcat\.png" title="blobcat"/,
  );
});

Deno.test("icon: falls back to a bare <i> element with no resolver", async () => {
  const html = await renderMarkdown('::icon{name="star"}\n');
  assertMatch(html, /<i class="icon star"><\/i>/);
});

Deno.test("icon: inlines SVG data via an icon resolver", async () => {
  const options = resolveOptions({
    iconResolver: (name) => `<svg>${name}</svg>`,
  });
  const html = await renderMarkdown('::icon{name="star"}\n', options);
  assertMatch(
    html,
    /<i class="icon star" style="--icon: url\('data:image\/svg\+xml,/,
  );
});

Deno.test("icon: raw=true returns the raw SVG markup from the resolver", async () => {
  const options = resolveOptions({ iconResolver: () => "<svg>raw</svg>" });
  const html = await renderMarkdown('::icon{name="star" raw=true}\n', options);
  assertMatch(html, /<svg>raw<\/svg>/);
});

Deno.test("image: renders a plain <img> with lazy loading", async () => {
  const html = await renderMarkdown('::image{url="/pic.png" alt="A pic"}\n');
  assertMatch(
    html,
    /<img alt="A pic" src="\/pic\.png" decoding="async" loading="lazy" \/>/,
  );
});

Deno.test("image: url_min wraps the <img> in a link to the full url", async () => {
  const html = await renderMarkdown(
    '::image{url="/full.png" url_min="/thumb.png"}\n',
  );
  assertMatch(html, /<a href="\/full\.png"><img src="\/thumb\.png"/);
});

Deno.test("image: boolean flags become CSS classes", async () => {
  const html = await renderMarkdown(
    '::image{url="/pic.png" full=true pixels=true}\n',
  );
  assertMatch(html, /<img class="full pixels"/);
});

Deno.test("mastodon: renders an embed iframe from host/user/id", async () => {
  const html = await renderMarkdown(
    '::mastodon{host="mastodon.social" user="gabs" id="12345"}\n',
  );
  assertMatch(
    html,
    /<iframe class="mastodon-embed" src="https:\/\/mastodon\.social\/@gabs\/12345\/embed"><\/iframe>/,
  );
});

Deno.test("mastodon: falls back to plugin-level fediverseHost/fediverseUser defaults", async () => {
  const options = resolveOptions({
    fediverseHost: "example.social",
    fediverseUser: "gabs",
  });
  const html = await renderMarkdown('::mastodon{id="99"}\n', options);
  assertMatch(html, /https:\/\/example\.social\/@gabs\/99\/embed/);
});

Deno.test("overflow_auto: wraps rendered markdown body in a div", async () => {
  const html = await renderMarkdown(`:::overflow_auto{}
Some *wide* content.
:::
`);
  assertMatch(html, /<div class="overflow-auto">/);
  assertMatch(html, /<em>wide<\/em>/);
});

Deno.test("overflow_auto: overshoot attribute adds a modifier class", async () => {
  const html = await renderMarkdown(`:::overflow_auto{overshoot=true}
x
:::
`);
  assertMatch(html, /<div class="overflow-auto overshoot">/);
});

Deno.test("video: renders a native <video> element with boolean attributes", async () => {
  const html = await renderMarkdown(
    '::video{url="/clip.mp4" autoplay=true muted=true loop=true}\n',
  );
  assertMatch(html, /<video src="\/clip\.mp4" autoplay loop muted><\/video>/);
});

Deno.test("vimeo: renders an embed iframe, autoplay adds a query param", async () => {
  const html = await renderMarkdown('::vimeo{id="76979871" autoplay=true}\n');
  assertMatch(
    html,
    /<iframe class="vimeo-embed" src="https:\/\/player\.vimeo\.com\/video\/76979871\?autoplay=1"/,
  );
});

Deno.test("youtube: renders a nocookie embed iframe with start param", async () => {
  const html = await renderMarkdown('::youtube{id="dQw4w9WgXcQ" start=30}\n');
  assertMatch(
    html,
    /<iframe class="youtube-embed" src="https:\/\/www\.youtube-nocookie\.com\/embed\/dQw4w9WgXcQ\?start=30"/,
  );
});

Deno.test("youtube: combines autoplay and start into one query string", async () => {
  const html = await renderMarkdown(
    '::youtube{id="abc" autoplay=true start=5}\n',
  );
  assertMatch(html, /\/embed\/abc\?autoplay=1&start=5"/);
});

Deno.test("youtube: requires an id attribute", async () => {
  await assertRejects(() => renderMarkdown("::youtube{}\n"), Error, "id");
});
