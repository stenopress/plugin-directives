# @steno/plugin-directives

Directive-syntax plugin for [Steno](https://github.com/steno/steno): a `::name{args}` (void) /
`:::name{args} ... :::` (block) Markdown directive engine - the same convention
[`remark-directive`](https://github.com/micromark/micromark-extension-directive) and reStructuredText
directives use. This plugin supplies only the parsing and dispatch engine; it ships with **zero
built-in directives**. A theme or site registers its own render functions for whatever names it
wants to support.

This is for the one capability Steno's own architecture has no other way to provide: an embed -
an alert box, a video, anything - written directly inside a Markdown content file's body. Steno
splits rendering into two separate stages (`marked` compiles Markdown to HTML first, then Tau
templates the page around that already-finished HTML), so a native Tau `<Component>` can never be
invoked from inside a post's Markdown source - Tau never sees that source at all, only the HTML
`marked` already produced. This plugin is the only place in the pipeline that reads the raw
Markdown before that happens.

## Installation

```yaml
# content/.steno/config.yml
plugins:
  - jsr:@steno/plugin-directives
```

## Options

```yaml
plugins:
  - package: jsr:@steno/plugin-directives
    # options.directives is a map of render functions, so it's set from TypeScript
    # (see below), not declared inline in YAML.
```

| Option       | Type                                 | Default | Description                                                                                                                                                                           |
| ------------ | ------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `directives` | `Record<string, DirectiveRenderer>`   | `{}`    | Render functions keyed by directive name. A name with no entry here is left untouched as literal Markdown text rather than erroring, so a stray `:::` in prose never breaks a build. |

A theme or site registers its directives in TypeScript, since a render function isn't expressible in
YAML:

```ts
import directives from "jsr:@steno/plugin-directives";

const plugin = directives({
  directives: {
    youtube: (attrs) =>
      `<iframe src="https://www.youtube-nocookie.com/embed/${attrs.id}"></iframe>`,
    alert: (attrs, body) =>
      `<div class="alert alert-${attrs.type}">${body?.html ?? ""}</div>`,
  },
});
```

## How it works

1. `transformAst` walks `marked`'s token list looking for `::name{...}` (void, self-closing, no
   body) and `:::name{...} ... :::` (block, wraps content). Attribute syntax is `key="value"` /
   `key=true` / `key=123`, comma or whitespace-separated.
2. When `name` has an entry in `directives`, the matched tokens are replaced with a single
   synthetic `html` token containing that renderer's output. A block directive's body is
   recursively re-lexed and re-rendered as nested Markdown before the renderer runs, so nested
   directives and inline emphasis both work - the renderer receives it as `body.html`, alongside
   the unrendered source as `body.raw` in case it wants that instead (verbatim ASCII art, for
   example, where running it through the Markdown parser would mangle `**`/`_` characters that are
   part of the art rather than emphasis markup).
3. When `name` has no entry, the original tokens are left exactly as written, verbatim - a stray
   `:::` in prose, or a directive name a theme hasn't registered yet, never breaks a build.

```markdown
:::alert{type="warning"}
Body content, itself rendered as Markdown.
:::

::youtube{id="dQw4w9WgXcQ"}
```

A single renderer can handle both the void and block form of its own name - it's called with
`body` set only for a block invocation, `undefined` for a void one, and can branch on that if it
wants to support both shapes.

## Helpers for writing a renderer

Small, generic utilities exported alongside the plugin, useful for any `DirectiveRenderer`:

| Export | Signature | Description |
|---|---|---|
| `escapeHtml` | `(value: unknown) => string` | Escapes `&`, `<`, `>`, `"`, `'` for safe inclusion in HTML text or a quoted attribute. |
| `attrString` | `(attrs, key) => string \| undefined` | Reads an attribute as a string. |
| `attrBool` | `(attrs, key) => boolean` | Reads an attribute as a boolean flag. |
| `classAttr` | `(classes: string[]) => string` | Builds a ` class="..."` fragment (including the leading space), or `""` when empty. |
| `parseAttributes` | `(source: string) => Attributes` | The `{...}` attribute parser itself, exported in case a renderer wants to parse attributes from somewhere else. |

## Test

```sh
deno task test
```

## Learn more

- [Steno plugin development guide](https://github.com/stenopress/steno/blob/main/docs/plugins.md)
- [Tau syntax reference](https://github.com/stenopress/steno/blob/main/docs/tau_syntax.md) - Tau's own `<Component>`/`{@children}` syntax, the template-layer counterpart to this plugin's content-layer directives
- [`remark-directive`](https://github.com/micromark/micromark-extension-directive) - the Markdown-ecosystem convention this directive syntax follows

## License

MIT
