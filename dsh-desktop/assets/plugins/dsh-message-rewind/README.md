# dsh-message-rewind

Trae-style message rewind for the DeepSeek Harness web GUI.

Hover any sent user message → **编辑并回退（Edit & rewind）** → edit the text →
the conversation forks at the previous completed turn and the edited message is
resent there. The original session is kept untouched.

- Client-only implementation against public client-runtime services:
  `sessions.fork/open`, the `conversation.composer.dock` list slot, and the
  composer `inputActions` face (`setDraft` / `addImages` / `submit`).
- The host half (`lib/host.js`) is a no-op.
- The first message of a session cannot be rewound (no completed turn precedes
  it); the button shows an explanatory toast in that case.

MIT License.
