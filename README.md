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
- **Activity log**, incognito warning, pause button. A pause covers only the protected sites open
  when you press it, ends when you leave them or open another protected site, and lasts at most an hour.

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
| `detector-extended.js` | Turns on extended field detection; registered only when that option is on |
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
- Fields inside open and *closed* Shadow DOM are detected (extensions can read both, so the
  detector looks at both). Web components that attach a shadow root long after the page loaded
  are caught by late scans or when you focus the field.
- Protection turns *other* extensions off, including protective ones such as an ad blocker. Put
  extensions you rely on for safety on "Always on", otherwise a page that loads a protected site
  in an iframe can turn them off for as long as it stays open.
- "Log out when leaving" can't clear incognito data (Chrome doesn't allow it); the log says so.
  Closing all incognito windows removes it.
- "Log out when leaving" only applies to sites you opened as a page yourself: a site that was
  only embedded in an iframe or prerendered by another page is never logged out. When you leave
  such a site for another protected site, extensions that site allows come back only after the
  logout (and clipboard clearing) has run.
- Popups and generated pages (about:blank, blob:) of a protected site are protected but can't be
  reloaded; if they were open while other extensions were on, you get a notification to reopen them.
- "Allow again" on an alert created by version 0.5.0 or older is not possible (it doesn't record
  which permissions you saw); review the extension and turn it back on in the lists.
- Apps are turned off like extensions; themes are left alone (they can't run code).
- If Chrome can't keep Exterminator's settings out of reach of web pages, automatic field
  detection stays off and you get a notification; configured sites are still protected.
- An update of Exterminator waits until protected mode is off.
- An "Always on" extension is fully trusted on protected pages.
- A protected site inside an iframe turns protection on as soon as the frame starts loading.
  The frame is not reloaded automatically (it may be a payment step); if it loaded before
  extensions were off, you get a notification with a reload button.
- An extension with the `management` permission could turn Exterminator itself off; Chrome offers
  no way to prevent or detect that from inside the extension.
- Without "Allow in Incognito", protection does not apply in incognito windows.

## Development

```sh
npm install   # jsdom, for the detector tests
npm test      # 51 tests: planner, storage/migrations, domains, risk, i18n, UI helpers, detector
npm run icons # regenerate icons/ (Python 3, no dependencies)
npm run package # dist/exterminator-<version>.zip without dev files
```
