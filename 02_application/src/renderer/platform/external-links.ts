/** Keep approved external links in the system browser, matching Electron. */
const hosts = new Set(["github.com", "paypal.me", "www.donationalerts.com"]);
export function approvedExternalUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && hosts.has(url.hostname)
      ? url.href : null;
  } catch { return null; }
}

export function installExternalLinks(document: Document, open: (url: string) => Promise<unknown>): () => void {
  const onClick = (event: MouseEvent) => {
    if (event.defaultPrevented || event.button !== 0 || !(event.target instanceof Element)) return;
    const anchor = event.target.closest<HTMLAnchorElement>("a[href]");
    const url = anchor && approvedExternalUrl(anchor.href);
    if (!url) return;
    event.preventDefault();
    void open(url).catch((error: unknown) => console.error("Unable to open external link", error));
  };
  document.addEventListener("click", onClick);
  return () => document.removeEventListener("click", onClick);
}
