# Web Digital Human as the SuperAgent UI background

The SuperAgent UI can show **any web page behind its interface** (Appearance → Background → *Web page / Digital Human*). This is where a Web Digital Human runs (Freeze §12.2). The UI stays usable on top of it, and the two talk through a small `postMessage` bridge. A Digital Human can also run standalone. In that case it uses the same data directly from the API (see the last section).

## Setup

1. Serve the Digital Human page anywhere the browser can reach, for example `http://10.8.0.1:8080/avatar` on the DGX over WireGuard.
2. In SuperAgent go to **Appearance → Background → Web page**, enter that URL and choose:
   - **Interactive**: pointer events reach the page wherever the UI is transparent, for example so you can click the avatar.
   - **Allow media**: the page gets `autoplay; microphone; camera`, which it needs for voice.
   - **Allow chat** (off by default): the page may send the human's words to the Chief as chat messages *from the human*. Turn it on only for a page you trust.
3. Adjust blur/dim so the UI stays readable.

The page is loaded in an iframe with `sandbox="allow-scripts allow-forms"`.
- For a cross-origin page, `allow-same-origin` is also granted, so the page keeps its own storage. A different origin still cannot read SuperAgent's.
- A page on the *same* origin never gets `allow-same-origin`, so it cannot reach the UI's token.
- The iframe also gets `referrerpolicy="no-referrer"`.

## Messages: UI → page

The UI posts to the iframe's origin. Every message has the form `{ source: 'superagent', version: 1, type, data }`.

| `type` | `data` | When |
|---|---|---|
| `hello` | `{ project: { id, name } \| null, theme: 'light' \| 'dark', accent: '#rrggbb', allowChat: boolean }` | after the page says `ready`, and whenever the project or theme changes |
| `activity` | `{ projectId, seq, ts, taskId?, tone: 'info' \| 'good' \| 'bad' \| 'attention', text }` | each new plain-language activity line (the same lines as the Activity feed), e.g. "“fix add”: independent checks passed", "Needs your decision (…)", "the Worker shared a file: report.pdf" |
| `chief` | `{ projectId, role: 'human' \| 'chief' \| 'tool' \| 'wake' \| 'error', text }` | each new line of the Chief conversation (text truncated to 300 characters; the full text is in `GET /api/projects/:p/chief/messages`) |

Use `tone: 'attention'` to get the human's attention, e.g. speak "I need your decision on …". Use `good`/`bad` for reactions.

## Messages: page → UI

Messages are accepted only from the embedded iframe's window and origin. Each has the form `{ source: 'superagent-background', type, … }`, with text limited to 2000 characters.

| `type` | Fields | Effect |
|---|---|---|
| `ready` | — | The UI answers with `hello`. |
| `chat` | `text: string` | **Only if "Allow chat" is on:** the UI sends `text` to the Chief of the current project as the human (same as typing it in the Chief tab). The reply comes back as `chief` messages. If chat is off, the message is ignored and the UI shows a notice. |

Minimal page:

```html
<script>
  window.parent.postMessage({ source: 'superagent-background', type: 'ready' }, '*')
  addEventListener('message', e => {
    const m = e.data
    if (m?.source !== 'superagent') return
    if (m.type === 'activity' && m.data.tone === 'attention') speak(m.data.text)
    if (m.type === 'chief' && m.data.role === 'chief') speak(m.data.text)
  })
  // after speech recognition:
  // window.parent.postMessage({ source: 'superagent-background', type: 'chat', text: recognized }, '*')
</script>
```

## Standalone Digital Human (no UI)

The same information is available directly from the API with the human token:

- `GET /api/events/stream?project=<id>&token=…` (SSE):
  - `event: activity` carries the plain-language lines above;
  - `event: superagent` carries raw events, including `chief/message`, `human-gate/opened` and `file/shared`.
- `POST /api/projects/:p/chief/messages {text}` talks to the Chief.
- `POST /api/projects/:p/requests {request}` asks for work: plan + run.
- `POST /api/projects/:p/human-gates/:h {decision}` resolves decisions. This is a human action, so a voice client should confirm explicitly before calling it.
