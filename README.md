# promptpipe-plugins

Every plugin of [promptpipe](https://github.com/Zieviox/promptpipe) lives here: the providers (a provider teaches promptpipe how to use one AI chat website: where the message box is, how to send, and where the reply and its thinking appear), the app's core plugins (the chat screen, sending, profiles, chat files, history), and the other built-in ones (Base64, Memory, Sub-chats, Page report, the themes). This is the one source: plugins update from here without a new APK, and each APK build copies the ones marked `"builtin": true` in `index.json` (the app repo's `scripts/copy-plugins.py`).

The app lists them under Plugins › Library ("Get providers", "Get plugins"). You can also install a single plugin from its folder link. Every plugin is a plugin; its `tags` say what else it is (see the app's guide, PLUGINS.md, "Words").

## Plugins

| Plugin | Version | Notes |
| --- | --- | --- |
| [DeepSeek](deepseek) | 2.0.0 | Provider. Exact selectors, finish detection, DeepThink and Search options in any page language, source numbers like "-18" stripped. Stops at once when DeepSeek refuses a message ("Content too long") or shows its human check. No model name on the page, so none is shown. |
| [Qwen Chat](qwen-chat) | 2.0.0 | Provider. Exact selectors only, thinking from the current reply, stops on Qwen's error messages, shows the model name the page shows. |
| [Chat screen](chat-ui) | 3.0.0 | Core plugin: the whole screen. |
| [Profiles](core-profiles) | 2.0.0 | Core plugin: profiles, blocks, templates, the prompt library. |
| Sending, Chat file, History, Local API jobs, Markdown | 2.0.0 | Core plugins (`core-*`). |
| [Base64](base64), [Memory](memory) 3.0.0, [Sub-chats](sub-chats) | 2.0.0 | Plugins that work on your messages and replies (built in). |
| [Page report](page-report) | 2.0.0 | Passive: ⋯ → Copy page report (built in). |
| [Ember](ember), [Paper](paper) | 2.0.0 | Themes (built in). |

Since 2026-11-20 the plugin files use the new words (`tags`, `provider`, `options`, `contentScript`, `toggle`), so these versions need app 0.7.0-alpha47 or newer (`minApp` in `index.json`).

## Layout

One folder per plugin, named by its id. A provider:

```
<id>/
  plugin.json   tags ["provider"], the provider description (selectors, options), settings, version
  content.js    optional: its content script, for things selectors can't do
```

Version numbers only go up. The app's updater keeps the higher number.

`index.json` lists every plugin for the app's Library: `id`, `name`, `tags`, `path` (its folder), `version` (same as its plugin.json), `minApp`, `builtin` (shipped inside the APK), `default` (ticked for new users), a one-line `note` and its `sha256`. Change it together with the plugin.

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
