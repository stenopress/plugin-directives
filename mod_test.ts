import { assertEquals } from "@std/assert";
import type { MarkdownTokens } from "@steno/steno";
import { marked } from "marked";
import directivesPlugin, {
  attrBool,
  attrString,
  classAttr,
  type DirectiveRenderer,
  escapeHtml,
  parseAttributes,
  renderDirective,
  transformDirectives,
} from "./mod.ts";

async function render(
  markdown: string,
  directives: Record<string, DirectiveRenderer>,
): Promise<string> {
  const tokens = marked.lexer(markdown) as unknown as MarkdownTokens;
  const transformed = await transformDirectives(tokens, directives);
  return marked.parser(transformed as unknown as Parameters<typeof marked.parser>[0]);
}

// parseAttributes

Deno.test("parseAttributes: parses quoted strings, booleans, and numbers", () => {
  const attrs = parseAttributes(`name="star" inline=true count=3 ratio=1.5 negative=-2`);
  assertEquals(attrs, {
    name: "star",
    inline: true,
    count: 3,
    ratio: 1.5,
    negative: -2,
  });
});

Deno.test("parseAttributes: unescapes backslash-escaped quotes inside a string", () => {
  const attrs = parseAttributes(String.raw`title="say \"hi\""`);
  assertEquals(attrs.title, `say "hi"`);
});

Deno.test("parseAttributes: comma-separated works the same as whitespace-separated", () => {
  const attrs = parseAttributes(`a="1", b="2",c="3"`);
  assertEquals(attrs, { a: "1", b: "2", c: "3" });
});

Deno.test("parseAttributes: empty source yields an empty object", () => {
  assertEquals(parseAttributes(""), {});
});

// Small HTML helpers

Deno.test("escapeHtml: escapes the five reserved characters", () => {
  assertEquals(
    escapeHtml(`<a href="x">'&'</a>`),
    "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;",
  );
});

Deno.test("escapeHtml: null/undefined render as empty string", () => {
  assertEquals(escapeHtml(null), "");
  assertEquals(escapeHtml(undefined), "");
});

Deno.test("attrString/attrBool: read typed values, undefined/false when absent", () => {
  const attrs = parseAttributes(`name="x" flag=true`);
  assertEquals(attrString(attrs, "name"), "x");
  assertEquals(attrString(attrs, "missing"), undefined);
  assertEquals(attrBool(attrs, "flag"), true);
  assertEquals(attrBool(attrs, "missing"), false);
});

Deno.test("classAttr: builds a class attribute, empty string when no classes", () => {
  assertEquals(classAttr(["a", "b"]), ' class="a b"');
  assertEquals(classAttr([]), "");
});

// Directive dispatch - void

Deno.test("renderDirective: dispatches a void directive with no body arg", async () => {
  let received: unknown;
  const html = await renderDirective("greet", `name="world"`, undefined, {
    greet: (attrs) => ((received = attrs), `<p>hi ${attrs.name}</p>`),
  });
  assertEquals(html, "<p>hi world</p>");
  assertEquals(received, { name: "world" });
});

Deno.test("renderDirective: unregistered name returns undefined", async () => {
  const html = await renderDirective("nope", "", undefined, {});
  assertEquals(html, undefined);
});

Deno.test(
  "transformDirectives: void directive in Markdown renders through the registered renderer",
  async () => {
    const html = await render(`::youtube{id="abc123"}`, {
      youtube: (attrs) =>
        `<iframe src="https://www.youtube-nocookie.com/embed/${attrs.id}"></iframe>`,
    });
    assertEquals(
      html.includes(`<iframe src="https://www.youtube-nocookie.com/embed/abc123"></iframe>`),
      true,
    );
  },
);

Deno.test("transformDirectives: unregistered directive is left as literal text", async () => {
  const html = await render(`::mystery{id="1"}`, {});
  assertEquals(
    html.includes("::mystery{id=&quot;1&quot;}") || html.includes('::mystery{id="1"}'),
    true,
  );
});

// Directive dispatch - block

