# @steno/plugin-shortcodes

Shortcode plugin for [Steno](https://github.com/steno/steno) that ports Zola/Tera-style shortcodes
to Steno's Markdown pipeline: a `:::name{args}` fenced-container directive, parsed via `transformAst`
and rendered to HTML per-shortcode. Ships 11 common shortcodes out of the box, covering the kind of
embeds and callouts most content-heavy themes end up needing.

This is for a site migrating from Zola, or any theme wanting shortcode-style embeds without writing
its own Markdown-token transform. Zola's shortcode system (a template macro called from inside
Markdown, e.g. `{{ youtube(id="...") }}`) has no equivalent in Tau/`marked` - Tau components can't be
invoked from Markdown source, and there's no built-in directive syntax - so this plugin defines one.

## Installation

```yaml
# content/.steno/config.yml
plugins:
  - jsr:@steno/plugin-shortcodes
```

## Options

```yaml
plugins:
  - package: jsr:@steno/plugin-shortcodes
    options:
      enable: [alert, audio, crt, emoji, icon, image, mastodon, overflow_auto, video, vimeo, youtube]
      fediverseHost: example.social
      fediverseUser: someone
```

| Option          | Type                                                                     | Default      | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------- | -------------------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enable`        | `string[]`                                                                | all 11 below | Restrict to a subset; unknown directive names outside this list are left as literal text rather than erroring, so a stray `:::` in prose doesn't break the build.                                                                                                                                                                                                                                                                                            |
| `emoji`         | `boolean`                                                                 | `true`       | When `false`, removes `emoji` from the enabled set even if it's listed in `enable` - set this if a site prefers wiring [`marked-emoji`](https://jsr.io/@lambdalisue/marked-emoji) in directly instead.                                                                                                                                                                                                                                                       |
| `iconResolver`  | `(name: string) => string \| undefined \| Promise<string \| undefined>` | none         | Resolves an icon name to raw SVG markup for the `icon` shortcode and any shortcode that embeds one internally (`audio`'s speaker icon, `alert`'s background icon). This plugin only defines the hook, a theme or site supplies the actual filesystem lookup. Without one, icon output falls back to a bare `<i class="icon {name}"></i>` with no inlined SVG data.                                                                                          |
| `emojiResolver` | `(name: string) => string \| undefined \| Promise<string \| undefined>` | none         | Resolves a custom-emoji shortcode name to an image URL - stands in for a live remote API call, which is infeasible inside a synchronous Markdown transform. Without one, `::emoji{name="..."}` falls back to the literal `:name:` text.                                                                                                                                                                                                                     |
| `fediverseHost` | `string`                                                                  | none         | Default `host` for `mastodon` when the attribute is omitted.                                                                                                                                                                                                                                                                                                                                                                                                  |
| `fediverseUser` | `string`                                                                  | none         | Default `user` for `mastodon` when the attribute is omitted.                                                                                                                                                                                                                                                                                                                                                                                                  |

Since this plugin has no filesystem access of its own, a theme or site wires up `iconResolver` (and
optionally `emojiResolver`) in TypeScript rather than YAML:

```ts
import shortcodes from "jsr:@steno/plugin-shortcodes";

const plugin = shortcodes({
  iconResolver: async (name) => {
    // a theme's own site-override-then-theme-fallback icon lookup
    return (
      await tryReadTextFile(`icons/${name}.svg`) ??
        await tryReadTextFile(`theme/icons/${name}.svg`)
    );
  },
});
```

## How it works

1. `transformAst` walks `marked`'s token list looking for `::name{...}` (void, self-closing, no body,
   mirrors Zola's `{{ shortcode() }}`) and `:::name{...} ... :::` (block, wraps content, mirrors
   Zola's `{% shortcode() %} ... {% end %}`). Attribute syntax is `key="value"` / `key=true` /
   `key=123`, comma or whitespace-separated.
2. A matched directive is replaced with a single synthetic `html` token containing that shortcode's
   rendered output. A block directive's body is recursively re-lexed and re-rendered as nested
   Markdown, so nested directives and inline emphasis both work - except `crt`, whose body is kept
   as literal preformatted text, since running ASCII art through the Markdown parser would mangle
   `**`/`_` characters that are part of the art.
3. An unmatched, unknown, or unclosed directive is left as its original tokens, verbatim - a stray
   `:::` in prose never breaks a build.

```markdown
:::youtube{id="dQw4w9WgXcQ"}
:::

:::alert{type="warning"}
Body content, itself rendered as Markdown.
:::

::icon{name="star" inline=true}
```

### Shortcodes covered

| Name            | Kind  | Notes                                                                                                        |
| --------------- | ----- | ------------------------------------------------------------------------------------------------------------- |
| `alert`         | block | note/tip/important/warning/danger callout (`type="..."` picks a preset; `color`/`icon`/`title` override it)  |
| `audio`         | void  | custom `<button data-audio>` player trigger, with an embedded speaker icon                                   |
| `crt`           | block | CRT-effect wrapper; body is kept as literal preformatted text, not re-parsed as Markdown                     |
| `emoji`         | void  | `path` renders a local image; `name` (custom emoji lookup) needs an `emojiResolver`                          |
| `icon`          | void  | inline icon by name - needs an `iconResolver` for real SVG data                                              |
| `image`         | void  | captioned image; `url`/`url_min` are passed through as-is (no asset resolution)                              |
| `mastodon`      | void  | Fediverse post embed; `host`/`user` fall back to the `fediverseHost`/`fediverseUser` options when omitted    |
| `overflow_auto` | block | horizontal-scroll wrapper                                                                                    |
| `video`         | void  | native `<video>`                                                                                             |
| `vimeo`         | void  | Vimeo embed                                                                                                  |
| `youtube`       | void  | YouTube (nocookie) embed                                                                                     |

### Design notes

- `icon` / `alert`'s icon / `audio`'s speaker icon need real SVG file data. This plugin has no
  filesystem access of its own, so it accepts an `iconResolver` option function instead.
- `emoji{name="..."}` needs a live HTTP call to whatever service hosts the custom emoji, which is
  infeasible inside a synchronous Markdown-token transform, hence `emojiResolver`. `emoji{path="..."}`
  (local image) needs no resolver and works directly.
- `image` passes `url`/`url_min` through unmodified - pair this plugin with `@steno/plugin-image` and
  pass it already-resolved URLs as shortcode attributes if asset processing is needed.

## Test

```sh
deno task test
```

## Learn more

- [Steno plugin development guide](https://github.com/stenopress/steno/blob/main/docs/plugins.md)
- [Tau syntax reference](https://github.com/stenopress/steno/blob/main/docs/tau_syntax.md) - `{@children}` is what a shortcode's *theme-side* wrapper component would use once this plugin hands it rendered HTML
- [Zola shortcodes documentation](https://www.getzola.org/documentation/content/shortcodes/) - the feature set this plugin's directive syntax is modeled on

## License

MIT
