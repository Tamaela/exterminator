// Hidden document that only clears the clipboard (MV3 service workers can't do this themselves).
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen' || msg.type !== 'clear-clipboard') return;
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
