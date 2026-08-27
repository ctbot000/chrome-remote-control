const params = new URLSearchParams(location.search);
document.getElementById('host').textContent = params.get('host') || 'this site';

document.getElementById('back').addEventListener('click', async () => {
  if (history.length > 1) {
    history.back();
    return;
  }
  // Nothing to go back to (the block hit a fresh tab): close it instead.
  const tab = await chrome.tabs.getCurrent();
  if (tab) chrome.tabs.remove(tab.id);
  else window.close();
});
document.getElementById('settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
