// Hidden document that only clears the clipboard. MV3 service workers can't touch the
// clipboard and offscreen documents never have focus (so navigator.clipboard fails);
// execCommand('copy') with a copy handler is the approach Chrome documents for this.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target !== 'offscreen' || msg.type !== 'clear-clipboard') return;
  if (sender.id !== chrome.runtime.id || sender.tab) return; // only our own service worker
  const onCopy = (e) => {
    e.clipboardData.setData('text/plain', '');
    e.preventDefault();
  };
  const area = document.getElementById('clip');
  area.value = ' ';
  area.select();
  document.addEventListener('copy', onCopy);
  const ok = document.execCommand('copy');
  document.removeEventListener('copy', onCopy);
  sendResponse({ ok });
});
