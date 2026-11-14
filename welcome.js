// Welcome page: explains what Tab Chaperone changes and asks for consent before it does anything.
import { localizePage } from './lib/i18n.js';
import { hasConsent, giveConsent } from './lib/storage.js';

localizePage();

const $ = (id) => document.getElementById(id);

// Shows the button or, once agreed, the confirmation and the way to the settings.
function show(agreed) {
  $('agree').hidden = agreed;
  $('agreed').hidden = !agreed;
  $('open-settings').hidden = !agreed;
}

$('agree').addEventListener('click', async () => {
  await giveConsent();
  show(true);
});
$('open-settings').addEventListener('click', () => chrome.runtime.openOptionsPage());

show(await hasConsent());
