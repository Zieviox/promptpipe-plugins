# promptpipe-plugins

Site plugins for [promptpipe](https://github.com/Zieviox/promptpipe). A site plugin teaches promptpipe how to use one AI chat website: where the message box is, how to send, and where the reply and its thinking appear.

The app installs these with one tap ("Get site plugins"). You can also install a single plugin from its folder link.

## Plugins

| Plugin | Version | Notes |
| --- | --- | --- |
| [DeepSeek](deepseek) | 1.2.0 | Exact selectors, finish detection, DeepThink and Search switches in any page language, source numbers like "-18" stripped. Stops at once when DeepSeek refuses a message ("Content too long") or shows its human check (needs an app built after 2026-11-16). No model name on the page, so none is shown. |
| [Qwen Chat](qwen-chat) | 1.6.6 | Exact selectors only, thinking from the current reply, stops on Qwen's error messages, shows the model name the page shows. |

## Layout

One folder per site, named by plugin id:

```
<id>/
  plugin.json   selectors for each part of the page, settings, version
  site.js       optional: code for things selectors can't do
```

Version numbers only go up. The app's updater keeps the higher number.

`index.json` lists every plugin for the app's "Get site plugins" sheet: `id`, `name`, `path` (its folder), `version` (same as its plugin.json), `default` (ticked for new users) and a one-line `note`. Change it together with the plugin.

## Hashes

`index.json` carries a `sha256` for every plugin. The app checks it when it installs a plugin and refuses files that don't match. The official list must have one for every entry.

Before you commit a plugin change, run:

```
python3 tools/hash.py
```

It rewrites the hashes in `index.json` (and warns if a version differs from the plugin's own `plugin.json`).

## Use at your own risk

Using a chat website through an app may break that site's terms. Don't use an account you can't afford to lose. Use a separate account, or sign in by hand inside the app.

## License

MIT, see [LICENSE](LICENSE).