Deno.test(
  "renderDirective: dispatches a block directive with raw + rendered html body",
  async () => {
    let received: unknown;
    const html = await renderDirective("alert", `type="warning"`, "**bold** text", {
      alert: (attrs, body) => (
        (received = body),
        `<div class="alert-${attrs.type}">${body?.html}</div>`
      ),
    });
    assertEquals(html, `<div class="alert-warning"><p><strong>bold</strong> text</p>\n</div>`);
    assertEquals((received as { raw: string }).raw, "**bold** text");
  },
);

Deno.test("transformDirectives: block directive body renders nested Markdown", async () => {
  const html = await render(
    [':::alert{type="note"}', "", "hello **world**", "", ":::"].join("\n"),
    { alert: (_attrs, body) => `<div>${body?.html}</div>` },
  );
  assertEquals(html.includes("<strong>world</strong>"), true);
});

Deno.test("transformDirectives: block body can span multiple paragraphs/blank lines", async () => {
  const html = await render(
    [":::note{}", "", "first paragraph", "", "second paragraph", "", ":::"].join("\n"),
    { note: (_attrs, body) => `<div class="note">${body?.html}</div>` },
  );
  assertEquals(html.includes("first paragraph"), true);
  assertEquals(html.includes("second paragraph"), true);
});

Deno.test("transformDirectives: nested directives inside a block body both render", async () => {
  const html = await render([":::outer{}", "", '::inner{x="1"}', "", ":::"].join("\n"), {
    outer: (_attrs, body) => `<div class="outer">${body?.html}</div>`,
    inner: (attrs) => `<span class="inner">${attrs.x}</span>`,
  });
  assertEquals(html.includes('<span class="inner">1</span>'), true);
  assertEquals(html.includes('class="outer"'), true);
});

Deno.test(
  "transformDirectives: unclosed block directive is left as literal text, never throws",
  async () => {
    const html = await render([':::alert{type="note"}', "", "no closing fence here"].join("\n"), {
      alert: () => "<div>should not render</div>",
    });
    assertEquals(html.includes("should not render"), false);
  },
);

Deno.test(
  "transformDirectives: unregistered block directive leaves original tokens untouched",
  async () => {
    const html = await render([":::mystery{}", "", "body text", "", ":::"].join("\n"), {});
    assertEquals(html.includes("body text"), true);
  },
);

Deno.test(
  "transformDirectives: a renderer can be used as both void and block depending on the call site",
  async () => {
    const box: DirectiveRenderer = (attrs, body) =>
      body === undefined ? `<box void="${attrs.label}" />` : `<box>${body.html}</box>`;

    const voidHtml = await render(`::box{label="x"}`, { box });
    const blockHtml = await render([":::box{}", "", "content", "", ":::"].join("\n"), { box });

    assertEquals(voidHtml.includes('void="x"'), true);
    assertEquals(blockHtml.includes("<box><p>content</p>"), true);
  },
);

// Plugin factory

Deno.test("directivesPlugin: has a stable name", () => {
  const plugin = directivesPlugin();
  assertEquals(plugin.name, "directives");
});

Deno.test("directivesPlugin: defaults to zero directives (nothing registered)", async () => {
  const plugin = directivesPlugin();
  const tokens = marked.lexer(`::anything{}`) as unknown as MarkdownTokens;
  const result = await plugin.transformAst?.(
    tokens as unknown as Parameters<NonNullable<typeof plugin.transformAst>>[0],
  );
  assertEquals(Array.isArray(result), true);
});

Deno.test("directivesPlugin: transformAst wires registered directives end to end", async () => {
  const plugin = directivesPlugin({
    directives: {
      shout: (attrs) => `<strong>${String(attrs.text).toUpperCase()}</strong>`,
    },
  });
  const tokens = marked.lexer(`::shout{text="hi"}`) as unknown as MarkdownTokens;
  const result = await plugin.transformAst?.(
    tokens as unknown as Parameters<NonNullable<typeof plugin.transformAst>>[0],
  );
  const html = marked.parser(result as unknown as Parameters<typeof marked.parser>[0]);
  assertEquals(html.includes("<strong>HI</strong>"), true);
});
