export function inputPath(text) {
  return text.trim().replace(/^(?:go\/|\/)/, '');
}

export function originalURLPath(url) {
  const prefix = 'http://go/';
  if (!url.startsWith(prefix) || url.includes('#')) {
    throw new TypeError('Expected an http://go/ URL without a fragment');
  }
  // URL parsing would normalize the path or re-encode characters. Keep the suffix raw.
  return url.slice(prefix.length);
}

export function escapeXML(text) {
  const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
  return text.replace(/[&<>"']/g, character => entities[character]);
}

export function suggestions(links, text, limit = 5) {
  const query = inputPath(text).toLowerCase();
  return links
    .filter(link => link.short.toLowerCase().includes(query))
    .sort((a, b) => {
      const aName = a.short.toLowerCase();
      const bName = b.short.toLowerCase();
      const prefixOrder = Number(bName.startsWith(query)) - Number(aName.startsWith(query));
      if (prefixOrder) return prefixOrder;
      if (aName !== bName) return aName < bName ? -1 : 1;
      return a.short < b.short ? -1 : a.short > b.short ? 1 : 0;
    })
    .slice(0, Math.max(0, limit))
    .map(link => ({
      content: link.short,
      description: `<match>${escapeXML(link.short)}</match> <url>${escapeXML(link.long)}</url> <dim>${escapeXML(link.owner)}</dim>`,
    }));
}

export function recordFatal(timestamps, now) {
  const recent = timestamps.filter(timestamp => now - timestamp < 60_000);
  recent.push(now);
  return { timestamps: recent, blocked: recent.length >= 2 };
}
