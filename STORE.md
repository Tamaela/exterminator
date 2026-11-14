# Chrome Web Store submission

This file holds the texts for the Chrome Web Store developer dashboard. Copy each block into the field with the same name.

## Store listing

**Name:** Exterminator

**Summary** (at most 132 characters):

> Turns off your other extensions on sensitive websites, such as your bank, and turns them back on when you leave.

**Category:** Privacy & Security

**Description:**

> Every extension can read the pages it runs on. That includes passwords, account numbers and the forms you fill in. Exterminator turns off your other extensions while a sensitive website is open, such as your bank or your tax office. It turns them back on when you leave.
>
> What Exterminator does:
> - You choose the sites to protect. Each site gets a level. "Login pages only" protects pages with a password, code or payment field. "Whole site" protects the site while a tab of it is open. "Strict" also logs you out when you leave, by clearing the site's cookies and site data and the clipboard.
> - You choose which extensions stay on, such as your password manager. Exterminator checks their permissions. An extension that gains permissions in an update stays off until you approve it again.
> - Optional automatic protection turns extensions off on any page with a password, code or payment field. Chrome asks for access to all websites when you turn it on. The detector only reports that such a field exists.
> - Each extension gets a high, medium or low risk label based on its permissions.
> - You can export your settings and import them in another Chrome profile.
>
> What Exterminator changes on your computer:
> - It turns your other extensions off and on with Chrome's extension management.
> - For Strict sites, it clears that site's cookies and site data, and the clipboard, when you leave.
> - Nothing happens until you agree on the welcome page after installation.
>
> Good to know:
> - If you turn Exterminator off or remove it while a protected site is open, your other extensions stay off. Turn them back on in chrome://extensions.
> - Exterminator sends no data anywhere and has no analytics.
>
> Source code: https://github.com/Tamaela/exterminator

**Screenshots** (1280 × 800): the popup on a login page with the question, the popup on a Strict site, the settings page, and the welcome page. `npm run preview` shows these pages with example data.

## Privacy practices

**Single purpose:**

> Exterminator protects the websites the user chooses from the user's other extensions, by turning those extensions off while such a site is open and back on afterwards.

**Permission justifications:**

| Permission | Justification |
|---|---|
| `management` | Exterminator turns the user's other extensions off while a protected site is open and back on when the user leaves. It reads their permissions to show a risk label and to detect new permissions after an update. |
| `tabs` | Exterminator reads the address of each open tab to know whether a protected site is open. It reloads a protected tab that loaded while other extensions were still on, and switches to a tab from the popup. |
| `webNavigation` | Exterminator reacts before a page of a protected site loads, so other extensions are off before the page runs. It also detects protected sites loaded in frames. |
| `storage` | Exterminator stores the user's settings, its state and an activity log in the browser. |
| `alarms` | Exterminator re-checks after a short grace period and audits permissions of allowed extensions, also after the service worker restarts. |
| `scripting` | With optional automatic protection, Exterminator registers a content script that reports whether a page has a password, code or payment field. |
| `browsingData` | For sites with the level Strict, Exterminator clears that site's cookies and site data when the user leaves, which logs the user out. |
| `offscreen` | Service workers have no clipboard. Exterminator clears the clipboard from an offscreen document when the user leaves a Strict site. |
| `clipboardWrite` | Chrome requires it to clear the clipboard without a click. |
| `notifications` | Exterminator tells the user when an allowed extension gained permissions, when a protected page should be reloaded, and when a detected site waits for a protection level. |
| Host permissions (optional: `http://*/*`, `https://*/*`) | Requested only when the user turns on automatic protection. The content script checks whether a page has a sensitive field and sends only that fact. It reads no page content. |

**Remote code:** No, I am not using remote code.

**Data usage:** Exterminator collects no user data. All data stays in the browser and nothing is transmitted. Leave every data type unchecked. Certify all three statements: no selling of data, no use unrelated to the single purpose, no use for creditworthiness or lending.

**Privacy policy URL:** https://github.com/Tamaela/exterminator/blob/main/PRIVACY.md

## Account

- Publish as an individual. Choose "non-trader" in the trader declaration.
- Contact: the GitHub issues page, https://github.com/Tamaela/exterminator/issues.
- The developer account needs two-step verification and a one-time registration fee.

## Package

Run `npm run package`. Upload `dist/exterminator-<version>.zip`.
