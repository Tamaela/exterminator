# Exterminator

A Chrome extension that turns off your other extensions on sensitive websites — your bank,
tax office, anything you choose — and turns them back on when you leave. Extensions can read
everything on the pages they run on, including passwords and form data; Exterminator makes
sure only the ones you trust are running there.

## Features

- **Protected sites** — add a site from the toolbar icon or the settings. Subdomains count too.
  Protected mode stays active as long as a tab of a protected site is open anywhere.
- **Always on** — extensions (like your password manager) that stay on everywhere. Per site you
  can allow extra extensions; with several protected sites open, only extensions allowed on all
  of them stay on. Newly installed extensions are off by default.
- **Automatic protection** *(optional)* — protect any page with a password field, even hidden
  ones or ones inside (open) Shadow DOM. Optionally also credit card, CVC, 2FA, IBAN and national
  ID fields. With exceptions for sites where you don't want this.
- **Permission monitoring** — if an "Always on" extension gains new permissions in an update, it
  is removed from the list until you re-approve it.
- **Risk labels** — every extension gets a high / medium / low risk label based on its permissions.
- **Intrusion alerts** — an extension turned on during protected mode is turned off again and you
  get a notification offering to reload protected tabs.
- **After leaving** *(optional)* — log out by clearing a site's cookies and data, and clear the clipboard.
- **Activity log**, incognito warning, pause button.

## Install (developer mode)

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and select this folder.
3. Under **Details**, turn on **Allow in Incognito** — otherwise you're unprotected there.

Requires Chrome 120 or newer.

## How it works

The background worker (`background.js`) listens to navigation and tab events, gathers the
current situation and asks the pure planner (`lib/planner.js`) what should happen: which
extensions to turn off or back on, which tabs to reload, what to clean up. It then applies
that plan. Disabling an extension does not remove scripts it already injected into a page,
so a tab that becomes protected is reloaded if it was loaded while those extensions were on.

| Path | Purpose |
|---|---|
| `background.js` | Service worker: events, applying plans, permission monitoring |
| `detector.js` | Optional content script that reports sensitive fields (never page content) |
| `popup.*`, `options.*` | Toolbar popup and settings page |
| `offscreen.*` | Hidden document used only to clear the clipboard |
| `lib/planner.js` | Pure decision logic (fully unit tested) |
| `lib/storage.js` | Storage keys, schema migrations, settings actions, activity log |
| `lib/domains.js`, `lib/risk.js`, `lib/i18n.js`, `lib/ui.js` | Helpers |
| `_locales/en/messages.json` | All user-facing text |

## Permissions

| Permission | Why |
|---|---|
| `management` | Turn other extensions off and on |
| `tabs`, `webNavigation` | Know which sites are open, react before a page loads |
| `storage`, `alarms` | Settings, state and recovery after restarts |
| `scripting` + optional website access | Only for automatic field detection, requested when you turn it on |
| `browsingData` | "Log out when leaving" |
| `offscreen` | Clearing the clipboard |
| `notifications` | Permission and intrusion alerts |

## Known limitations

- Removing or disabling Exterminator while protected mode is active leaves the other
  extensions off (Chrome runs no code on uninstall).
- Restarting a navigation into a protected site turns a form POST into a GET.
- Fields inside *closed* Shadow DOM can't be seen by any extension; web components that attach
  a shadow root long after the page loaded are caught when you focus the field.
- An "Always on" extension is fully trusted on protected pages.

## Development

```sh
npm install   # jsdom, for the detector tests
npm test      # 41 tests: planner, storage/migrations, domains, risk, i18n keys, detector
npm run icons # regenerate icons/ (Python 3, no dependencies)
```
