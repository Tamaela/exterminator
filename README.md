# Exterminator

Exterminator is a Chrome extension. It turns off your other extensions while a sensitive website is open, such as your bank or your tax office. It turns them back on when you leave.

An extension can read everything on the pages it runs on. That includes passwords and form data. Exterminator lets only the extensions you trust run on the sites you choose.

## Features

- You add a protected site from the toolbar icon or the settings page. Subdomains are protected too. Each site has a protection level:

  | Level | Extensions off | When you leave | Examples |
  |---|---|---|---|
  | Login pages only | On pages with a password, code or payment field | Nothing happens. | Forums, social media, shops |
  | Whole site | While any tab of the site is open | You stay logged in. | Webmail, social media with private messages |
  | Strict | While any tab of the site is open | Exterminator clears the cookies, the site data and the clipboard. | Banks, tax offices, health insurers |

  New sites get the level Strict unless you choose another one. "Login pages only" requires automatic protection.
- Extensions on the "Always on" list stay on everywhere. Use it for your password manager. Each site can allow extra extensions. With several protected sites open, an extra extension stays on only if every open site allows it. Newly installed extensions are off by default.
- Automatic protection is optional. It protects any page with a password field. The field may be hidden or inside open or closed Shadow DOM. A second option adds credit card, CVC, 2FA, IBAN and national ID fields. This protection lasts while the tab shows that page. When you go to another page without such a field, the extensions come back after 3 seconds. You can exclude sites from automatic protection.
- The first detection on a site you have not classified shows a notification. The toolbar icon then shows an orange "?". The popup asks which level the site gets. You can also choose "Never protect this site", which needs a second click. Exterminator asks once per site. The question appears only in the popup and the settings page. A web page cannot display or click it.
- Exterminator checks the permissions of every allowed extension. An extension that gains new permissions in an update is removed from the lists until you approve it again.
- Each extension gets a high, medium or low risk label based on its permissions.
- An extension that is turned on during protected mode is turned off again. You get a notification with a button that reloads the protected tabs.
- A separate setting clears the clipboard when you leave any protected site. It is off by default.
- The popup shows the protected sites that are open. Clicking a site switches to its tab.
- The settings page keeps an activity log. The popup warns you when Exterminator has no incognito access.
- The pause button applies to the protected sites that are open when you press it. The pause ends when you leave those sites or open another protected site. It lasts at most one hour.

## Install (developer mode)

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and select this folder.
3. Under **Details**, turn on **Allow in Incognito**. Without it, incognito windows are not protected.

Exterminator requires Chrome 120 or newer.

## How it works

The service worker in `background.js` listens to navigation and tab events. It collects the open tabs, the installed extensions and the stored state. It passes these to the planner in `lib/planner.js`. The planner decides which extensions to turn off or on, which tabs to reload and which sites to clean up. The service worker then carries out that plan.

Turning an extension off does not remove the scripts it already injected into a page. A tab that becomes protected is therefore reloaded if it loaded while those extensions were on.

| Path | Purpose |
|---|---|
| `background.js` | The service worker handles events, applies plans and checks permissions. |
| `detector.js` | This optional content script reports that a page has a sensitive field. It never sends page content. |
| `detector-extended.js` | This file turns on the extra field types. It is injected only when that option is on. |
| `popup.*`, `options.*` | These files make up the toolbar popup and the settings page. |
| `offscreen.*` | This hidden document clears the clipboard. |
| `lib/planner.js` | The planner holds all decision logic. Unit tests cover it. |
| `lib/storage.js` | This module defines storage keys, schema migrations, settings actions and the activity log. |
| `lib/tabs.js` | This module keeps per-tab data: detected fields, protected frames, popups and load times. Unit tests cover it. |
| `lib/levels.js` | This module draws the protection level choices in the popup and the settings page. |
| `lib/domains.js`, `lib/risk.js`, `lib/i18n.js`, `lib/ui.js`, `lib/detection.js` | These modules contain helper functions. |
| `_locales/en/messages.json` | This file contains all text that users see. |

## Permissions

| Permission | Why |
|---|---|
| `management` | Exterminator turns other extensions off and on. |
| `tabs`, `webNavigation` | Exterminator reads which sites are open and reacts before a page loads. |
| `storage`, `alarms` | Exterminator stores settings and state and recovers after a restart. |
| `scripting` and optional website access | Automatic field detection uses these. Chrome asks for website access when you turn detection on. |
| `browsingData` | The level Strict clears cookies and site data. |
| `offscreen`, `clipboardWrite` | Exterminator clears the clipboard from a hidden document. Chrome requires `clipboardWrite` to do that without a click. |
| `notifications` | Exterminator shows permission, intrusion and reload notifications. |

## Known limitations

- Chrome runs no extension code on uninstall. If you remove or disable Exterminator during protected mode, the other extensions stay off.
- Exterminator restarts a navigation into a protected site. A form POST becomes a GET when that happens.
- Web components can attach a shadow root long after the page loaded. Late scans at 1, 3 and 10 seconds find such fields. Focusing the field also triggers detection.
- Protection also turns off protective extensions, such as an ad blocker. A page that loads a protected site in an iframe keeps them off for as long as it stays open. Put extensions you rely on for safety on "Always on".
- Chrome does not let extensions clear incognito data. The activity log records each incognito site that was not cleared. Closing all incognito windows removes that data.
- The level Strict logs you out only of sites you opened as a page. A site that another page embedded in an iframe or prerendered is not logged out.
- Strict clears the site's own domain and the subdomains you visited. Some banks log you in through another domain. That login stays active. Add that domain as a Strict site as well.
- When you leave a Strict site for another protected site, its extensions come back after the logout and the clipboard clearing have run.
- Popups and generated pages (about:blank, blob:) of a protected site are protected. Exterminator cannot reload them. If one was open while other extensions were on, a notification asks you to reopen it.
- Alerts created by version 0.5.0 or older did not record which permissions you saw. "Allow again" is unavailable for them. Review the extension and turn it back on in the lists.
- Apps are turned off like extensions. Themes stay on because they cannot run code.
- Chrome may refuse to shield Exterminator's settings from web pages. Automatic field detection then stays off and a notification tells you. Configured sites stay protected.
- Exterminator installs its own updates after protected mode ends.
- An "Always on" extension has full access to protected pages.
- A protected site inside an iframe turns protection on when the frame starts loading. Exterminator does not reload the frame, because it may be a payment step. If the frame loaded before the extensions were off, a notification offers to reload the page.
- An extension with the `management` permission can turn Exterminator off. Chrome gives an extension no way to block or detect that.
- Without "Allow in Incognito", incognito windows are not protected.

## Development

This section is for people who change the code. Using the extension requires only the steps under "Install". Run the commands below in a terminal, inside the project folder. They need Node.js 22 or newer.

| Command | What it does | When to run it |
|---|---|---|
| `npm install` | It installs jsdom. The detector tests use jsdom to simulate a web page. | Once, before the first test run. |
| `npm test` | It runs the automated tests. They check which extensions go off, how stored settings are migrated, and whether the detector finds sensitive fields. | After every code change. |
| `npm run icons` | It regenerates the icons in `icons/` with Python 3. | When you change the icon design in `tools/make-icons.py`. |
| `npm run package` | It builds `dist/exterminator-<version>.zip`. The zip holds only the files the extension needs. Tests and tools are left out. | When you share the extension or upload it to the Chrome Web Store. |

## License

Exterminator is released under the MIT License. The full text is in `LICENSE`.
