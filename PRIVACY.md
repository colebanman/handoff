# Handoff data handling

This document describes the source distribution. Deployments and model providers can have additional data-handling practices.

## Stored on your device

The extension uses Chrome local storage and IndexedDB for settings, provider credentials, chats, execution checkpoints, workspace files, memories, skills, automations, and reusable browser helpers. The memory database includes redacted evidence excerpts, source references, dated assertions, and suppression records used to honor forgetting. Data is associated with the installed extension. Credentials in extension storage are not protected by a separate Handoff encryption layer. Claude and ChatGPT subscription tokens are stored locally and refreshed through their respective OAuth services.

The optional bridge stores its local authentication token and daemon metadata under `~/.handoff-bridge/`. `HANDOFF_BRIDGE_HOME` can change that location. Local files are copied into the extension workspace when a caller explicitly attaches or pushes them.

## Sent outside your device

Model requests go to the provider or custom endpoint you configure. Requests can contain your messages, relevant browser content and URLs, screenshots, file content, tool results, and retrieved memory. Subtasks may also make provider requests.

First-run setup can summarize open tabs, browsing history, bookmarks, and recent downloads to create initial memories and suggestions. These summaries may be sent to the configured model service. Browser actions and fetches contact the sites involved in your task.

Automatic memory learning and idle consolidation can send redacted excerpts of saved conversations and completed tool results to a background model, including a backfill of existing chats. Learning and recall are enabled by default and have separate controls in Settings → Memory. Learning uses configured OpenAI access, or the selected gateway/OpenAI-compatible endpoint; its provider can differ from the foreground chat provider. A Claude-only account does not itself enable the OpenAI memory observer. Background requests consume the applicable subscription allowance or API usage. The configurable daily memory budget defaults to 1,000,000 tokens.

The source does not require a Handoff-hosted account or central Handoff server. This does not make third-party model processing local or anonymous.

## Exports and logs

Chat export excludes the settings record, strips large embedded media, and redacts recognizable credential patterns. It includes conversation and browser context plus a saved-memory snapshot when the memory service is available. The memory panel also offers a separate memory export. Names, URLs, document text, unusual credential formats, and other private information can remain. Debug logs can also contain sensitive task details. Inspect and sanitize any export, log, screenshot, or issue attachment before sharing it.

## Your controls

Choose which model provider receives requests. In Settings → Memory, pause learning, disable recall, inspect source references, edit or forget an entry, or forget all saved memories. Forgetting suppresses old supporting evidence so historical backfill cannot simply recreate it; it does not delete the original chats or workspace files. Chat deletion invalidates memory support exclusive to that chat. Edit or remove workspace files through the extension. Disable the local bridge in Settings → Behavior when it is not needed. Use a separate browser profile for testing and clear extension data when you need to remove the local workspace. Deleting local data does not delete copies already sent to a provider or downloaded as exports.
